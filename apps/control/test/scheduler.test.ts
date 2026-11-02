import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runner, silentLogger } from '@mec/runner'
import { FakeRunnerClient, hello, waitFor } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import {
  approvedDelivery,
  type ConfigOverrides,
  createTestApp,
  enrolRunner,
  seedProject,
  type TestApp,
  testConfig,
} from './helpers/app'

let t: TestApp
let s: Awaited<ReturnType<typeof seedProject>>
let url: string
const cleanup: (() => Promise<void>)[] = []

async function setup(scheduling: ConfigOverrides['scheduling'] = {}, background = true) {
  t = await createTestApp({ background, config: { scheduling } })
  s = await seedProject(t)
  url = await t.app.listen({ host: '127.0.0.1', port: 0 })
}
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
  await t.close()
})

async function realRunner(maxAttempts = 4, name = 'runner-1') {
  const creds = await enrolRunner(s.admin, t.app, name)
  const home = await mkdtemp(path.join(tmpdir(), 'mec-runner-'))
  const make = () =>
    new Runner(
      {
        controlUrl: url,
        runnerId: creds.runnerId,
        token: creds.token,
        home,
        maxAttempts,
        heartbeatMs: 200,
        logLevel: 'error',
      },
      silentLogger,
    )
  const r = make()
  await r.start()
  cleanup.push(() => r.stop())
  await waitFor(() => r.connection.ready, 5_000, 'runner ready')
  return { runner: r, creds, home, make }
}

async function fakeRunner(name = 'fake-1') {
  const creds = await enrolRunner(s.admin, t.app, name)
  const c = new FakeRunnerClient(url, creds.runnerId, creds.token)
  await c.connect()
  cleanup.push(() => c.close())
  return c
}

const independent = (n: number, script?: unknown[]) =>
  Array.from({ length: n }, (_, i) => ({
    key: `T${i + 1}`,
    title: `Task ${i + 1}`,
    objective: 'do it',
    acceptanceChecks: ['test'],
    requirementIds: ['R1'],
    ownedPaths: [`src/t${i + 1}`],
    ...(script ? {} : {}),
  }))

const attempts = async (taskId?: string) =>
  taskId
    ? t.db.sql`select * from attempts where task_id = ${taskId} order by number`
    : t.db.sql`select * from attempts order by created_at`
const stateOf = async (attemptId: string) =>
  (await t.db.sql`select state from attempts where id = ${attemptId}`)[0]!.state
const activeCount = async () =>
  (
    (await t.db.sql`
      select count(*)::int as n from attempts
      where state in ('leased','preparing','running','awaiting_input','work_complete','checking','stalled')
    `) as unknown as [{ n: number }]
  )[0].n

describe('scheduler', () => {
  it('dispatches ready tasks up to the global limit, then the rest as slots free up', async () => {
    await setup({ limits: { global: 2, perEmployee: 4, perDelivery: 4, perProfile: 1 } })
    await realRunner(4)
    const { tasks } = await approvedDelivery(s, independent(3))
    let peak = 0
    const sampler = setInterval(async () => {
      peak = Math.max(peak, await activeCount().catch(() => 0))
    }, 25)
    cleanup.push(async () => clearInterval(sampler))

    await waitFor(async () => (await attempts()).length >= 2, 5_000, 'two dispatched')
    const held = await waitFor(async () => {
      const [x] = await t.db.sql`select blocker from tasks where state = 'ready'`
      return x?.blocker as { kind: string; detail: string } | undefined
    })
    expect(held).toMatchObject({ kind: 'capacity', detail: 'Waiting: global limit of 2 active attempts' })

    for (const task of Object.values(tasks)) {
      await waitFor(
        async () =>
          (await t.db.sql`select state from tasks where id = ${task.id}`)[0]!.state === 'awaiting_review',
        15_000,
        `${task.key} done`,
      )
    }
    clearInterval(sampler)
    expect(peak).toBeLessThanOrEqual(2)
    expect(await attempts()).toHaveLength(3)
  })

  it('dispatches nothing for a paused project until it resumes', async () => {
    await setup()
    await realRunner()
    await s.admin.post(`/api/projects/${s.project.id}/pause`, { paused: true })
    const { tasks } = await approvedDelivery(s, independent(1))
    await new Promise((r) => setTimeout(r, 500))
    expect(await attempts()).toHaveLength(0)
    await s.admin.post(`/api/projects/${s.project.id}/pause`, { paused: false })
    await waitFor(async () => (await attempts(tasks.T1!.id)).length === 1, 5_000, 'dispatched after resume')
  })

  it('concurrent duplicate dispatches create exactly one attempt', async () => {
    await setup({}, false)
    const runner = await fakeRunner()
    const { tasks } = await approvedDelivery(s, independent(1))
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId: runner.runnerId }),
      ),
    )
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 201])
    expect(new Set(results.map((r) => r.json().attempt.id)).size).toBe(1)
    expect(await attempts(tasks.T1!.id)).toHaveLength(1)
  })
})

describe('leases and reconciliation', () => {
  it('stalls an attempt whose runner goes silent, then reconciles it when the runner returns', async () => {
    await setup({ leaseTtlMs: 1_000 }, false)
    const runner = await fakeRunner()
    const { tasks } = await approvedDelivery(s, independent(1))
    const { attempt } = (
      await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId: runner.runnerId })
    ).json()
    await runner.emit(runner.envelope(attempt.id, 1, 'attempt.preparing'))
    await runner.emit(runner.envelope(attempt.id, 1, 'attempt.started'))

    // No heartbeats: the lease expires and the attempt is quarantined, not replaced.
    await waitFor(
      async () => {
        await t.app.services.reconciler.tick()
        return (await stateOf(attempt.id)) === 'stalled'
      },
      5_000,
      'stalled',
    )
    const [task] = await t.db.sql`select state, blocker from tasks where id = ${tasks.T1!.id}`
    expect(task).toMatchObject({ state: 'active', blocker: { kind: 'infrastructure' } })
    expect(await attempts(tasks.T1!.id)).toHaveLength(1)

    // The runner comes back reporting the process alive with the same generation.
    await runner.close()
    await runner.connect(
      hello({ attempts: [{ attemptId: attempt.id, generation: 1, process: 'live', lastSequence: 1 }] }),
    )
    expect(runner.welcome?.acked[attempt.id]).toBe(1)
    expect(await stateOf(attempt.id)).toBe('running')
    for (const type of ['attempt.finished', 'attempt.checks_started'])
      await runner.emit(runner.envelope(attempt.id, 1, type))
    await runner.emit(runner.envelope(attempt.id, 1, 'attempt.checks_completed', { passed: true }))
    expect(await stateOf(attempt.id)).toBe('succeeded')
  })

  it('releases an attempt whose start command never reached the runner', async () => {
    await setup({ leaseTtlMs: 1_000 }, false)
    const runner = await fakeRunner()
    const { tasks } = await approvedDelivery(s, independent(1))
    await runner.close()
    // Claim while it is still registered as connected for a moment is racy; claim directly instead.
    await t.db.sql`update runners set status = 'online' where id = ${runner.runnerId}`
    const { claimAttempt } = await import('../src/features/attempts/service')
    const { attempt } = await t.db.sql.begin((tx) =>
      claimAttempt(tx, {
        taskId: tasks.T1!.id,
        runnerId: runner.runnerId,
        agentKind: 'fake',
        inputs: {},
        actor: { kind: 'system' },
        leaseMs: 1_000,
      }),
    )
    await waitFor(
      async () => {
        await t.app.services.reconciler.tick()
        return (await stateOf(attempt.id)) === 'cancelled'
      },
      5_000,
      'released',
    )
    const [task] = await t.db.sql`select state, attempts_used from tasks where id = ${tasks.T1!.id}`
    expect(task).toMatchObject({ state: 'ready', attemptsUsed: 0 })
    await runner.connect()
    await new Promise((r) => setTimeout(r, 300))
    expect(runner.commands.filter((c) => c.attemptId === attempt.id)).toEqual([])
  })

  it('fences the old generation after a resume', async () => {
    await setup({}, false)
    const runner = await fakeRunner()
    const { tasks } = await approvedDelivery(s, independent(1))
    const { attempt } = (
      await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId: runner.runnerId })
    ).json()
    for (const type of ['attempt.preparing', 'attempt.started', 'attempt.interrupted']) {
      await runner.emit(runner.envelope(attempt.id, 1, type))
    }
    expect(await stateOf(attempt.id)).toBe('interrupted')

    const res = await s.admin.post(`/api/attempts/${attempt.id}/resume`)
    expect(res.statusCode).toBe(200)
    expect(res.json().attempt).toMatchObject({ state: 'leased', generation: 2 })
    const resume = await waitFor(() => runner.commands.find((c) => c.type === 'resume'))
    expect(resume).toMatchObject({ generation: 2, commandId: `${attempt.id}:g2:resume` })

    await runner.emit(runner.envelope(attempt.id, 1, 'attempt.finished'))
    expect(await stateOf(attempt.id)).toBe('leased')
    await runner.emit(runner.envelope(attempt.id, 2, 'attempt.preparing'))
    expect(await stateOf(attempt.id)).toBe('preparing')
  })

  it('replaces an older connection for the same runner', async () => {
    await setup({}, false)
    const first = await fakeRunner()
    const second = new FakeRunnerClient(url, first.runnerId, first.token)
    await second.connect()
    cleanup.push(() => second.close())
    expect(await waitFor(() => first.closeCode)).toBe(4000)
  })

  it('lets an operator confirm a stalled attempt stopped, then the task can start fresh', async () => {
    await setup({ leaseTtlMs: 1_000 }, false)
    const runner = await fakeRunner()
    const { tasks } = await approvedDelivery(s, independent(1))
    const { attempt } = (
      await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId: runner.runnerId })
    ).json()
    await runner.emit(runner.envelope(attempt.id, 1, 'attempt.preparing'))
    await waitFor(
      async () => {
        await t.app.services.reconciler.tick()
        return (await stateOf(attempt.id)) === 'stalled'
      },
      5_000,
      'stalled',
    )
    expect((await s.member.post(`/api/attempts/${attempt.id}/confirm-stopped`)).statusCode).toBe(403)
    expect((await s.admin.post(`/api/attempts/${attempt.id}/confirm-stopped`)).statusCode).toBe(200)
    expect(await stateOf(attempt.id)).toBe('interrupted')
    expect((await s.admin.post(`/api/attempts/${attempt.id}/abandon`)).statusCode).toBe(200)
    const [task] = await t.db.sql`select state from tasks where id = ${tasks.T1!.id}`
    expect(task!.state).toBe('ready')
  })
})

describe('recovery with the real runner', () => {
  it('a control restart loses no work and starts nothing twice', async () => {
    await setup({}, false)
    const { runner } = await realRunner()
    const { tasks } = await approvedDelivery(s, independent(1))
    const script = Array.from({ length: 10 }, (_, i) => [{ say: `step ${i}` }, { sleepMs: 150 }]).flat()
    const { attempt } = (
      await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId: runner.config.runnerId, script })
    ).json()
    await waitFor(async () => (await stateOf(attempt.id)) === 'running', 5_000, 'running')

    // Control goes down while the agent keeps working and journalling.
    const port = Number(new URL(url).port)
    await t.app.close()
    await new Promise((r) => setTimeout(r, 800))
    const config = testConfig({ databaseUrl: t.db.url, scheduling: { tickMs: 100, reconcileTickMs: 100 } })
    const app2 = await buildApp({
      sql: t.db.sql,
      bus: t.bus,
      config,
      github: null,
      webDistDir: null,
      background: true,
    })
    await app2.listen({ host: '127.0.0.1', port })
    t.app = app2

    await waitFor(async () => (await stateOf(attempt.id)) === 'succeeded', 15_000, 'succeeded after restart')
    expect(await attempts(tasks.T1!.id)).toHaveLength(1)
    const seqs = (
      await t.db
        .sql`select source_sequence from events where attempt_id = ${attempt.id} and source_sequence is not null order by source_sequence`
    ).map((r) => r.sourceSequence as number)
    expect(seqs.every((x, i) => x === i)).toBe(true)
  })

  it('resumes an interrupted attempt from its checkpoint under a new generation', async () => {
    await setup({}, false)
    const { runner } = await realRunner()
    const { tasks } = await approvedDelivery(s, independent(1))
    const script = [{ say: 'one' }, { sleepMs: 400 }, { say: 'two' }, { sleepMs: 2_000 }, { say: 'three' }]
    const { attempt } = (
      await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId: runner.config.runnerId, script })
    ).json()
    await waitFor(
      async () => {
        const m = await t.db
          .sql`select 1 from events where attempt_id = ${attempt.id} and payload->>'text' = 'two'`
        return m.length > 0
      },
      5_000,
      'reached step two',
    )
    await s.admin.post(`/api/attempts/${attempt.id}/interrupt`)
    await waitFor(async () => (await stateOf(attempt.id)) === 'interrupted', 5_000, 'interrupted')

    expect((await s.admin.post(`/api/attempts/${attempt.id}/resume`)).statusCode).toBe(200)
    await waitFor(async () => (await stateOf(attempt.id)) === 'succeeded', 10_000, 'succeeded after resume')
    const said = (
      await t.db
        .sql`select payload->>'text' as text from events where attempt_id = ${attempt.id} and type = 'agent.message' order by id`
    ).map((r) => r.text)
    expect(said).toEqual(['one', 'two', 'three'])
    const [row] = await t.db.sql`select generation from attempts where id = ${attempt.id}`
    expect(row!.generation).toBe(2)
  })

  it('a fleet stop interrupts everything, reports acknowledgements and pauses dispatch', async () => {
    await setup({ limits: { global: 4, perEmployee: 4, perDelivery: 4, perProfile: 1 } }, false)
    const { runner } = await realRunner(4)
    const { tasks } = await approvedDelivery(s, independent(2))
    const long = [{ say: 'busy' }, { sleepMs: 30_000 }]
    const ids: string[] = []
    for (const task of Object.values(tasks)) {
      const res = await s.admin.post(`/api/tasks/${task.id}/attempts`, {
        runnerId: runner.config.runnerId,
        script: long,
      })
      ids.push(res.json().attempt.id)
    }
    await waitFor(
      async () => (await Promise.all(ids.map(stateOf))).every((x) => x === 'running'),
      5_000,
      'both running',
    )

    const stop = (await s.admin.post('/api/fleet/stop', { reason: 'maintenance' })).json()
    expect(stop.summary).toMatchObject({ total: 2 })
    const done = await waitFor(
      async () => {
        const status = (await s.admin.get('/api/fleet/status')).json()
        return status.latestStop.summary.stopped === 2 ? status : null
      },
      10_000,
      'all stopped',
    )
    expect(done.dispatchPaused).toBe(true)
    expect(done.latestStop.attempts.every((a: { acknowledged: boolean }) => a.acknowledged)).toBe(true)
    expect((await Promise.all(ids.map(stateOf))).every((x) => x === 'interrupted')).toBe(true)

    // Paused dispatch: neither the scheduler nor a manual start launches anything.
    const more = await approvedDelivery(s, independent(1))
    await t.app.services.scheduler.tick()
    expect(await attempts(more.tasks.T1!.id)).toHaveLength(0)
    const manual = await s.admin.post(`/api/tasks/${more.tasks.T1!.id}/attempts`, {
      runnerId: runner.config.runnerId,
    })
    expect(manual.json().error).toBe('dispatch_paused')

    await s.admin.post('/api/fleet/resume')
    await t.app.services.scheduler.tick()
    await waitFor(async () => (await attempts(more.tasks.T1!.id)).length === 1, 5_000, 'dispatch resumed')
  })
})
