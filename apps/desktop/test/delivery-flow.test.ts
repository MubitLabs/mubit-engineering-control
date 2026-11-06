// M2.3 through the real server: a real store, queue and processes through the fake CLI, a fake gh
// first on PATH, and real git against a local bare repository. The planner is scripted, so nothing
// here spends. One message goes in; nobody sends a second.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoreDoc } from '@mec/contracts'
import { integrationDocId, type MetaBrain, type MetaPlanTask } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'

const REPO = 'repo_a'
const SLUG = 'owner/repo'
const URL_ON_GITHUB = `https://github.com/${SLUG}`
const POLICY = '{"preAuthorised":{}}'
const PR = 7

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

describe('through the real server (fake CLI, fake gh, no engine run)', () => {
  const FAKE_CLI = fileURLToPath(new URL('../../../packages/testkit/fake-cli/claude', import.meta.url))
  const REAL_PATH = process.env.PATH
  const closers: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    process.env.PATH = REAL_PATH
    process.env.MEC_REAL_RUNNER = '0'
    delete process.env.GIT_CONFIG_GLOBAL
  })

  const FAKE_GH = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/gh.log"
case "$*" in
  "repo view"*) echo '{"url":"${URL_ON_GITHUB}","defaultBranchRef":{"name":"main"}}' ;;
  "pr list"*) echo '[]' ;;
  "api repos/${SLUG}/branches"*) ;;
  *"/git/ref/heads/"*) git -C "$(dirname "$0")/../github.git" rev-parse "refs/heads/\${2##*/git/ref/heads/}" ;;
  "pr create"*) echo "${URL_ON_GITHUB}/pull/${PR}" ;;
  *) exit 1 ;;
esac
`

  async function serve(
    tasks: MetaPlanTask[],
    checks: { name: string; cmd: string }[],
    steps: unknown[] = [{ init: true }, { sh: 'echo made > "$MEC_ATTEMPT_ID.txt"' }, { result: 'completed' }],
    bootstrap: string[] = [],
  ) {
    const root = mkdtempSync(join(tmpdir(), 'mec-delivery-e2e-'))
    roots.push(root)
    const dataDir = join(root, 'state')
    mkdirSync(dataDir)
    const bare = join(root, 'github.git')
    gitIn(root, 'init', '--quiet', '--bare', '-b', 'main', bare)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    gitIn(repo, 'init', '--quiet', '-b', 'main')
    gitIn(repo, 'config', 'user.name', 'Repo Owner')
    gitIn(repo, 'config', 'user.email', 'owner@example.com')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    gitIn(repo, 'add', '--all')
    gitIn(repo, 'commit', '--quiet', '-m', 'baseline')
    gitIn(repo, 'remote', 'add', 'origin', bare)
    gitIn(repo, 'push', '--quiet', 'origin', 'main')
    gitIn(repo, 'remote', 'set-url', 'origin', `git@github.com:${SLUG}.git`)
    const gitconfig = join(root, 'gitconfig')
    writeFileSync(gitconfig, `[url "${bare}"]\n\tinsteadOf = ${URL_ON_GITHUB}\n`)
    process.env.GIT_CONFIG_GLOBAL = gitconfig

    const bin = join(root, 'bin')
    mkdirSync(bin)
    copyFileSync(FAKE_CLI, join(bin, 'claude'))
    writeFileSync(join(bin, 'gh'), FAKE_GH)
    chmodSync(join(bin, 'gh'), 0o755)
    writeFileSync(join(bin, 'scenario.json'), JSON.stringify({ steps }))
    process.env.PATH = `${bin}:${REAL_PATH}`
    process.env.MEC_REAL_RUNNER = '1'

    const db = new Database(join(dataDir, 'mec.db'))
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    store.atomic(() => {
      store.engines.save({ id: REPO, url: repo, bootstrap, checks, trust: false })
      store.slots.save({
        id: 'slot_linked',
        engine: 'claude',
        kind: 'claude-sub',
        home: '/nowhere',
        state: 'healthy',
        env: {},
        concurrency: 2,
      })
    })
    db.close()

    let turns = 0
    const brain: MetaBrain = async () => {
      turns += 1
      return turns === 1 ? { ack: 'On it', plan: { tasks } } : { ack: 'ok' }
    }
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 4000, brain })
    closers.push(server.close)
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }
    const read = <T>(fn: (store: SqliteStore) => T): T => {
      const open = new Database(join(dataDir, 'mec.db'))
      try {
        return fn(new SqliteStore(open))
      } finally {
        open.close()
      }
    }
    const get = async (path: string) =>
      (await (await fetch(`${server.url}${path}`)).json()) as Record<string, unknown>
    return { post, get, read, bin, bare }
  }

  // A fresh script's first exec has taken 25 s on this machine late in a run (M2.2's record).
  async function until(test: () => boolean, ms = 120_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!test()) {
      if (Date.now() > deadline) throw new Error('condition never held')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  const task = (taskId: string, dependsOn: string[] = []): MetaPlanTask => ({
    taskId,
    objective: `do ${taskId}`,
    dependsOn,
    role: 'implementer',
  })

  it('a chain of integration tasks runs to a push card, then a PR card, with one message', async () => {
    const checks = [{ name: 'unit', cmd: 'test -f a.txt' }]
    const r = await serve([task('first'), task('second', ['first']), task('third', ['second'])], checks)
    await r.post('/api/chat/messages', { text: 'Add the audit log', repoId: REPO })

    const pushCards = () => r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'push'))
    await until(() => pushCards().length === 1)
    const facts = r.read((store) => {
      const work = store.workItems.list()[0] as StoreDoc
      const integration = store.engines.get(integrationDocId(String(work.id))) as StoreDoc
      return { work, integration, attempts: store.attempts.list(), tasks: store.tasks.list() }
    })
    expect(facts.work.state).toBe('integrating')
    expect(facts.tasks.map((doc) => doc.status)).toEqual(['integrated', 'integrated', 'integrated'])
    const integrated = facts.integration.integrated as Record<string, string>
    const first = facts.tasks.find((doc) => doc.localKey === 'first') as StoreDoc
    const second = facts.tasks.find((doc) => doc.localKey === 'second') as StoreDoc
    const attemptOf = (doc: StoreDoc) => facts.attempts.find((row) => row.taskId === doc.id) as StoreDoc
    // An integration dependent starts from the commit its prerequisite integrated at.
    expect(attemptOf(second).base_sha).toBe(integrated[String(first.id)])
    expect(attemptOf(first).base_sha).toBe(facts.work.base_sha)
    expect(pushCards()[0]).toMatchObject({ status: 'pending', inputSha: facts.integration.head })

    const approved = await r.post(`/api/inbox/${String(pushCards()[0]?.id)}/resolve`, { answer: 'approve' })
    expect(approved.body).toMatchObject({ status: 'approved', pushed: true })
    const prCards = () =>
      r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'pr_create'))
    await until(() => prCards().length === 1)
    expect(
      gitIn(r.bare, 'rev-parse', `refs/heads/mec/${String(facts.work.id).slice(3, 11)}/integration`),
    ).toBe(facts.integration.head)
    expect(readFileSync(join(r.bin, 'gh.log'), 'utf8')).not.toContain('pr create')
  }, 200_000)

  it('a conflict is repaired mid-merge by a repair task, and the result has two parents', async () => {
    const sh =
      'case "$MEC_ATTEMPT_ID" in att_3) echo both > a.txt ;; *) echo "$MEC_ATTEMPT_ID" > a.txt ;; esac'
    const contract = (taskId: string): MetaPlanTask => ({ ...task(taskId), basePolicy: 'contract' })
    const r = await serve(
      [contract('left'), contract('right')],
      [{ name: 'unit', cmd: 'test -f a.txt' }],
      [{ init: true }, { sh }, { result: 'completed' }],
    )
    await r.post('/api/chat/messages', { text: 'Add the audit log', repoId: REPO })
    const cards = () => r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'push'))
    await until(() => cards().length === 1)
    const facts = r.read((store) => {
      const work = store.workItems.list()[0] as StoreDoc
      const integration = store.engines.get(integrationDocId(String(work.id))) as StoreDoc
      return { integration, attempts: store.attempts.list(), tasks: store.tasks.list() }
    })
    const repair = facts.tasks.find((doc) => doc.repairOf !== undefined) as StoreDoc
    expect(repair).toMatchObject({ role: 'repair_agent', status: 'integrated' })
    expect(facts.tasks.map((doc) => doc.status)).toEqual(['integrated', 'integrated', 'integrated'])
    const worktree = String(facts.integration.worktree)
    expect(facts.attempts.find((doc) => doc.taskId === repair.id)?.worktree).toBe(worktree)
    const head = String(facts.integration.head)
    expect(gitIn(worktree, 'rev-parse', 'HEAD')).toBe(head)
    expect(gitIn(worktree, 'rev-parse', 'HEAD^@').split('\n')).toHaveLength(2)
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('both\n')
    expect(facts.integration.combined).toMatchObject({ sha: head, passed: true })
  }, 200_000)

  it('a sensitive task gets a read-only reviewer on its head, and only then integrates', async () => {
    const ready = { call: { tool: 'report', args: { kind: 'ready', summary: 'done' } } }
    const sensitive: MetaPlanTask = { ...task('only'), sensitive: true }
    const r = await serve(
      [sensitive],
      [{ name: 'unit', cmd: 'test -f a.txt' }],
      [{ init: true }, { sh: 'echo made > "$MEC_ATTEMPT_ID.txt"; true' }, ready, { result: 'completed' }],
    )
    await r.post('/api/chat/messages', { text: 'Rotate the signing key', repoId: REPO })
    await until(() => r.read((store) => store.tasks.list()[0]?.status) === 'integrated')
    const attempts = r.read((store) => store.attempts.list())
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toMatchObject({
      role: 'code_reviewer',
      state: 'succeeded',
      worktree: attempts[0]?.worktree,
    })
    expect(attempts[1]?.head_sha).not.toBe(attempts[0]?.base_sha)
  }, 200_000)

  it('a repair attempt fixes failed checks in the same worktree, and no one is asked', async () => {
    // Red until a file only the second attempt writes is there.
    const checks = [{ name: 'unit', cmd: 'test -f att_2.txt' }]
    const r = await serve([task('only')], checks)
    await r.post('/api/chat/messages', { text: 'Add the audit log', repoId: REPO })
    await until(() => r.read((store) => store.tasks.list()[0]?.status) === 'integrated')
    const attempts = r.read((store) => store.attempts.list())
    expect(attempts.map((doc) => doc.state)).toEqual(['checks_failed', 'succeeded'])
    expect(attempts[1]).toMatchObject({
      role: 'repair_agent',
      worktree: attempts[0]?.worktree,
      branch: attempts[0]?.branch,
    })
  }, 200_000)

  /** `npm install` in a repository with no lockfile: it writes a file nothing ignores. */
  const LOCKFILE_BOOTSTRAP = ['cp a.txt package-lock.json']
  const LOCK = 'package-lock.json'

  it('a file the bootstrap wrote reaches no task commit, and integration gets to the push card', async () => {
    const checks = [{ name: 'unit', cmd: `test -f ${LOCK}` }]
    const r = await serve([task('first'), task('second', ['first'])], checks, undefined, LOCKFILE_BOOTSTRAP)
    await r.post('/api/chat/messages', { text: 'Add the audit log', repoId: REPO })
    const cards = () => r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'push'))
    const state = () => r.read((store) => store.workItems.list()[0]?.state)
    await until(() => cards().length === 1 || state() === 'blocked')
    const facts = r.read((store) => ({
      work: store.workItems.list()[0] as StoreDoc,
      tasks: store.tasks.list(),
      integration: store.engines.list().find((doc) => String(doc.id).startsWith('integration/')) as StoreDoc,
    }))
    expect(facts.work.blockedReason).toBeUndefined()
    expect(facts.tasks.map((doc) => doc.status)).toEqual(['integrated', 'integrated'])
    const worktree = String(facts.integration.worktree)
    for (const doc of facts.tasks) {
      const head = String(doc.acceptedHead)
      expect(gitIn(worktree, 'ls-tree', '-r', '--name-only', head)).not.toContain(LOCK)
    }
    expect(gitIn(worktree, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain(LOCK)
    // The bootstrap's file is still what the checks ran beside.
    expect(readFileSync(join(worktree, LOCK), 'utf8')).toBe('one\n')
    expect(facts.integration.combined).toMatchObject({ passed: true })
  }, 200_000)

  it("a bootstrap file the specialist changed is the specialist's, and it merges over the bootstrap's", async () => {
    const steps = [{ init: true }, { sh: `echo chosen > ${LOCK}` }, { result: 'completed' }]
    const checks = [{ name: 'unit', cmd: 'test -f a.txt' }]
    const r = await serve([task('only')], checks, steps, LOCKFILE_BOOTSTRAP)
    await r.post('/api/chat/messages', { text: 'Pin the lockfile', repoId: REPO })
    const cards = () => r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'push'))
    const state = () => r.read((store) => store.workItems.list()[0]?.state)
    await until(() => cards().length === 1 || state() === 'blocked')
    const facts = r.read((store) => ({
      work: store.workItems.list()[0] as StoreDoc,
      integration: store.engines.list().find((doc) => String(doc.id).startsWith('integration/')) as StoreDoc,
    }))
    expect(facts.work.blockedReason).toBeUndefined()
    const worktree = String(facts.integration.worktree)
    expect(gitIn(worktree, 'show', `HEAD:${LOCK}`)).toBe('chosen')
    const events = r.read((store) => store.events.read(`work:${String(facts.work.id)}`))
    expect(events.find((event) => event.type === 'integration_output_cleared')?.body).toMatchObject({
      paths: [LOCK],
    })
  }, 200_000)

  it('the retry route opens one new card for a declined push, whoever presses it twice', async () => {
    const r = await serve([task('only')], [{ name: 'unit', cmd: 'test -f a.txt' }])
    await r.post('/api/chat/messages', { text: 'Add the audit log', repoId: REPO })
    const cards = () => r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'push'))
    await until(() => cards().length === 1)
    const id = String(r.read((store) => store.workItems.list()[0]?.id))
    await r.post(`/api/inbox/${String(cards()[0]?.id)}/resolve`, { answer: 'deny' })
    const stage = () => r.read((store) => store.engines.get(`delivery/${id}`)?.stage)
    await until(() => stage() === 'declined')
    const offered = await r.get(`/api/inspect/work/${id}`)
    expect(offered.retry).toEqual({ kind: 'push', reason: 'The push card was denied' })

    await r.post(`/api/work/${id}/hold`, {})
    expect((await r.get(`/api/inspect/work/${id}`)).retry).toBeNull()
    const held = await r.post(`/api/work/${id}/retry`, {})
    expect(held).toMatchObject({ status: 409, body: { error: 'held' } })
    expect(stage()).toBe('declined')
    await r.post(`/api/work/${id}/lift`, {})

    const first = await r.post(`/api/work/${id}/retry`, {})
    const second = await r.post(`/api/work/${id}/retry`, {})
    expect(first).toMatchObject({ status: 200, body: { id, status: 'retrying', kind: 'push' } })
    expect(second).toMatchObject({ status: 409, body: { error: 'nothing_to_retry' } })
    await until(() => cards().length === 2)
    expect(cards().map((card) => card.status)).toEqual(['denied', 'pending'])
    await new Promise((resolve) => setTimeout(resolve, 4500))
    expect(cards()).toHaveLength(2)

    const unknown = await r.post('/api/work/wi_nothing/retry', {})
    expect(unknown.status).toBe(404)
    await r.post(`/api/work/${id}/stop`, {})
    const stopped = await r.post(`/api/work/${id}/retry`, {})
    expect(stopped).toMatchObject({ status: 409, body: { error: 'mandate_withdrawn' } })
  }, 200_000)
})
