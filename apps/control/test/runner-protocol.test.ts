import { FakeRunnerClient, waitFor } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvedDelivery, createTestApp, enrolRunner, seedProject, type TestApp } from './helpers/app'

let t: TestApp
let s: Awaited<ReturnType<typeof seedProject>>
let url: string
let runner: FakeRunnerClient | undefined

beforeEach(async () => {
  t = await createTestApp()
  s = await seedProject(t)
  url = await t.app.listen({ host: '127.0.0.1', port: 0 })
})
afterEach(async () => {
  await runner?.close()
  runner = undefined
  await t.close()
})

async function connectedRunner(name = 'runner-1') {
  const { runnerId, token } = await enrolRunner(s.admin, t.app, name)
  const client = new FakeRunnerClient(url, runnerId, token)
  await client.connect()
  return client
}

async function startAttempt(runnerId: string) {
  const { tasks } = await approvedDelivery(s)
  const res = await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId, agentKind: 'fake' })
  expect(res.statusCode).toBe(201)
  return { taskId: tasks.T1!.id, attempt: res.json().attempt as { id: string; generation: number } }
}

const attemptRow = async (id: string) => (await t.db.sql`select * from attempts where id = ${id}`)[0]!

describe('enrolment', () => {
  it('exchanges a single-use invitation for a device token', async () => {
    const invite = (await s.admin.post('/api/runners/invites', { label: 'box' })).json()
    const body = { inviteToken: invite.token, name: 'box', hostname: 'h', os: 'linux', arch: 'x64' }
    const first = await t.app.inject({ method: 'POST', url: '/api/runners/enrol', payload: body })
    expect(first.statusCode).toBe(201)
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/runners/enrol',
      payload: { ...body, name: 'box2' },
    })
    expect(second.statusCode).toBe(401)
    const [row] = await t.db.sql`select token_hash from runners where id = ${first.json().runnerId}`
    expect(row!.tokenHash).not.toContain(first.json().token)
  })

  it('only admins can create invitations', async () => {
    expect((await s.member.post('/api/runners/invites', { label: 'x' })).statusCode).toBe(403)
  })

  it('refuses a WebSocket without a valid device token', async () => {
    const client = new FakeRunnerClient(url, 'nobody', 'mec_rt_invalid_token_value')
    await expect(client.connect()).rejects.toThrow(/401/)
  })

  it('marks the runner online on hello and offline on disconnect', async () => {
    runner = await connectedRunner()
    const [online] = await t.db.sql`select status, capacity from runners where id = ${runner.runnerId}`
    expect(online).toMatchObject({ status: 'online', capacity: { maxAttempts: 2 } })
    await runner.close()
    await waitFor(
      async () =>
        (await t.db.sql`select status from runners where id = ${runner!.runnerId}`)[0]!.status === 'offline',
    )
  })

  it('revoking a runner closes its connection and refuses reconnects', async () => {
    runner = await connectedRunner()
    expect((await s.admin.post(`/api/runners/${runner.runnerId}/revoke`)).statusCode).toBe(200)
    await expect(runner.connect()).rejects.toThrow(/401/)
  })
})

describe('dispatch', () => {
  it('a claim delivers one start command; redelivery is idempotent', async () => {
    runner = await connectedRunner()
    const { attempt } = await startAttempt(runner.runnerId)
    const cmd = await waitFor(() => runner!.commands.find((c) => c.type === 'start'))
    expect(cmd).toMatchObject({ attemptId: attempt.id, generation: 1, commandId: `${attempt.id}:g1:start` })

    // Not acknowledged: control resends after the retry window, with the same commandId.
    await t.db
      .sql`update outbox set sent_at = now() - interval '1 minute' where idempotency_key = ${cmd.commandId}`
    await t.app.services.dispatcher.kick(runner.runnerId)
    await waitFor(() => runner!.commands.filter((c) => c.commandId === cmd.commandId).length === 2)

    runner.accept(cmd.commandId)
    await waitFor(
      async () =>
        (await t.db.sql`select delivered_at from outbox where idempotency_key = ${cmd.commandId}`)[0]!
          .deliveredAt,
    )
  })

  it('a duplicate dispatch returns the existing attempt', async () => {
    runner = await connectedRunner()
    const { taskId, attempt } = await startAttempt(runner.runnerId)
    const again = await s.admin.post(`/api/tasks/${taskId}/attempts`, { runnerId: runner.runnerId })
    expect(again.statusCode).toBe(200)
    expect(again.json().attempt.id).toBe(attempt.id)
    const [{ n }] = (await t.db
      .sql`select count(*)::int as n from attempts where task_id = ${taskId}`) as unknown as [{ n: number }]
    expect(n).toBe(1)
  })

  it('queues commands for an offline runner and delivers them on connect', async () => {
    const { runnerId, token } = await enrolRunner(s.admin, t.app)
    const { tasks } = await approvedDelivery(s)
    const res = await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { runnerId })
    expect(res.statusCode).toBe(201)
    runner = new FakeRunnerClient(url, runnerId, token)
    await runner.connect()
    await waitFor(() => runner!.commands.find((c) => c.type === 'start'))
  })
})

describe('event ingestion', () => {
  it('applies lifecycle events and moves the task to review on success', async () => {
    runner = await connectedRunner()
    const { taskId, attempt } = await startAttempt(runner.runnerId)
    for (const type of [
      'attempt.preparing',
      'attempt.started',
      'agent.message',
      'attempt.finished',
      'attempt.checks_started',
    ]) {
      await runner.emit(runner.envelope(attempt.id, 1, type, { text: 'x' }))
    }
    await runner.emit(runner.envelope(attempt.id, 1, 'attempt.checks_completed', { passed: true }))
    expect((await attemptRow(attempt.id)).state).toBe('succeeded')
    const [task] = await t.db.sql`select state from tasks where id = ${taskId}`
    expect(task!.state).toBe('awaiting_review')
  })

  it('stores a replayed event once and still acknowledges it', async () => {
    runner = await connectedRunner()
    const { attempt } = await startAttempt(runner.runnerId)
    const e = runner.envelope(attempt.id, 1, 'attempt.preparing')
    await runner.emit(e)
    runner.send({ type: 'event', event: e })
    await waitFor(() => runner!.acks.filter((a) => a.eventId === e.eventId).length === 2)
    const rows = await t.db.sql`select id from events where source_event_id = ${e.eventId}`
    expect(rows).toHaveLength(1)
    expect(runner.acks.filter((a) => a.eventId === e.eventId)).toHaveLength(2)
  })

  it('rejects a sequence that goes backwards and flags gaps', async () => {
    runner = await connectedRunner()
    const { attempt } = await startAttempt(runner.runnerId)
    await runner.emit(runner.envelope(attempt.id, 1, 'agent.message', {}, { sequence: 0 }))
    await runner.emit(runner.envelope(attempt.id, 1, 'agent.message', {}, { sequence: 3 }))
    await runner.emit(runner.envelope(attempt.id, 1, 'agent.message', {}, { sequence: 2 }))
    const types = (await t.db.sql`select type from events where attempt_id = ${attempt.id} order by id`).map(
      (r) => r.type,
    )
    expect(types).toContain('runner.sequence_gap')
    expect(types).toContain('runner.protocol_violation')
    expect((await attemptRow(attempt.id)).lastSequence).toBe(3)
  })

  it('keeps events from a fenced generation as evidence without changing state', async () => {
    runner = await connectedRunner()
    const { attempt } = await startAttempt(runner.runnerId)
    await runner.emit(runner.envelope(attempt.id, 1, 'attempt.preparing'))
    await t.db.sql`update attempts set generation = 2 where id = ${attempt.id}`
    await runner.emit(runner.envelope(attempt.id, 1, 'attempt.started'))
    const row = await attemptRow(attempt.id)
    expect(row.state).toBe('preparing')
    const [stale] = await t.db
      .sql`select payload from events where attempt_id = ${attempt.id} and type = 'attempt.started'`
    expect(stale!.payload).toMatchObject({ fenced: 'stale_generation' })
  })

  it("refuses events for another runner's attempt", async () => {
    runner = await connectedRunner('runner-a')
    const other = await connectedRunner('runner-b')
    const { attempt } = await startAttempt(runner.runnerId)
    await other.emit(other.envelope(attempt.id, 1, 'attempt.preparing'))
    expect((await attemptRow(attempt.id)).state).toBe('leased')
    await other.close()
  })

  it('renews the lease from heartbeats for the current generation only', async () => {
    runner = await connectedRunner()
    const { attempt } = await startAttempt(runner.runnerId)
    await t.db
      .sql`update attempts set lease_expires_at = now() + interval '1 second' where id = ${attempt.id}`
    runner.send({
      type: 'heartbeat',
      attempts: [{ attemptId: attempt.id, generation: 0, process: 'live', lastSequence: -1 }],
    })
    await new Promise((r) => setTimeout(r, 200))
    const before = (await attemptRow(attempt.id)).leaseExpiresAt as Date
    expect(before.getTime() - Date.now()).toBeLessThan(5_000)
    runner.send({
      type: 'heartbeat',
      attempts: [{ attemptId: attempt.id, generation: 1, process: 'live', lastSequence: -1 }],
    })
    await waitFor(
      async () => ((await attemptRow(attempt.id)).leaseExpiresAt as Date).getTime() - Date.now() > 30_000,
    )
  })
})
