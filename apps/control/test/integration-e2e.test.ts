import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runner, silentLogger } from '@mec/runner'
import { waitFor } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitHubApi } from '../src/features/integration/github'
import { approvedDelivery, createTestApp, enrolRunner, seedProject, type TestApp } from './helpers/app'

let t: TestApp
let s: Awaited<ReturnType<typeof seedProject>>
let runner: Runner
let home: string
let merged = false
const pulls: { head: string; base: string; title: string; body: string }[] = []

const fakeGitHub: GitHubApi = {
  supports: () => true,
  async createPull(_url, input) {
    pulls.push(input)
    return {
      number: 7,
      url: 'https://github.com/MubitLabs/mec-sandbox/pull/7',
      headSha: 'a'.repeat(40),
      state: 'open',
      merged: false,
      mergedAt: null,
    }
  },
  async getPull() {
    return {
      number: 7,
      url: 'https://github.com/MubitLabs/mec-sandbox/pull/7',
      headSha: 'a'.repeat(40),
      state: merged ? 'closed' : 'open',
      merged,
      mergedAt: merged ? new Date().toISOString() : null,
    }
  },
  async checks() {
    return { total: 1, completed: 1, failed: 0, conclusion: 'success' }
  },
}

beforeEach(async () => {
  merged = false
  pulls.length = 0
  t = await createTestApp({ githubApi: fakeGitHub })
  s = await seedProject(t)
  const url = await t.app.listen({ host: '127.0.0.1', port: 0 })
  home = await mkdtemp(path.join(tmpdir(), 'mec-runner-'))
  const creds = await enrolRunner(s.admin, t.app)
  runner = new Runner(
    {
      controlUrl: url,
      runnerId: creds.runnerId,
      token: creds.token,
      home,
      maxAttempts: 3,
      heartbeatMs: 300,
      logLevel: 'error',
      git: { token: null, authorName: 'MEC test', authorEmail: 'mec@example.com', push: true },
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

const task = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  objective: `Implement ${key}`,
  requirementIds: ['R1'],
  acceptanceChecks: ['test'],
  ownedPaths: [`src/${key.toLowerCase()}`],
  ...extra,
})
const write = (p: string, content: string) => ({ write: { path: p, content } })

const taskState = async (id: string) => (await t.db.sql`select state from tasks where id = ${id}`)[0]!.state
const latestAttempt = async (taskId: string) =>
  (await t.db.sql`select * from attempts where task_id = ${taskId} order by number desc limit 1`)[0]!

async function runTask(taskId: string, script: unknown[]) {
  const res = await s.admin.post(`/api/tasks/${taskId}/attempts`, {
    runnerId: runner.config.runnerId,
    script,
  })
  expect([200, 201]).toContain(res.statusCode)
  await waitFor(
    async () => ['awaiting_review', 'ready', 'failed'].includes((await taskState(taskId)) as string),
    20_000,
    'attempt done',
  )
  return latestAttempt(taskId)
}

async function review(taskId: string, decision: Record<string, unknown>) {
  const approval = await waitFor(async () => {
    const [a] = await t.db
      .sql`select id from approvals where task_id = ${taskId} and kind = 'result' and status = 'pending'`
    return a
  })
  const res = await s.admin.post(`/api/approvals/${approval.id}/resolve`, { decision })
  expect(res.statusCode).toBe(200)
}

/** Drives the integrator until the task is integrated (or sent back). */
async function integrate(taskId: string, until: string[] = ['integrated']) {
  await waitFor(
    async () => {
      await t.app.services.integrator.tick()
      return until.includes((await taskState(taskId)) as string)
    },
    30_000,
    `task ${until.join('/')}`,
  )
}

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim()

describe('review', () => {
  it('accepting records the exact commit; only the delivery owner may decide', async () => {
    const { tasks } = await approvedDelivery(s, [task('T1')])
    const attempt = await runTask(tasks.T1!.id, [write('src/t1/a.txt', 'one')])
    const [approval] = await t.db
      .sql`select * from approvals where task_id = ${tasks.T1!.id} and kind = 'result'`
    expect(approval).toMatchObject({ status: 'pending', bindingHash: attempt.headSha })
    expect(
      (await s.member.post(`/api/approvals/${approval!.id}/resolve`, { decision: { kind: 'approve' } }))
        .statusCode,
    ).toBe(403)
    await review(tasks.T1!.id, { kind: 'approve' })
    const [row] = await t.db.sql`select state, accepted_sha from tasks where id = ${tasks.T1!.id}`
    expect(row).toMatchObject({ state: 'accepted', acceptedSha: attempt.headSha })
  })

  it('sending back starts a repair that continues from the previous commit, reviewed against the base', async () => {
    const { tasks } = await approvedDelivery(s, [task('T1')])
    const first = await runTask(tasks.T1!.id, [write('src/t1/a.txt', 'draft')])
    await review(tasks.T1!.id, { kind: 'reject', reason: 'also add b.txt' })
    expect(await taskState(tasks.T1!.id)).toBe('ready')

    const second = await runTask(tasks.T1!.id, [write('src/t1/b.txt', 'second')])
    expect(second).toMatchObject({ kind: 'repair', number: 2, baseSha: first.headSha })
    expect(second.inputs.repair).toMatchObject({ reason: 'review_sent_back', previousAttemptId: first.id })
    expect(second.inputs.repair.notes).toContain('also add b.txt')
    expect(second.diff.baseSha).toBe(first.baseSha)
    expect(second.diff.files.map((f: { path: string }) => f.path).sort()).toEqual([
      'src/t1/a.txt',
      'src/t1/b.txt',
    ])
  })

  it('failed checks give the next attempt the exact failures', async () => {
    const { tasks } = await approvedDelivery(s, [task('T1')])
    const first = await runTask(tasks.T1!.id, [write('REQUIRED_FILES', 'src/t1/missing.txt\n')])
    expect(first.state).toBe('checks_failed')
    const [row] = await t.db.sql`select state, repair_context from tasks where id = ${tasks.T1!.id}`
    expect(row!.state).toBe('ready')
    expect(row!.repairContext).toMatchObject({ reason: 'checks_failed', startSha: first.headSha })
    expect(row!.repairContext.failures[0]).toMatchObject({ name: 'test', status: 'failed' })
    expect(row!.repairContext.failures[0].logTail).toContain('missing src/t1/missing.txt')
  })
})

describe('integration', () => {
  it('integrates accepted tasks one at a time, checks the exact merge SHA, opens the PR, and records the merge only from GitHub', async () => {
    const { delivery, tasks } = await approvedDelivery(s, [
      task('T1'),
      task('T2', { requirementIds: ['R2'] }),
    ])
    await runTask(tasks.T1!.id, [write('src/t1/a.txt', 'one')])
    await runTask(tasks.T2!.id, [write('src/t2/b.txt', 'two')])
    await review(tasks.T1!.id, { kind: 'approve' })
    await review(tasks.T2!.id, { kind: 'approve' })

    await integrate(tasks.T1!.id)
    const [afterFirst] = await t.db.sql`select integration_sha from deliveries where id = ${delivery.id}`
    await integrate(tasks.T2!.id)
    const [d] = await t.db
      .sql`select integration_sha, integration_pushed_sha, state from deliveries where id = ${delivery.id}`
    expect(d!.integrationSha).not.toBe(afterFirst!.integrationSha)
    expect(d!.integrationPushedSha).toBe(d!.integrationSha)

    // Integration checks ran on the exact resulting SHA, which is on the remote branch.
    const checks = await t.db.sql`
      select tested_sha, name, status from check_results
      where delivery_id = ${delivery.id} and scope = 'integration' order by created_at
    `
    expect([...new Set(checks.map((c) => c.testedSha))]).toEqual([
      afterFirst!.integrationSha,
      d!.integrationSha,
    ])
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'test:passed',
      'lint:passed',
      'test:passed',
      'lint:passed',
    ])
    const branch = `mec/${delivery.id.slice(0, 8)}/integration`
    expect(gitIn(s.fixture.dir, 'rev-parse', `refs/heads/${branch}`)).toBe(d!.integrationSha)
    const tree = gitIn(s.fixture.dir, 'ls-tree', '-r', '--name-only', d!.integrationSha as string)
    expect(tree.split('\n')).toEqual(expect.arrayContaining(['src/t1/a.txt', 'src/t2/b.txt']))

    await waitFor(async () => {
      await t.app.services.integrator.tick()
      return (
        (await t.db.sql`select state from deliveries where id = ${delivery.id}`)[0]!.state ===
        'awaiting_merge'
      )
    })
    expect(pulls).toHaveLength(1)
    expect(pulls[0]).toMatchObject({ head: branch, base: 'main', title: 'Audit log' })
    expect(pulls[0]!.body).toContain(`### Checks on \`${String(d!.integrationSha).slice(0, 12)}\``)
    expect(pulls[0]!.body).toContain('**T1** Task T1')

    await t.app.services.integrator.pollPulls()
    expect((await t.db.sql`select state from deliveries where id = ${delivery.id}`)[0]!.state).toBe(
      'awaiting_merge',
    )
    merged = true
    await t.app.services.integrator.pollPulls()
    expect((await t.db.sql`select state from deliveries where id = ${delivery.id}`)[0]!.state).toBe('merged')
    expect(
      (await t.db.sql`select state from pull_requests where delivery_id = ${delivery.id}`)[0]!.state,
    ).toBe('merged')
  })

  it('retries an integration push on request, then opens the PR', async () => {
    const git = (runner as unknown as { workspaces: { settings: { push: boolean } } }).workspaces.settings
    git.push = false
    const { delivery, tasks } = await approvedDelivery(s, [task('T1')])
    await runTask(tasks.T1!.id, [write('src/t1/a.txt', 'one')])
    await review(tasks.T1!.id, { kind: 'approve' })
    await integrate(tasks.T1!.id)
    await waitFor(async () => {
      await t.app.services.integrator.tick()
      return (
        (await t.db.sql`select state from deliveries where id = ${delivery.id}`)[0]!.state === 'integrating'
      )
    })
    const detail = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json()
    expect(detail.nextStep).toMatch(/not pushed/)
    expect(pulls).toHaveLength(0)

    git.push = true
    expect((await s.member.post(`/api/deliveries/${delivery.id}/push-integration`)).statusCode).toBe(403)
    expect((await s.admin.post(`/api/deliveries/${delivery.id}/push-integration`)).statusCode).toBe(200)
    expect((await s.admin.post(`/api/deliveries/${delivery.id}/push-integration`)).statusCode).toBe(409)
    await waitFor(
      async () => {
        const [d] = await t.db
          .sql`select integration_sha, integration_pushed_sha from deliveries where id = ${delivery.id}`
        return d!.integrationPushedSha === d!.integrationSha
      },
      20_000,
      'pushed',
    )
    await waitFor(async () => {
      await t.app.services.integrator.tick()
      return (
        (await t.db.sql`select state from deliveries where id = ${delivery.id}`)[0]!.state ===
        'awaiting_merge'
      )
    })
    expect(pulls).toHaveLength(1)
  })

  it('a dependent task starts from the integration commit that contains its prerequisite', async () => {
    const { delivery, tasks } = await approvedDelivery(s, [
      task('T1'),
      task('T2', { dependsOn: ['T1'], requirementIds: ['R2'] }),
    ])
    expect(await taskState(tasks.T2!.id)).toBe('approved')
    await runTask(tasks.T1!.id, [write('src/t1/api.txt', 'contract')])
    await review(tasks.T1!.id, { kind: 'approve' })
    await integrate(tasks.T1!.id)
    expect(await taskState(tasks.T2!.id)).toBe('ready')

    const t2 = await runTask(tasks.T2!.id, [write('src/t2/ui.txt', 'uses api')])
    const [d] = await t.db.sql`select integration_sha from deliveries where id = ${delivery.id}`
    expect(t2.baseSha).toBe(d!.integrationSha)
    expect(existsSync(path.join(home, 'work', t2.id, 'src/t1/api.txt'))).toBe(true)
  })

  it('a merge conflict sends the task back with both changes in its repair worktree', async () => {
    const { tasks } = await approvedDelivery(s, [task('T1'), task('T2', { requirementIds: ['R2'] })])
    await runTask(tasks.T1!.id, [write('src/shared.txt', 'from T1')])
    await runTask(tasks.T2!.id, [write('src/shared.txt', 'from T2')])
    await review(tasks.T1!.id, { kind: 'approve' })
    await review(tasks.T2!.id, { kind: 'approve' })
    await integrate(tasks.T1!.id)
    await integrate(tasks.T2!.id, ['ready'])

    const [row] = await t.db.sql`select repair_context from tasks where id = ${tasks.T2!.id}`
    expect(row!.repairContext).toMatchObject({
      reason: 'integration_conflict',
      conflicts: ['src/shared.txt'],
    })

    // The repair starts on the integration commit with T2's change mid-merge, resolves it, and integrates.
    const repair = await runTask(tasks.T2!.id, [write('src/shared.txt', 'from T1 and T2')])
    expect(repair.kind).toBe('repair')
    const wt = path.join(home, 'work', repair.id)
    expect(gitIn(wt, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(readFileSync(path.join(wt, 'src/shared.txt'), 'utf8')).toBe('from T1 and T2')
    await review(tasks.T2!.id, { kind: 'approve' })
    await integrate(tasks.T2!.id)
  })
})
