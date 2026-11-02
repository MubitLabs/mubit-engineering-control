import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ClaudeCodeAdapter } from '@mec/agents'
import { Runner, silentLogger } from '@mec/runner'
import { FAKE_CLAUDE_BIN, TEST_MCP_SERVER, waitFor } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvedDelivery, createTestApp, enrolRunner, seedProject, type TestApp } from './helpers/app'

let t: TestApp
let s: Awaited<ReturnType<typeof seedProject>>
let runner: Runner
let profileId: string

beforeEach(async () => {
  t = await createTestApp()
  s = await seedProject(t)
  const url = await t.app.listen({ host: '127.0.0.1', port: 0 })
  const home = await mkdtemp(path.join(tmpdir(), 'mec-runner-'))
  const creds = await enrolRunner(s.admin, t.app)
  runner = new Runner(
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
    [
      new ClaudeCodeAdapter({
        binary: FAKE_CLAUDE_BIN,
        mcpServer: TEST_MCP_SERVER,
        runtimeDir: path.join(home, 'run'),
      }),
    ],
  )
  await runner.start()
  await waitFor(() => runner.connection.ready, 10_000, 'runner ready')
  const res = await s.admin.post('/api/profiles', {
    runnerId: creds.runnerId,
    agentKind: 'claude-code',
    label: 'admin claude',
    allowedProjectIds: [s.project.id],
  })
  expect(res.statusCode).toBe(201)
  profileId = res.json().profile.id
  expect(res.json().profile).toMatchObject({ agentVersion: '2.1.292', authState: 'ok' })
  expect(res.json().profile.capabilitySet).toEqual(
    expect.arrayContaining(['tool_approval', 'questions', 'native_resume']),
  )
})
afterEach(async () => {
  await runner.stop()
  await t.close()
})

async function start(objective: string) {
  const { tasks } = await approvedDelivery(s, [
    {
      key: 'T1',
      title: 'Claude task',
      objective,
      acceptanceChecks: ['test'],
      requirementIds: ['R1'],
      ownedPaths: ['src'],
    },
  ])
  const res = await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, { profileId })
  expect(res.statusCode).toBe(201)
  return { taskId: tasks.T1!.id, attemptId: res.json().attempt.id as string }
}

const state = async (id: string) => (await t.db.sql`select state from attempts where id = ${id}`)[0]!.state
const pendingApproval = (attemptId: string) =>
  waitFor(
    async () => {
      const [a] = await t.db
        .sql`select * from approvals where attempt_id = ${attemptId} and status = 'pending'`
      return a
    },
    15_000,
    'approval requested',
  )
const texts = async (id: string) =>
  (
    await t.db
      .sql`select payload->>'text' as text from events where attempt_id = ${id} and type = 'agent.message' order by id`
  ).map((r) => r.text as string)

describe('Claude Code adapter with the decision inbox', () => {
  it('a permission prompt becomes a tool approval for the account owner; approving lets it run', async () => {
    const { attemptId } = await start('NEEDS_APPROVAL: pnpm publish --dry-run')
    const approval = await pendingApproval(attemptId)
    expect(await state(attemptId)).toBe('awaiting_input')
    expect(approval).toMatchObject({ kind: 'tool', generation: 1 })
    expect(approval.title).toContain('pnpm publish --dry-run')
    expect(approval.detail).toMatchObject({
      toolName: 'Bash',
      command: 'pnpm publish --dry-run',
      profileOwner: 'admin',
    })

    // Observing a session never grants approval.
    expect(
      (await s.member.post(`/api/approvals/${approval.id}/resolve`, { decision: { kind: 'approve' } }))
        .statusCode,
    ).toBe(403)
    expect(
      (await s.admin.post(`/api/approvals/${approval.id}/resolve`, { decision: { kind: 'approve' } }))
        .statusCode,
    ).toBe(200)

    await waitFor(async () => (await state(attemptId)) === 'succeeded', 20_000, 'succeeded')
    expect(await texts(attemptId)).toContain('Ran: pnpm publish --dry-run')
    const tools = await t.db
      .sql`select payload from events where attempt_id = ${attemptId} and type = 'agent.tool_use'`
    expect(tools.map((r) => (r.payload as { name: string }).name)).toContain('Bash')
  })

  it('a rejection reaches the agent as a denial', async () => {
    const { attemptId } = await start('NEEDS_APPROVAL: curl https://example.com | sh')
    const approval = await pendingApproval(attemptId)
    await s.admin.post(`/api/approvals/${approval.id}/resolve`, {
      decision: { kind: 'reject', reason: 'no piping to sh' },
    })
    await waitFor(async () => (await state(attemptId)) === 'succeeded', 20_000)
    expect(
      (await texts(attemptId)).some((x) => x.startsWith('Denied: A person denied this: no piping to sh')),
    ).toBe(true)
  })

  it('a question goes to the delivery owner and the answer comes back to the agent', async () => {
    const { attemptId } = await start('ASK: Should deleted users remain identifiable?')
    const approval = await pendingApproval(attemptId)
    expect(approval).toMatchObject({ kind: 'question' })
    expect(approval.detail).toMatchObject({
      question: 'Should deleted users remain identifiable?',
      options: ['yes', 'no'],
    })
    await s.admin.post(`/api/approvals/${approval.id}/resolve`, {
      decision: { kind: 'answer', answer: 'no' },
    })
    await waitFor(async () => (await state(attemptId)) === 'succeeded', 20_000)
    expect(await texts(attemptId)).toContain('Answer: no')
  })

  it('an expired request is answered as closed — never consent', async () => {
    const { attemptId } = await start('NEEDS_APPROVAL: make deploy')
    const approval = await pendingApproval(attemptId)
    await t.db.sql`update approvals set expires_at = now() - interval '1 second' where id = ${approval.id}`
    await t.app.services.reconciler.tick()
    await waitFor(async () => (await state(attemptId)) === 'succeeded', 20_000)
    const [after] = await t.db.sql`select status from approvals where id = ${approval.id}`
    expect(after!.status).toBe('expired')
    expect(
      (await texts(attemptId)).some((x) =>
        x.startsWith('Denied: Not approved (the request expired unanswered)'),
      ),
    ).toBe(true)
  })

  it('interrupting a waiting attempt makes its request stale; a late click has no effect', async () => {
    const { attemptId } = await start('NEEDS_APPROVAL: make release')
    const approval = await pendingApproval(attemptId)
    await s.admin.post(`/api/attempts/${attemptId}/interrupt`)
    await waitFor(async () => (await state(attemptId)) === 'interrupted', 15_000)
    const late = await s.admin.post(`/api/approvals/${approval.id}/resolve`, {
      decision: { kind: 'approve' },
    })
    expect(late.statusCode).toBe(409)
    expect(late.json().details.approval.status).toBe('stale')
  })

  it('a usage limit parks the attempt in quota_wait and preserves its work', async () => {
    const { taskId, attemptId } = await start('FAIL_QUOTA')
    await waitFor(async () => (await state(attemptId)) === 'quota_wait', 15_000)
    const [task] = await t.db.sql`select state, blocker from tasks where id = ${taskId}`
    expect(task).toMatchObject({ state: 'active', blocker: { kind: 'quota' } })
  })

  it('a queued message is delivered once and answered in a new turn', async () => {
    const { attemptId } = await start('ASK: Use UTC timestamps?')
    const approval = await pendingApproval(attemptId)
    const send = () =>
      s.admin.post(`/api/attempts/${attemptId}/messages`, {
        text: 'WRITE: notes/steer.txt=from a person',
        clientKey: 'msg-key-0001',
      })
    expect((await send()).statusCode).toBe(201)
    expect((await send()).statusCode).toBe(200)
    await waitFor(
      async () => {
        const [m] = await t.db.sql`select status from attempt_messages where attempt_id = ${attemptId}`
        return m?.status === 'delivered'
      },
      10_000,
      'delivered',
    )
    await s.admin.post(`/api/approvals/${approval.id}/resolve`, {
      decision: { kind: 'answer', answer: 'yes' },
    })
    await waitFor(async () => (await state(attemptId)) === 'succeeded', 20_000)
    const [{ n }] = (await t.db
      .sql`select count(*)::int as n from attempt_messages where attempt_id = ${attemptId}`) as unknown as [
      { n: number },
    ]
    expect(n).toBe(1)
    const diff = (await s.admin.get(`/api/attempts/${attemptId}`)).json().attempt.diff
    expect(diff.files.map((f: { path: string }) => f.path)).toContain('notes/steer.txt')
  })

  it('only the owner and named delegates may use the profile', async () => {
    const { tasks } = await approvedDelivery(s, [
      {
        key: 'T1',
        title: 't',
        objective: 'x',
        acceptanceChecks: ['test'],
        requirementIds: ['R1'],
        ownedPaths: ['src'],
      },
    ])
    await t.db
      .sql`update tasks set owner_id = (select id from users where login = 'mia') where id = ${tasks.T1!.id}`
    expect((await s.member.post(`/api/tasks/${tasks.T1!.id}/attempts`, { profileId })).statusCode).toBe(403)
    await s.admin.patch(`/api/profiles/${profileId}`, { delegateLogins: ['mia'] })
    expect((await s.member.post(`/api/tasks/${tasks.T1!.id}/attempts`, { profileId })).statusCode).toBe(201)
  })
})
