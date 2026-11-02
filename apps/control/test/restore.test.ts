import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runner, silentLogger } from '@mec/runner'
import { waitFor } from '@mec/testkit'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { createSql, type Sql } from '../src/db/sql'
import { EventBus } from '../src/events/bus'
import { approvedDelivery, createTestApp, enrolRunner, seedProject, testConfig } from './helpers/app'

/**
 * Restore drill (PDF §26, §34): a control plane restored from an older backup reconciles existing
 * runners without duplicating active work.
 */
describe('restore drill', () => {
  it('replays what the backup missed, stops attempts it never recorded, and starts each task once', async () => {
    const t = await createTestApp()
    const s = await seedProject(t)
    const url = await t.app.listen({ host: '127.0.0.1', port: 0 })
    const port = Number(new URL(url).port)
    const original = new URL(t.db.url).pathname.slice(1)
    const admin = postgres(process.env.MEC_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} })
    const snapshot = `mec_snap_${randomBytes(4).toString('hex')}`
    const creds = await enrolRunner(s.admin, t.app)
    const runner = new Runner(
      {
        controlUrl: url,
        runnerId: creds.runnerId,
        token: creds.token,
        home: await mkdtemp(path.join(tmpdir(), 'mec-runner-')),
        maxAttempts: 3,
        heartbeatMs: 200,
        logLevel: 'error',
      },
      silentLogger,
    )
    await runner.start()
    await waitFor(() => runner.connection.ready, 5_000)

    const open: { app: FastifyInstance; bus: EventBus; sql: Sql }[] = []
    const startControl = async (dbName: string, background: boolean) => {
      const dbUrl = new URL(t.db.url)
      dbUrl.pathname = `/${dbName}`
      const sql = createSql(dbUrl.toString())
      const bus = new EventBus(sql)
      await bus.start()
      const config = testConfig({
        databaseUrl: dbUrl.toString(),
        scheduling: { tickMs: 100, reconcileTickMs: 100 },
      })
      const app = await buildApp({ sql, bus, config, github: null, webDistDir: null, background })
      await app.listen({ host: '127.0.0.1', port })
      open.push({ app, bus, sql })
      return { app, sql }
    }
    const stopControl = async () => {
      const c = open.pop()!
      await c.app.close()
      await c.bus.stop()
      await c.sql.end()
    }

    try {
      const { tasks } = await approvedDelivery(s, [
        {
          key: 'T1',
          title: 'one',
          objective: 'x',
          acceptanceChecks: ['test'],
          requirementIds: ['R1'],
          ownedPaths: ['a'],
        },
        {
          key: 'T2',
          title: 'two',
          objective: 'y',
          acceptanceChecks: ['test'],
          requirementIds: ['R2'],
          ownedPaths: ['b'],
        },
      ])
      const slow = Array.from({ length: 12 }, (_, i) => [{ say: `step ${i}` }, { sleepMs: 250 }]).flat()
      const a1 = (
        await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId: creds.runnerId, script: slow })
      ).json().attempt.id as string
      const seq = async (sql: Sql, id: string) =>
        ((await sql`select last_sequence from attempts where id = ${id}`)[0]?.lastSequence as number) ?? -1
      await waitFor(async () => (await seq(t.db.sql, a1)) >= 4, 10_000, 'A1 under way')

      // Backup: control stops, the database is copied as it stands.
      await t.app.close()
      await t.bus.stop()
      await t.db.sql.end()
      await admin.unsafe(`create database ${snapshot} template ${original}`)
      const backupSeq = await (async () => {
        const c = createSql(t.db.url.replace(original, snapshot))
        const v = await seq(c, a1)
        await c.end()
        return v
      })()

      // Work continues on the original after the backup: A1 progresses and A2 starts for T2.
      const live = await startControl(original, false)
      await waitFor(() => runner.connection.ready, 10_000, 'runner back')
      const a2res = await live.app.inject({
        method: 'POST',
        url: `/api/tasks/${tasks.T2!.id}/attempts`,
        headers: { cookie: s.admin.cookie },
        payload: { runnerId: creds.runnerId, script: [{ say: 'long work' }, { sleepMs: 60_000 }] },
      })
      const a2 = a2res.json().attempt.id as string
      await waitFor(() => runner.supervisor.isLive({ attemptId: a2, generation: 1 }), 10_000, 'A2 running')
      await waitFor(async () => (await seq(live.sql, a1)) > backupSeq + 4, 10_000, 'A1 beyond the backup')
      await stopControl()

      // Restore the older snapshot, with dispatch paused as the runbook prescribes.
      const restoredUrl = t.db.url.replace(original, snapshot)
      const pre = createSql(restoredUrl)
      await pre`insert into settings (key, value) values ('dispatch', ${pre.json({ dispatchPaused: true } as never)})`
      await pre.end()
      const restored = await startControl(snapshot, true)

      // A2 is unknown to the restored database: the runner is told to stop it; its work is kept.
      await waitFor(() => !runner.supervisor.isLive({ attemptId: a2, generation: 1 }), 15_000, 'A2 stopped')
      const unknown = await restored.sql`select payload from events where type = 'runner.unknown_attempt'`
      expect(unknown.map((u) => (u.payload as { attemptId: string }).attemptId)).toContain(a2)

      // A1's events after the backup are replayed from the runner journal: no gaps, no duplicates.
      await waitFor(
        async () =>
          (await restored.sql`select state from attempts where id = ${a1}`)[0]!.state === 'succeeded',
        20_000,
        'A1 converged',
      )
      const seqs = (
        await restored.sql`select source_sequence from events where attempt_id = ${a1} and source_sequence is not null order by source_sequence`
      ).map((r) => r.sourceSequence as number)
      expect(seqs.every((x, i) => x === i)).toBe(true)

      // T2 is ready again in the restored world; it starts exactly once when dispatch resumes.
      expect((await restored.sql`select state from tasks where id = ${tasks.T2!.id}`)[0]!.state).toBe('ready')
      await restored.sql`update settings set value = ${restored.sql.json({ dispatchPaused: false } as never)} where key = 'dispatch'`
      await waitFor(
        async () =>
          (await restored.sql`select id from attempts where task_id = ${tasks.T2!.id}`).length === 1,
        10_000,
        'T2 restarted',
      )
      const [fresh] = await restored.sql`select id from attempts where task_id = ${tasks.T2!.id}`
      expect(fresh!.id).not.toBe(a2)
    } finally {
      await runner.stop()
      while (open.length) await stopControl()
      await admin.unsafe(`drop database if exists ${snapshot} with (force)`)
      await admin.unsafe(`drop database if exists ${original} with (force)`)
      await admin.end()
    }
  }, 120_000)
})
