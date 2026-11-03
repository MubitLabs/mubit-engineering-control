import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runner, silentLogger } from '@mec/runner'
import { waitFor } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvedDelivery, createTestApp, enrolRunner, seedProject, type TestApp } from './helpers/app'

let t: TestApp
let s: Awaited<ReturnType<typeof seedProject>>
let runner: Runner

beforeEach(async () => {
  t = await createTestApp()
  s = await seedProject(t)
  const url = await t.app.listen({ host: '127.0.0.1', port: 0 })
  const creds = await enrolRunner(s.admin, t.app)
  runner = new Runner(
    {
      controlUrl: url,
      runnerId: creds.runnerId,
      token: creds.token,
      home: await mkdtemp(path.join(tmpdir(), 'mec-runner-')),
      maxAttempts: 2,
      heartbeatMs: 300,
      logLevel: 'error',
    },
    silentLogger,
  )
  await runner.start()
  await waitFor(() => runner.connection.ready, 5_000)
})
afterEach(async () => {
  await runner.stop()
  await t.close()
})

const requirements = [
  { id: 'R1', text: 'Audit records are stored and returned by GET /audit' },
  { id: 'R2', text: 'The console lists audit records' },
]
const task = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  objective: `Implement ${key}`,
  requirementIds: ['R1'],
  acceptanceChecks: ['test'],
  ownedPaths: [`src/${key.toLowerCase()}`],
  ...extra,
})
const validGraph = {
  requirements,
  tasks: [
    task('API'),
    task('UI', { dependsOn: ['API'], requirementIds: ['R2'] }),
    task('DOCS', { requirementIds: ['R1', 'R2'] }),
  ],
}
const cyclicGraph = {
  requirements,
  tasks: [task('API', { dependsOn: ['UI'] }), task('UI', { dependsOn: ['API'], requirementIds: ['R2'] })],
}

async function newDelivery() {
  return (
    await s.admin.post('/api/deliveries', {
      projectId: s.project.id,
      repositoryId: s.repo.id,
      title: 'Audit log',
      planMarkdown: '# Audit log\n\nStore audit records, expose GET /audit, show them in the console.',
      idempotencyKey: `plan-${Math.random()}`,
    })
  ).json().delivery as { id: string }
}

async function coordinate(deliveryId: string, script: unknown[]) {
  const res = await s.admin.post(`/api/deliveries/${deliveryId}/coordinate`, {
    runnerId: runner.config.runnerId,
    agentKind: 'fake',
    script,
  })
  expect(res.statusCode).toBe(201)
  const attemptId = res.json().attempt.id as string
  await waitFor(
    async () =>
      ['succeeded', 'failed'].includes(
        (await t.db.sql`select state from attempts where id = ${attemptId}`)[0]!.state as string,
      ),
    15_000,
    'coordinator finished',
  )
  const replies = (
    await t.db
      .sql`select payload->>'text' as text from events where attempt_id = ${attemptId} and type = 'agent.message' order by id`
  )
    .map((r) => r.text as string)
    .filter((x) => x.startsWith('Control replied: '))
    .map((x) => JSON.parse(x.slice('Control replied: '.length)))
  return { attemptId, replies }
}

describe('coordinator', () => {
  it('repairs an invalid proposal, then submits a valid graph for the owner to approve', async () => {
    const delivery = await newDelivery()
    const { attemptId, replies } = await coordinate(delivery.id, [
      { say: 'Reading the repository.' },
      { call: 'propose_tasks', params: cyclicGraph },
      { call: 'propose_tasks', params: validGraph },
    ])
    expect(replies[0]).toMatchObject({ ok: false, attemptsLeft: 3 })
    expect(replies[0].errors.join(' ')).toContain('Dependency cycle')
    expect(replies[1]).toMatchObject({ ok: true, maxParallelism: 2 })

    const detail = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json()
    const rev = detail.revisions[0]
    expect(rev).toMatchObject({ state: 'proposed', requirements })
    expect(rev.tasks.map((x: { key: string }) => x.key)).toEqual(['API', 'UI', 'DOCS'])
    const [approval] = detail.approvals.filter((a: { kind: string }) => a.kind === 'plan')
    expect(approval).toMatchObject({ status: 'pending', requestedByKind: 'agent', requestedBy: attemptId })

    // The coordinator cannot approve: only the delivery owner can.
    expect(
      (await s.member.post(`/api/plans/${rev.id}/approve`, { expectedVersion: rev.version })).statusCode,
    ).toBe(403)
    expect(
      (await s.admin.post(`/api/plans/${rev.id}/approve`, { expectedVersion: rev.version })).statusCode,
    ).toBe(200)
    const after = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json()
    const states = Object.fromEntries(
      after.tasks
        .filter((x: { kind: string }) => x.kind === 'work')
        .map((x: { key: string; state: string }) => [x.key, x.state]),
    )
    expect(states).toEqual({ API: 'ready', UI: 'approved', DOCS: 'ready' })
    const planning = after.tasks.find((x: { kind: string }) => x.kind === 'planning')
    expect(planning).toMatchObject({ key: 'mec-plan-1', state: 'accepted' })
  })

  it('marks a coordinator run that proposed nothing as failed, with the reason', async () => {
    const delivery = await newDelivery()
    await coordinate(delivery.id, [{ say: 'I looked around but will not propose anything.' }])
    const detail = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json()
    const planning = detail.tasks.find((x: { kind: string }) => x.kind === 'planning')
    expect(planning.state).toBe('failed')
    expect(planning.blocker.detail).toMatch(/without proposing a valid task graph/)
  })

  it('stops after a bounded number of invalid proposals', async () => {
    const delivery = await newDelivery()
    const steps = Array.from({ length: 5 }, () => ({ call: 'propose_tasks', params: cyclicGraph }))
    const { replies } = await coordinate(delivery.id, steps)
    expect(replies.map((r) => r.attemptsLeft ?? 'final')).toEqual([3, 2, 1, 0, 'final'])
    expect(replies.at(-1)).toMatchObject({ ok: false, final: true })
    const [rev] = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json().revisions
    expect(rev.state).toBe('draft')
  })

  it('gives the coordinator the repository check names and read-only mode', async () => {
    const delivery = await newDelivery()
    const res = await s.admin.post(`/api/deliveries/${delivery.id}/coordinate`, {
      runnerId: runner.config.runnerId,
      agentKind: 'fake',
      script: [],
    })
    const attempt = res.json().attempt
    expect(attempt.kind).toBe('coordinator')
    expect(attempt.inputs.prompt).toContain('acceptanceChecks must be names from [test, lint]')
    expect(attempt.inputs.prompt).toContain('Store audit records')
  })

  it('refuses propose_tasks from an ordinary task attempt', async () => {
    const { tasks } = await approvedDelivery(s)
    const res = await s.admin.post(`/api/tasks/${tasks.T1!.id}/attempts`, {
      runnerId: runner.config.runnerId,
      script: [{ call: 'propose_tasks', params: validGraph }],
    })
    const attemptId = res.json().attempt.id
    await waitFor(
      async () =>
        (await t.db.sql`select state from attempts where id = ${attemptId}`)[0]!.state === 'succeeded',
      15_000,
    )
    const [m] = await t.db.sql`
      select payload->>'text' as text from events where attempt_id = ${attemptId} and payload->>'text' like 'Control replied:%'
    `
    expect(m!.text).toContain('Only a coordinator may propose tasks')
  })
})

describe('revising an approved plan', () => {
  it('withdraws the pending review of a task the new revision replaces', async () => {
    const { delivery, tasks } = await approvedDelivery(s, [task('API')])
    await s.admin.post(`/api/tasks/${tasks.API!.id}/attempts`, {
      runnerId: runner.config.runnerId,
      script: [],
    })
    const review = await waitFor(async () => {
      const [a] = await t.db
        .sql`select id from approvals where task_id = ${tasks.API!.id} and kind = 'result' and status = 'pending'`
      return a
    }, 15_000)

    const next = (await s.admin.post(`/api/deliveries/${delivery.id}/plans`, {})).json().revision
    const changed = next.tasks.map((x: { objective: string }) => ({ ...x, objective: 'A different API' }))
    const saved = (
      await s.admin.patch(`/api/plans/${next.id}`, { expectedVersion: next.version, tasks: changed })
    ).json().revision
    await s.admin.post(`/api/plans/${next.id}/submit`, { expectedVersion: saved.version })
    await s.admin.post(`/api/plans/${next.id}/approve`, { expectedVersion: saved.version })

    const [old] = await t.db.sql`select status from approvals where id = ${review.id}`
    expect(old!.status).toBe('stale')
    const res = await s.admin.post(`/api/approvals/${review.id}/resolve`, { decision: { kind: 'approve' } })
    expect(res.statusCode).toBe(409)
  })

  it('carries unchanged tasks over, replaces changed ones and records the impact', async () => {
    const { delivery, tasks } = await approvedDelivery(s, [
      task('API'),
      task('UI', { dependsOn: ['API'], requirementIds: ['R2'] }),
    ])
    const api = await s.admin.post(`/api/tasks/${tasks.API!.id}/attempts`, {
      runnerId: runner.config.runnerId,
      script: [],
    })
    await waitFor(
      async () =>
        (await t.db.sql`select state from tasks where id = ${tasks.API!.id}`)[0]!.state === 'awaiting_review',
      15_000,
    )
    void api

    const next = (await s.admin.post(`/api/deliveries/${delivery.id}/plans`, {})).json().revision
    const changed = next.tasks.map((x: { key: string; objective: string }) =>
      x.key === 'UI' ? { ...x, objective: 'Show audit records with filters' } : x,
    )
    const saved = (
      await s.admin.patch(`/api/plans/${next.id}`, { expectedVersion: next.version, tasks: changed })
    ).json().revision
    const submitted = (
      await s.admin.post(`/api/plans/${next.id}/submit`, { expectedVersion: saved.version })
    ).json()
    expect(submitted.revision.impactSummary).toBe('Changed: UI\nUnchanged, continuing: API')
    await s.admin.post(`/api/plans/${next.id}/approve`, { expectedVersion: saved.version })

    const rows = await t.db
      .sql`select id, key, state, plan_revision_id from tasks where delivery_id = ${delivery.id} and kind = 'work' order by created_at`
    const apiRows = rows.filter((r) => r.key === 'API')
    expect(apiRows).toHaveLength(1)
    expect(apiRows[0]).toMatchObject({ id: tasks.API!.id, state: 'awaiting_review', planRevisionId: next.id })
    const ui = rows.filter((r) => r.key === 'UI').map((r) => r.state)
    expect(ui).toEqual(['cancelled', 'approved'])
  })
})
