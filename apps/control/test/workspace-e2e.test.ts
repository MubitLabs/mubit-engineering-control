import { execFileSync } from 'node:child_process'
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
let runner: Runner

beforeEach(async () => {
  t = await createTestApp({ config: { artifactsDir: await mkdtemp(path.join(tmpdir(), 'mec-artifacts-')) } })
  s = await seedProject(t)
  url = await t.app.listen({ host: '127.0.0.1', port: 0 })
  home = await mkdtemp(path.join(tmpdir(), 'mec-runner-'))
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
      git: { token: null, authorName: 'MEC test', authorEmail: 'mec@example.com', push: true },
    },
    silentLogger,
  )
  await runner.start()
  await waitFor(() => runner.connection.ready, 5_000, 'runner ready')
})
afterEach(async () => {
  await runner.stop()
  await t.close()
})

const task = (key: string, acceptanceChecks = ['test']) => ({
  key,
  title: `Task ${key}`,
  objective: 'make a change',
  acceptanceChecks,
  requirementIds: ['R1'],
  ownedPaths: ['src'],
})

async function run(taskKey: string, tasks: unknown[], script: unknown[]) {
  const { delivery, tasks: byKey } = await approvedDelivery(s, tasks)
  const res = await s.admin.post(`/api/tasks/${byKey[taskKey]!.id}/attempts`, {
    runnerId: runner.config.runnerId,
    script,
  })
  expect(res.statusCode).toBe(201)
  const attemptId = res.json().attempt.id as string
  await waitFor(
    async () => {
      const [a] = await t.db.sql`select state from attempts where id = ${attemptId}`
      return ['succeeded', 'checks_failed', 'failed'].includes(a!.state as string)
    },
    20_000,
    'attempt finished',
  )
  const detail = (await s.admin.get(`/api/attempts/${attemptId}`)).json()
  return { delivery, attemptId, taskId: byKey[taskKey]!.id, ...detail }
}

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim()

describe('workspaces and checks', () => {
  it('runs the agent in a worktree on the pinned base, captures the diff and checks that exact SHA', async () => {
    const mainSha = gitIn(s.fixture.dir, 'rev-parse', 'HEAD')
    const r = await run(
      'T1',
      [task('T1')],
      [
        { write: { path: 'src/audit.js', content: 'export const audit = []\n' } },
        { write: { path: 'REQUIRED_FILES', content: 'src/audit.js\n' } },
      ],
    )
    expect(r.attempt.state).toBe('succeeded')
    expect(r.attempt.baseSha).toBe(mainSha)
    expect(r.attempt.branch).toBe(`mec/${r.delivery.id.slice(0, 8)}/T1/a1`)
    expect(r.attempt.diff).toMatchObject({ insertions: 2, fileCount: 2 })
    expect(r.attempt.headSha).not.toBe(mainSha)

    const [delivery] = await t.db.sql`select base_sha from deliveries where id = ${r.delivery.id}`
    expect(delivery!.baseSha).toBe(mainSha)

    expect(r.checks).toHaveLength(1)
    expect(r.checks[0]).toMatchObject({
      name: 'test',
      status: 'passed',
      exitCode: 0,
      testedSha: r.attempt.headSha,
    })
    const log = await s.admin.get(`/api/artifacts/${r.checks[0].logArtifactId}`)
    expect(log.statusCode).toBe(200)
    expect(log.headers['x-content-type-options']).toBe('nosniff')
    expect(log.body).toContain('ok src/audit.js')
    const patch = r.artifacts.find((a: { kind: string }) => a.kind === 'patch')
    expect((await s.admin.get(`/api/artifacts/${patch.id}`)).body).toContain('+export const audit = []')

    // The worktree is on its own branch; the pushed branch is visible on the remote.
    expect(gitIn(path.join(home, 'work', r.attemptId), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      r.attempt.branch,
    )
    expect(gitIn(s.fixture.dir, 'rev-parse', `refs/heads/${r.attempt.branch}`)).toBe(r.attempt.headSha)
    const [task_] = await t.db.sql`select state from tasks where id = ${r.taskId}`
    expect(task_!.state).toBe('awaiting_review')
  })

  it('distinguishes a failing check from one that could not start', async () => {
    await s.admin.post(`/api/projects/${s.project.id}/repositories`, {
      name: 'broken',
      cloneUrl: s.fixture.url,
      validationProfile: {
        checks: [
          { name: 'test', argv: ['node', 'checks/fail.mjs'], timeoutSec: 30 },
          { name: 'lint', argv: ['definitely-not-a-binary-xyz'], timeoutSec: 30 },
        ],
      },
    })
    const [repo] = await t.db.sql`select id from repositories where name = 'broken'`
    s.repo = { ...s.repo, id: repo!.id }
    const r = await run('T1', [task('T1', ['test', 'lint'])], [{ say: 'nothing to do' }])
    expect(r.attempt.state).toBe('checks_failed')
    const byName = Object.fromEntries(r.checks.map((c: { name: string }) => [c.name, c]))
    expect(byName.test).toMatchObject({ status: 'failed', exitCode: 3 })
    expect(byName.lint).toMatchObject({ status: 'error', exitCode: null })
    const [task_] = await t.db.sql`select state, attempts_used from tasks where id = ${r.taskId}`
    expect(task_).toMatchObject({ state: 'ready', attemptsUsed: 1 })
  })

  it('keeps later attempts on the pinned base after main moves', async () => {
    const pinned = gitIn(s.fixture.dir, 'rev-parse', 'HEAD')
    const tasks = [task('T1'), task('T2')]
    const { tasks: byKey, delivery } = await approvedDelivery(s, tasks)
    const first = (
      await s.admin.post(`/api/tasks/${byKey.T1!.id}/attempts`, {
        runnerId: runner.config.runnerId,
        script: [],
      })
    ).json()
    await waitFor(
      async () => (await t.db.sql`select base_sha from deliveries where id = ${delivery.id}`)[0]!.baseSha,
    )
    s.fixture.commit({ 'moved.txt': 'main moved on' })
    const second = (
      await s.admin.post(`/api/tasks/${byKey.T2!.id}/attempts`, {
        runnerId: runner.config.runnerId,
        script: [],
      })
    ).json()
    for (const id of [first.attempt.id, second.attempt.id]) {
      await waitFor(
        async () => (await t.db.sql`select state from attempts where id = ${id}`)[0]!.state === 'succeeded',
        20_000,
      )
    }
    const bases = await t.db.sql`select base_sha from attempts where delivery_id = ${delivery.id}`
    expect(bases.map((b) => b.baseSha)).toEqual([pinned, pinned])
    expect(existsSync(path.join(home, 'work', second.attempt.id, 'moved.txt'))).toBe(false)
  })

  it('fails clearly when bootstrap cannot run', async () => {
    await s.admin.post(`/api/projects/${s.project.id}/repositories`, {
      name: 'nobootstrap',
      cloneUrl: s.fixture.url,
      validationProfile: {
        bootstrap: [{ name: 'install', argv: ['node', '-e', 'process.exit(7)'], timeoutSec: 30 }],
        checks: [{ name: 'test', argv: ['node', '-e', '0'], timeoutSec: 30 }],
      },
    })
    const [repo] = await t.db.sql`select id from repositories where name = 'nobootstrap'`
    s.repo = { ...s.repo, id: repo!.id }
    const r = await run('T1', [task('T1')], [{ say: 'unreachable' }])
    expect(r.attempt.state).toBe('failed')
    expect(r.attempt.result).toMatchObject({ reason: 'bootstrap_failed' })
  })
})
