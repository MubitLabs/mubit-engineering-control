import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestApp,
  enrolRunner,
  sampleRequirements,
  sampleTasks,
  seedProject,
  type TestApp,
} from './helpers/app'

let t: TestApp
let s: Awaited<ReturnType<typeof seedProject>>
beforeEach(async () => {
  t = await createTestApp()
  s = await seedProject(t)
})
afterEach(async () => t.close())

const newDelivery = (key: string, extra: Record<string, unknown> = {}) => ({
  projectId: s.project.id,
  repositoryId: s.repo.id,
  title: 'Audit log',
  planMarkdown: '# Audit log\n\nAdd an audit endpoint and console view.',
  requirements: sampleRequirements,
  tasks: sampleTasks,
  idempotencyKey: key,
  ...extra,
})

async function submitted() {
  const created = (await s.admin.post('/api/deliveries', newDelivery('key-submitted'))).json()
  const detail = (await s.admin.get(`/api/deliveries/${created.delivery.id}`)).json()
  const rev = detail.revisions[0]
  const res = await s.admin.post(`/api/plans/${rev.id}/submit`, { expectedVersion: rev.version })
  expect(res.statusCode).toBe(200)
  const [approval] = (await s.admin.get(`/api/approvals?projectId=${s.project.id}`)).json().approvals
  return { delivery: created.delivery, rev, approval }
}

describe('projects and permissions', () => {
  it('lets only admins create projects', async () => {
    expect((await s.member.post('/api/projects', { slug: 'x', name: 'X' })).statusCode).toBe(403)
  })

  it('lists projects by membership and hides others', async () => {
    expect(
      (await s.viewer.get('/api/projects')).json().projects.map((p: { slug: string }) => p.slug),
    ).toEqual(['core'])
    const outsider = await t.login('olga')
    expect((await outsider.get('/api/projects')).json().projects).toEqual([])
    expect((await outsider.get(`/api/projects/${s.project.id}`)).statusCode).toBe(403)
  })

  it('refuses clone URLs with credentials or non-https schemes', async () => {
    const bad = [
      'https://user:pw@github.com/a/b.git',
      'ssh://git@github.com/a/b.git',
      'git@github.com:a/b.git',
    ]
    for (const cloneUrl of bad) {
      const res = await s.admin.post(`/api/projects/${s.project.id}/repositories`, { name: 'r', cloneUrl })
      expect(res.statusCode).toBe(400)
    }
  })

  it("lets project owners change a repository's setup, checks and branch, and no one else", async () => {
    const url = `/api/projects/${s.project.id}/repositories/${s.repo.id}`
    const validationProfile = {
      bootstrap: [{ name: 'install', argv: ['npm', 'ci'] }],
      checks: [{ name: 'test', argv: ['npm', 'test'], timeoutSec: 120 }],
    }
    expect((await s.member.patch(url, { validationProfile })).statusCode).toBe(403)
    const res = await s.admin.patch(url, { validationProfile, defaultBranch: 'develop' })
    expect(res.statusCode).toBe(200)
    expect(res.json().repository).toMatchObject({
      defaultBranch: 'develop',
      validationProfile: {
        bootstrap: [{ name: 'install', argv: ['npm', 'ci'], timeoutSec: 600 }],
        checks: [{ name: 'test', argv: ['npm', 'test'], timeoutSec: 120 }],
      },
    })
    const missing = `/api/projects/${s.project.id}/repositories/00000000-0000-0000-0000-000000000000`
    expect((await s.admin.patch(missing, { defaultBranch: 'x' })).statusCode).toBe(404)
  })

  it('does not let viewers create deliveries', async () => {
    expect((await s.viewer.post('/api/deliveries', newDelivery('viewer-key'))).statusCode).toBe(403)
  })
})

describe('deliveries', () => {
  it('is idempotent on the idempotency key', async () => {
    const first = await s.member.post('/api/deliveries', newDelivery('same-key-123'))
    const second = await s.member.post('/api/deliveries', newDelivery('same-key-123'))
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(second.json().delivery.id).toBe(first.json().delivery.id)
    const [{ n }] = (await t.db.sql`select count(*)::int as n from deliveries`) as unknown as [{ n: number }]
    expect(n).toBe(1)
  })

  it('creates revision 1 as a draft owned by the creator', async () => {
    const { delivery } = (await s.member.post('/api/deliveries', newDelivery('rev-one-key'))).json()
    const detail = (await s.member.get(`/api/deliveries/${delivery.id}`)).json()
    expect(detail.delivery).toMatchObject({ state: 'planning', ownerId: detail.owner.id, baseRef: 'main' })
    expect(detail.revisions).toHaveLength(1)
    expect(detail.revisions[0]).toMatchObject({ number: 1, state: 'draft', version: 1 })
  })
})

describe('plan revisions', () => {
  it('detects concurrent edits and returns the newer text', async () => {
    const { delivery } = (await s.admin.post('/api/deliveries', newDelivery('edit-key-1'))).json()
    const rev = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json().revisions[0]
    const a = await s.admin.patch(`/api/plans/${rev.id}`, { expectedVersion: 1, planMarkdown: 'edit A' })
    const b = await s.member.patch(`/api/plans/${rev.id}`, { expectedVersion: 1, planMarkdown: 'edit B' })
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(409)
    expect(b.json().error).toBe('version_conflict')
    expect(b.json().details.current).toMatchObject({ planMarkdown: 'edit A', version: 2 })
  })

  it('refuses to submit an invalid graph and records why', async () => {
    const tasks = [{ ...sampleTasks[0], dependsOn: ['T9'], acceptanceChecks: [] }]
    const { delivery } = (await s.admin.post('/api/deliveries', newDelivery('invalid-key', { tasks }))).json()
    const rev = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json().revisions[0]
    const res = await s.admin.post(`/api/plans/${rev.id}/submit`, { expectedVersion: 1 })
    expect(res.statusCode).toBe(422)
    const codes = res.json().details.validation.errors.map((e: { code: string }) => e.code)
    expect(codes).toEqual(expect.arrayContaining(['unknown_dependency', 'missing_acceptance_checks']))
  })

  it('submitting creates one plan approval for the delivery owner', async () => {
    const { approval } = await submitted()
    expect(approval).toMatchObject({ kind: 'plan', status: 'pending' })
    expect((await s.member.get(`/api/approvals?projectId=${s.project.id}`)).json().approvals).toEqual([])
  })

  it('approval makes the revision immutable and materialises ready tasks', async () => {
    const { delivery, rev } = await submitted()
    const res = await s.admin.post(`/api/plans/${rev.id}/approve`, { expectedVersion: 1 })
    expect(res.statusCode).toBe(200)
    const detail = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json()
    expect(detail.delivery.state).toBe('approved')
    const states = Object.fromEntries(
      detail.tasks.map((x: { key: string; state: string }) => [x.key, x.state]),
    )
    expect(states).toEqual({ T1: 'ready', T2: 'approved', T3: 'approved' })
    const t2 = detail.tasks.find((x: { key: string }) => x.key === 'T2')
    expect(t2.blocker).toMatchObject({ kind: 'dependency', refs: ['T1'] })
    const edit = await s.admin.patch(`/api/plans/${rev.id}`, {
      expectedVersion: 1,
      planMarkdown: 'late edit',
    })
    expect(edit.json().error).toBe('immutable_revision')
  })

  it('a new revision supersedes the open one and invalidates its approval', async () => {
    const { delivery, approval } = await submitted()
    const res = await s.admin.post(`/api/deliveries/${delivery.id}/plans`, {})
    expect(res.statusCode).toBe(201)
    expect(res.json().revision.number).toBe(2)
    const after = (await s.admin.get(`/api/approvals/${approval.id}`)).json().approval
    expect(after.status).toBe('stale')
  })
})

describe('approval integrity', () => {
  it('two concurrent answers produce exactly one authoritative resolution', async () => {
    const { delivery, approval } = await submitted()
    const url = `/api/approvals/${approval.id}/resolve`
    const results = await Promise.all([
      s.admin.post(url, { decision: { kind: 'approve' } }),
      s.admin.post(url, { decision: { kind: 'reject', reason: 'second thoughts' } }),
    ])
    const codes = results.map((r) => r.statusCode).sort()
    expect(codes).toEqual([200, 409])
    const loser = results.find((r) => r.statusCode === 409)!.json()
    const winner = results.find((r) => r.statusCode === 200)!.json()
    expect(loser.error).toBe('already_resolved')
    expect(loser.details.approval.status).toBe(winner.approval.status)

    const resolvedEvents = await t.db.sql`select * from events where type = 'approval.resolved'`
    expect(resolvedEvents).toHaveLength(1)
    const tasks = await t.db.sql`select id from tasks where delivery_id = ${delivery.id}`
    expect(tasks.length).toBe(winner.approval.status === 'approved' ? 3 : 0)
  })

  it('admins cannot answer approvals they are not listed on', async () => {
    const { approval } = await submitted()
    await t.db.sql`update approvals set allowed_decider_ids = '{}' where id = ${approval.id}`
    expect(
      (await s.admin.post(`/api/approvals/${approval.id}/resolve`, { decision: { kind: 'approve' } }))
        .statusCode,
    ).toBe(403)
  })

  it('an edit after submission makes the old approval stale', async () => {
    const { rev, approval } = await submitted()
    await s.admin.patch(`/api/plans/${rev.id}`, { expectedVersion: 1, planMarkdown: 'changed after review' })
    const res = await s.admin.post(`/api/approvals/${approval.id}/resolve`, { decision: { kind: 'approve' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('already_resolved')
    expect(res.json().details.approval.status).toBe('stale')
  })

  it('an expired request is closed, never treated as consent', async () => {
    const { rev, approval } = await submitted()
    await t.db.sql`update approvals set expires_at = now() - interval '1 second' where id = ${approval.id}`
    const res = await s.admin.post(`/api/approvals/${approval.id}/resolve`, { decision: { kind: 'approve' } })
    expect(res.statusCode).toBe(410)
    const [after] = await t.db.sql`select status from approvals where id = ${approval.id}`
    expect(after!.status).toBe('expired')
    const [revision] = await t.db.sql`select state from plan_revisions where id = ${rev.id}`
    expect(revision!.state).toBe('proposed')
  })
})

describe('setup checklist', () => {
  it('reports which first-run steps are done over the projects a user can see', async () => {
    const steps = async (c: typeof s.admin) => (await c.get('/api/setup')).json()
    expect(await steps(s.admin)).toEqual({
      projectId: s.project.id,
      steps: { project: true, repository: true, runner: false, profile: false, delivery: false },
    })
    const outsider = await t.login('zed')
    expect((await steps(outsider)).steps).toEqual({
      project: false,
      repository: false,
      runner: false,
      profile: false,
      delivery: false,
    })

    await s.admin.post('/api/deliveries', newDelivery('key-setup'))
    const runner = await enrolRunner(s.admin, t.app)
    await t.db.sql`update runners set status = 'online' where id = ${runner.runnerId}`
    expect((await steps(s.member)).steps).toMatchObject({ runner: true, delivery: true })
    expect((await steps(outsider)).steps.delivery).toBe(false)
  })
})

describe('project members', () => {
  it('lets owners remove members but never the last owner', async () => {
    const members = async () =>
      (await s.admin.get(`/api/projects/${s.project.id}`)).json().members as {
        id: string
        login: string
        role: string
      }[]
    const mia = (await members()).find((m) => m.login === 'mia')!
    const admin = (await members()).find((m) => m.login === 'admin')!
    expect((await s.member.post(`/api/projects/${s.project.id}/members/${admin.id}/remove`)).statusCode).toBe(
      403,
    )
    expect((await s.admin.post(`/api/projects/${s.project.id}/members/${admin.id}/remove`)).statusCode).toBe(
      409,
    )
    expect((await s.admin.post(`/api/projects/${s.project.id}/members/${mia.id}/remove`)).statusCode).toBe(
      200,
    )
    expect((await members()).map((m) => m.login)).toEqual(['admin', 'vic'])
    expect((await s.member.get(`/api/projects/${s.project.id}`)).statusCode).toBe(403)
  })
})
