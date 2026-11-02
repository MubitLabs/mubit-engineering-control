import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runner, silentLogger } from '@mec/runner'
import { waitFor } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvedDelivery, createTestApp, enrolRunner, seedProject, type TestApp } from './helpers/app'

let t: TestApp
let s: Awaited<ReturnType<typeof seedProject>>
let url: string
let home: string
let creds: { runnerId: string; token: string }
const runners: Runner[] = []

beforeEach(async () => {
  t = await createTestApp()
  s = await seedProject(t)
  url = await t.app.listen({ host: '127.0.0.1', port: 0 })
  home = await mkdtemp(path.join(tmpdir(), 'mec-runner-'))
  creds = await enrolRunner(s.admin, t.app)
})
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop()
  await t.close()
})

async function startRunner() {
  const r = new Runner(
    {
      controlUrl: url,
      runnerId: creds.runnerId,
      token: creds.token,
      home,
      maxAttempts: 2,
      heartbeatMs: 300,
      logLevel: 'error',
    },
    silentLogger,
  )
  runners.push(r)
  await r.start()
  await waitFor(() => r.connection.ready, 5_000, 'runner connected')
  return r
}

async function start(script: unknown[]) {
  const { tasks } = await approvedDelivery(s)
  const res = await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId: creds.runnerId, script })
  expect(res.statusCode).toBe(201)
  return { taskId: tasks.T1!.id, attemptId: res.json().attempt.id as string }
}

const state = async (attemptId: string) =>
  (await t.db.sql`select state from attempts where id = ${attemptId}`)[0]!.state

/** Every runner event for the attempt, by source sequence: must be 0..n with no repeats. */
async function sequences(attemptId: string): Promise<number[]> {
  const rows = await t.db.sql`
    select source_sequence from events where attempt_id = ${attemptId} and source_sequence is not null
    order by source_sequence
  `
  return rows.map((r) => r.sourceSequence as number)
}
const contiguous = (xs: number[]) => xs.every((x, i) => x === i)

describe('runner end to end with the fake agent', () => {
  it('runs an attempt to success and streams its events', async () => {
    await startRunner()
    const { taskId, attemptId } = await start([
      { say: 'hello' },
      { write: { path: 'out/result.txt', content: 'ok' } },
      { say: 'done' },
    ])
    await waitFor(async () => (await state(attemptId)) === 'succeeded', 10_000, 'attempt succeeded')
    const types = (await t.db.sql`select type from events where attempt_id = ${attemptId} order by id`).map(
      (r) => r.type,
    )
    expect(types).toEqual(
      expect.arrayContaining([
        'attempt.preparing',
        'attempt.started',
        'agent.message',
        'agent.tool_use',
        'attempt.finished',
      ]),
    )
    expect(contiguous(await sequences(attemptId))).toBe(true)
    expect(types.filter((x) => x.startsWith('runner.'))).toEqual([])
    expect(existsSync(path.join(home, 'work', attemptId, 'out', 'result.txt'))).toBe(true)
    const [task] = await t.db.sql`select state from tasks where id = ${taskId}`
    expect(task!.state).toBe('awaiting_review')
  })

  it('loses and duplicates nothing when the connection drops mid-attempt', async () => {
    const r = await startRunner()
    const script = Array.from({ length: 12 }, (_, i) => [{ say: `step ${i}` }, { sleepMs: 100 }]).flat()
    const { attemptId } = await start(script)
    await waitFor(async () => (await state(attemptId)) === 'running', 5_000, 'running')
    r.connection.drop()
    await waitFor(async () => (await state(attemptId)) === 'succeeded', 15_000, 'succeeded after reconnect')
    const seqs = await sequences(attemptId)
    expect(contiguous(seqs)).toBe(true)
    const messages = await t.db
      .sql`select payload from events where attempt_id = ${attemptId} and type = 'agent.message'`
    expect(messages.map((m) => (m.payload as { text: string }).text)).toEqual(
      script.flatMap((x) => ('say' in x ? [x.say] : [])),
    )
  })

  it('records an interruption across a runner restart without duplicating events', async () => {
    const first = await startRunner()
    const { taskId, attemptId } = await start([{ say: 'working' }, { sleepMs: 30_000 }, { say: 'never' }])
    await waitFor(async () => (await state(attemptId)) === 'running', 5_000, 'running')
    await waitFor(async () => (await sequences(attemptId)).length >= 4, 5_000, 'message persisted')

    // Stop without letting the final events reach control, then restart from the same journal.
    first.connection.drop()
    await first.stop()
    runners.splice(runners.indexOf(first), 1)
    expect(await state(attemptId)).not.toBe('interrupted')

    await startRunner()
    await waitFor(async () => (await state(attemptId)) === 'interrupted', 10_000, 'interrupted after restart')
    expect(contiguous(await sequences(attemptId))).toBe(true)
    const [task] = await t.db.sql`select state from tasks where id = ${taskId}`
    expect(task!.state).toBe('active')
  })

  it('interrupts a running attempt on request', async () => {
    await startRunner()
    const { attemptId } = await start([{ say: 'long job' }, { sleepMs: 30_000 }])
    await waitFor(async () => (await state(attemptId)) === 'running', 5_000, 'running')
    const res = await s.admin.post(`/api/attempts/${attemptId}/interrupt`)
    expect(res.statusCode).toBe(200)
    await waitFor(async () => (await state(attemptId)) === 'interrupted', 10_000, 'interrupted')
  })

  it('fails the attempt and frees the task for a retry when the agent fails', async () => {
    await startRunner()
    const { taskId, attemptId } = await start([{ say: 'trying' }, { fail: 'compile error' }])
    await waitFor(async () => (await state(attemptId)) === 'failed', 10_000, 'failed')
    const [task] = await t.db.sql`select state, attempts_used from tasks where id = ${taskId}`
    expect(task).toMatchObject({ state: 'ready', attemptsUsed: 1 })
  })
})
