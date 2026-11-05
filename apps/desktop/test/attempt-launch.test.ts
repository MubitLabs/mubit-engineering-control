// M2.1's launch path end to end: a seeded queued attempt and launch row, the real server, the
// real queue and a real process through the fake CLI. No planner runs, so nothing here spends.
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Later } from '@mec/contracts'
import { issueToken, MecToolsServer } from '@mec/mec-tools'
import { type MetaBrain, repoFields } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AttemptLauncher, resolveBinary } from '../src/attempt-launch'
import { startServer } from '../src/composition'
import { StoreFacts } from '../src/core-facts'
import { specialistBridge, specialistTools } from '../src/specialist-tools'

const FAKE_CLI = fileURLToPath(new URL('../../../packages/testkit/fake-cli/claude', import.meta.url))
const POLICY = '{"preAuthorised":{}}'
const REAL_PATH = process.env.PATH
const FLAGS = ['MEC_REAL_RUNNER', 'MEC_FAKE_ENGINE'] as const

const roots: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  process.env.PATH = REAL_PATH
  for (const flag of FLAGS) delete process.env[flag]
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

type Scenario = { steps: unknown[] }

type Seed = {
  checks?: { name: string; cmd: string }[]
  bootstrap?: string[]
  slot?: Record<string, unknown>
  task?: Record<string, unknown>
  work?: Record<string, unknown>
}

/** A scratch repo and a fake `claude` first on PATH, as the launch will find it. */
function scratch(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'mec-launch-'))
  roots.push(root)
  const dataDir = join(root, 'state')
  mkdirSync(dataDir)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  gitIn(repo, 'init', '--quiet', '-b', 'main')
  gitIn(repo, 'config', 'user.name', 'Repo Owner')
  gitIn(repo, 'config', 'user.email', 'owner@example.com')
  gitIn(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  gitIn(repo, 'add', '--all')
  gitIn(repo, 'commit', '--quiet', '-m', 'baseline')

  const bin = join(root, 'bin')
  mkdirSync(bin)
  copyFileSync(FAKE_CLI, join(bin, 'claude'))
  writeFileSync(join(bin, 'scenario.json'), JSON.stringify(scenario))
  process.env.PATH = `${bin}:${REAL_PATH}`
  return { root, dataDir, repo, bin, seen: () => JSON.parse(readFileSync(join(bin, 'seen.json'), 'utf8')) }
}

/** The docs a plan commit leaves, plus a repository and a healthy linked slot. */
function seedInto(store: SqliteStore, repo: string, seed: Seed = {}): void {
  store.atomic(() => {
    store.engines.save({
      id: 'repo_a',
      url: repo,
      bootstrap: seed.bootstrap ?? [],
      checks: seed.checks ?? [],
      trust: false,
    })
    store.messages.save({ id: 'msg_1', text: 'please add the thing' })
    store.slots.save({
      id: 'slot_linked',
      engine: 'claude',
      kind: 'claude-sub',
      home: '/nowhere',
      state: 'healthy',
      env: {},
      ...seed.slot,
    })
    store.workItems.save({
      id: 'wi_abcdefghij',
      state: 'executing',
      repoId: 'repo_a',
      pin: repoFields(store, 'repo_a', POLICY).pin as never,
      mandate: { originMessageId: 'msg_1' },
      ...seed.work,
    })
    store.tasks.save({
      id: 'task_1',
      workItemId: 'wi_abcdefghij',
      repoId: 'repo_a',
      status: 'ready',
      role: 'implementer',
      objective: 'add the thing',
      originalRequestRef: 'msg_1',
      acceptanceChecks: ['manual-review'],
      ...seed.task,
    })
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_1',
      workItemId: 'wi_abcdefghij',
      slotId: 'slot_linked',
      state: 'queued',
      generation: 1,
      createdAt: '2026-11-05T10:00:00.000Z',
    })
    store.effects.enqueue('launch', 'att_1:1', {
      attempt_id: 'att_1',
      task_id: 'task_1',
      work_item_id: 'wi_abcdefghij',
      slot_id: 'slot_linked',
      generation: 1,
    })
  })
}

function seedStore(dataDir: string, repo: string, seed: Seed = {}): void {
  const db = new Database(join(dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  seedInto(new SqliteStore(db), repo, seed)
  db.close()
}

async function serve(dataDir: string): Promise<void> {
  const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 4000 })
  closers.push(server.close)
}

/** Reads the store as a second connection would, while the server holds it. */
function peek<T>(dataDir: string, read: (store: SqliteStore, db: Database.Database) => T): T {
  const db = new Database(join(dataDir, 'mec.db'))
  try {
    return read(new SqliteStore(db), db)
  } finally {
    db.close()
  }
}

async function until(test: () => boolean, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const attemptState = (dataDir: string, id = 'att_1'): unknown =>
  peek(dataDir, (store) => store.attempts.get(id)?.state)

const SETTLED = ['succeeded', 'checks_failed', 'failed', 'interrupted']

/** Waits for a state, and fails at once when the attempt has settled on another one. */
async function reaches(dataDir: string, state: string, id = 'att_1'): Promise<void> {
  await until(() => {
    const now = String(attemptState(dataDir, id))
    if (now !== state && SETTLED.includes(now)) {
      const reason = peek(dataDir, (store) => store.attempts.get(id)?.terminal_reason)
      throw new Error(`attempt settled ${now}: ${String(reason)}`)
    }
    return now === state
  })
}

const SUCCESS = [
  { init: true },
  { write: { path: 'made.txt', text: 'made\n' } },
  { saveToken: true },
  { result: 'completed' },
]

/** A planner that does what the real one does: propose through the tools, keep what they accept. */
const proposes =
  (tier: string): MetaBrain =>
  async ({ tools, workItemId }) => {
    tools?.execute('propose_plan', {
      work_item: workItemId,
      tasks: [
        {
          id: 'task_1',
          objective: 'add the thing',
          depends_on: [],
          role: 'implementer',
          model_request: { tier, reason: 'a small change' },
        },
      ],
    })
    const plan = tools?.journal().plan
    return { ack: 'On it.', ...(plan !== undefined && { plan: { tasks: plan.tasks } }) }
  }

/** One repository and these slots, no work: a store a chat request arrives on. */
function seedSlots(dataDir: string, repo: string, slots: Record<string, unknown>[]): void {
  const db = new Database(join(dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  store.atomic(() => {
    store.engines.save({ id: 'repo_a', url: repo, bootstrap: [], checks: [], trust: false })
    for (const slot of slots) store.slots.save(slot as never)
  })
  db.close()
}

const LINKED = {
  id: 'slot_linked',
  engine: 'claude',
  kind: 'claude-sub',
  home: '/nowhere',
  state: 'healthy',
  env: {},
}

const onlyAttempt = (dataDir: string): string =>
  peek(dataDir, (store) => String(store.attempts.list()[0]?.id))

describe('a chat request', { timeout: 60_000 }, () => {
  const request = async (dataDir: string, tier = 'fast') => {
    const server = await startServer({
      dataDir,
      policyText: POLICY,
      closeBoundMs: 4000,
      brain: proposes(tier),
    })
    closers.push(server.close)
    const answer = await fetch(`${server.url}/api/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'please add the thing', repoId: 'repo_a' }),
    })
    expect(answer.status).toBeLessThan(300)
    return (await answer.json()) as { tasksCreated: number; launchesEnqueued: number }
  }

  it('on a Claude-only store creates a task and a launch that reaches the engine', async () => {
    const { dataDir, repo, seen } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [LINKED])
    const turn = await request(dataDir)
    expect(turn.tasksCreated).toBe(1)
    expect(turn.launchesEnqueued).toBe(1)
    await reaches(dataDir, 'work_complete', onlyAttempt(dataDir))
    expect(JSON.stringify(seen())).toContain('haiku')
  })

  it('never lands on an engine this build cannot launch, whatever sorts first', async () => {
    const { root, dataDir, repo } = scratch({ steps: SUCCESS })
    const home = join(root, 'glm')
    mkdirSync(join(home, 'config', 'opencode'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'opencode', 'opencode.json'),
      JSON.stringify({ provider: { 'zai-coding-plan': { models: { 'glm-5.3-flash': {} } } } }),
    )
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [
      LINKED,
      { id: 'slot_a_glm', engine: 'opencode', kind: 'opencode-key', home, state: 'healthy', env: {} },
    ])
    expect((await request(dataDir)).launchesEnqueued).toBe(1)
    const id = onlyAttempt(dataDir)
    await reaches(dataDir, 'work_complete', id)
    expect(peek(dataDir, (store) => store.attempts.get(id)?.slotId)).toBe('slot_linked')
  })

  it('a tier only an unlaunchable slot serves is refused at the plan, not at the launch', async () => {
    const { root, dataDir, repo } = scratch({ steps: SUCCESS })
    const home = join(root, 'glm')
    mkdirSync(join(home, 'config', 'opencode'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'opencode', 'opencode.json'),
      JSON.stringify({ provider: { 'zai-coding-plan': { models: { 'glm-5.3-flash': {} } } } }),
    )
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [
      { ...LINKED, state: 'degraded' },
      { id: 'slot_a_glm', engine: 'opencode', kind: 'opencode-key', home, state: 'healthy', env: {} },
    ])
    expect((await request(dataDir)).tasksCreated).toBe(0)
  })

  it('a degraded Claude slot places nothing', async () => {
    const { dataDir, repo } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [{ ...LINKED, state: 'degraded' }])
    expect((await request(dataDir)).tasksCreated).toBe(0)
  })

  it('a Claude slot with a key in it stays unlisted', async () => {
    const { dataDir, repo } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [{ ...LINKED, kind: 'claude-api' }])
    expect((await request(dataDir)).tasksCreated).toBe(0)
  })

  it('flag off nothing changes: a Claude slot stays unlisted', async () => {
    const { dataDir, repo } = scratch({ steps: SUCCESS })
    seedSlots(dataDir, repo, [LINKED])
    expect((await request(dataDir)).tasksCreated).toBe(0)
  })
})

describe('the launch path', { timeout: 60_000 }, () => {
  it('flag off starts no process and blocks with a reason', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    seedStore(dataDir, repo)
    await serve(dataDir)
    await reaches(dataDir, 'failed')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
    const work = peek(dataDir, (store) => store.workItems.get('wi_abcdefghij'))
    expect(work).toMatchObject({ state: 'blocked', blockedReason: 'no_runner' })
  })

  it('a launch for a stopped work item starts nothing', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, { work: { state: 'stopped' } })
    await serve(dataDir)
    await until(() =>
      peek(dataDir, (store) =>
        store.events.read('work:wi_abcdefghij').some((event) => event.type === 'launch_refused'),
      ),
    )
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
    expect(attemptState(dataDir)).toBe('queued')
  })

  it('a held launch waits and starts nothing', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, { work: { hold: { reason: 'wait', at: '2026-11-05T10:00:00.000Z' } } })
    await serve(dataDir)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
    expect(attemptState(dataDir)).toBe('queued')
  })

  it('the fake flag keeps priority', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    process.env.MEC_FAKE_ENGINE = '1'
    seedStore(dataDir, repo)
    await serve(dataDir)
    await until(() => attemptState(dataDir) !== 'queued')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it('runs the engine to a verdict on the pinned base, under the slot and the shims', async () => {
    const { dataDir, repo, bin, seen } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    process.env.ANTHROPIC_API_KEY = 'must-not-arrive'
    process.env.CLAUDE_CONFIG_DIR = '/must/not/arrive'
    seedStore(dataDir, repo, {
      checks: [{ name: 'made', cmd: 'test -f made.txt' }],
      bootstrap: ['touch boot-ran.txt'],
    })
    await serve(dataDir)
    try {
      await reaches(dataDir, 'succeeded')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CONFIG_DIR
    }

    const worktree = join(dataDir, 'work', 'att_1')
    const attempt = peek(dataDir, (store) => store.attempts.get('att_1')) as Record<string, string>
    const shimDir = join(worktree, '.mec', 'bin')

    // The engine ran, the real one, with the shim directory first on its PATH.
    expect(seen().self).toBe(join(bin, 'claude'))
    expect(seen().path0).toBe(shimDir)
    expect(seen().config_dir).toBeNull()
    expect(seen().has_anthropic_key).toBe(false)
    expect(seen().cwd).toContain(join('work', 'att_1'))
    const argv = seen().argv as string[]
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default')
    expect(argv).toContain('Bash(git push:*)')
    expect(argv).toContain('Bash(gh:*)')

    // Its branch, its pinned base, a real commit under the repository's identity.
    const base = gitIn(repo, 'rev-parse', 'HEAD')
    expect(attempt.base_sha).toBe(base)
    expect(attempt.branch).toBe('mec/abcdefgh/task_1/a1')
    expect(attempt.head_sha).toBe(gitIn(worktree, 'rev-parse', 'HEAD'))
    expect(attempt.head_sha).not.toBe(base)
    expect(gitIn(worktree, 'log', '-1', '--format=%ae')).toBe('owner@example.com')
    expect(gitIn(worktree, 'log', '--name-only', '--format=', `${base}..HEAD`, '--', '.mec')).toBe('')

    // The bootstrap ran first, the check ran on that head, and the token left the worktree.
    expect(gitIn(worktree, 'ls-files', 'boot-ran.txt')).toBe('boot-ran.txt')
    const check = peek(dataDir, (store) => store.engines.get('check/att_1/made'))
    expect(check).toMatchObject({ status: 'passed', exit_code: 0, sha: attempt.head_sha })
    expect(existsSync(join(worktree, '.mec', 'mcp.json'))).toBe(false)

    const task = peek(dataDir, (store) => store.tasks.get('task_1'))
    expect(task?.status).toBe('awaiting_review')
    const work = peek(dataDir, (store) => store.workItems.get('wi_abcdefghij'))
    expect(work?.base_sha).toBe(base)
    expect(existsSync(join(dataDir, 'journal', 'att_1', 'events.jsonl'))).toBe(true)
  })

  it('token is absent from effects, docs and events', async () => {
    const { dataDir, repo, bin } = scratch({
      steps: [
        { init: true },
        { saveToken: true },
        { call: { tool: 'report', args: { kind: 'progress', summary: 'started' } } },
        { result: 'completed' },
      ],
    })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo)
    await serve(dataDir)
    await reaches(dataDir, 'work_complete')
    await until(() => peek(dataDir, (store) => store.engines.get('report/att_1/1') !== undefined))

    const token = readFileSync(join(bin, 'token.txt'), 'utf8')
    expect(token.length).toBeGreaterThan(20)
    const dump = peek(dataDir, (_store, db) => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      return JSON.stringify(tables.map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all()))
    })
    expect(dump.length).toBeGreaterThan(1000)
    expect(dump).not.toContain(token)
    const journal = readFileSync(join(dataDir, 'journal', 'att_1', 'events.jsonl'), 'utf8')
    expect(journal).not.toContain(token)
    expect(existsSync(join(dataDir, 'work', 'att_1', '.mec', 'mcp.json'))).toBe(false)
  })

  it('launch returns after engine start, not at exit', async () => {
    const { dataDir, repo } = scratch({ steps: [{ init: true }, { forever: true }] })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo)
    await serve(dataDir)
    await reaches(dataDir, 'running')
    // The job has finished while the engine runs, so its row has drained.
    const launchRows = (db: Database.Database): number =>
      (db.prepare("SELECT count(*) AS n FROM effects WHERE kind = 'launch'").get() as { n: number }).n
    await until(() => peek(dataDir, (_store, db) => launchRows(db)) === 0)
    expect(attemptState(dataDir)).toBe('running')
  })

  it('a stop request reaches the process group, and close stops what is left', async () => {
    const { dataDir, repo, seen } = scratch({
      steps: [{ init: true }, { ignoreTerm: true }, { child: { ignoreTerm: true } }, { forever: true }],
    })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo)
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 6000 })
    closers.push(server.close)
    await reaches(dataDir, 'running')
    await until(() => existsSync(join(dirnameOfSeen(seen), 'child.pid')))
    peek(dataDir, (store) =>
      store.atomic(() =>
        store.events.append('attempt:att_1', {
          stream: 'attempt:att_1',
          seq: (store.events.read('attempt:att_1').at(-1)?.seq ?? 0) + 1,
          at: '2026-11-05T10:00:00.000Z',
          type: 'attempt.interrupt_requested',
          body: { attemptId: 'att_1' },
        }),
      ),
    )
    await reaches(dataDir, 'interrupted')
    expect(() => process.kill(-Number(seen().pid), 0)).toThrow()
    const terminal = peek(dataDir, (store) => store.attempts.get('att_1')?.terminal_reason)
    expect(terminal).toBe('stop_requested')
  })

  /** A repository whose one check names its pid and hangs. */
  const hangingCheck = (repo: string, root: string) => {
    const pidFile = join(root, 'check.pid')
    writeFileSync(join(repo, 'hang.sh'), `echo $$ > ${pidFile}\nexec sleep 137\n`)
    gitIn(repo, 'add', '--all')
    gitIn(repo, 'commit', '--quiet', '-m', 'a check that hangs')
    return { pidFile, checks: [{ name: 'hang', cmd: 'sh hang.sh' }] }
  }

  it('stopping work during its only check kills the check and accepts nothing', async () => {
    const { root, dataDir, repo } = scratch({ steps: SUCCESS })
    const { pidFile, checks } = hangingCheck(repo, root)
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, { checks })
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 6000 })
    closers.push(server.close)
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const stopped = await fetch(`${server.url}/api/work/wi_abcdefghij/stop`, { method: 'POST' })
    expect(stopped.status).toBe(200)
    await until(() => peek(dataDir, (store) => store.attempts.get('att_1')?.checks_note) !== undefined)
    const attempt = peek(dataDir, (store) => store.attempts.get('att_1'))
    expect(attempt).toMatchObject({ state: 'work_complete' })
    expect(String(attempt?.checks_note)).toContain('stopped during check hang')
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('close kills a running check within its bound', async () => {
    const { root, dataDir, repo } = scratch({ steps: SUCCESS })
    const { pidFile, checks } = hangingCheck(repo, root)
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, { checks })
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 6000 })
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await server.close()
    expect(() => process.kill(pid, 0)).toThrow()
    const note = peek(dataDir, (store) => store.attempts.get('att_1')?.checks_note)
    expect(String(note)).toContain('stopped during check hang: server_closing')
  })

  it('close stops a running attempt before the tools go', async () => {
    const { dataDir, repo, seen } = scratch({ steps: [{ init: true }, { forever: true }] })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo)
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 6000 })
    await reaches(dataDir, 'running')
    await server.close()
    expect(() => process.kill(-Number(seen().pid), 0)).toThrow()
    expect(attemptState(dataDir)).toBe('interrupted')
  })

  it('a second attempt keeps the first branch and the pinned base', async () => {
    const { dataDir, repo } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo)
    await serve(dataDir)
    await reaches(dataDir, 'work_complete')
    const first = String(peek(dataDir, (store) => store.attempts.get('att_1')?.head_sha))
    const base = gitIn(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'later.txt'), 'upstream moved\n')
    gitIn(repo, 'add', '--all')
    gitIn(repo, 'commit', '--quiet', '-m', 'upstream moved')

    peek(dataDir, (store) =>
      store.atomic(() => {
        store.tasks.save({
          id: 'task_2',
          workItemId: 'wi_abcdefghij',
          repoId: 'repo_a',
          status: 'ready',
          role: 'implementer',
          objective: 'the next thing',
          originalRequestRef: 'msg_1',
        })
        store.attempts.save({
          id: 'att_2',
          taskId: 'task_2',
          workItemId: 'wi_abcdefghij',
          slotId: 'slot_linked',
          state: 'queued',
          generation: 1,
        })
        store.effects.enqueue('launch', 'att_2:1', {
          attempt_id: 'att_2',
          task_id: 'task_2',
          work_item_id: 'wi_abcdefghij',
          slot_id: 'slot_linked',
          generation: 1,
        })
      }),
    )
    await reaches(dataDir, 'work_complete', 'att_2')
    const second = peek(dataDir, (store) => store.attempts.get('att_2'))
    expect(second?.base_sha).toBe(base)
    const worktree = join(dataDir, 'work', 'att_1')
    expect(gitIn(worktree, 'rev-parse', 'refs/heads/mec/abcdefgh/task_1/a1')).toBe(first)
  })
})

describe('what a launch refuses, before any spend', { timeout: 60_000 }, () => {
  /** A launcher on a seeded store, with no server, so a refusal can be looked at directly. */
  function rig(scenario: Scenario, seed: Seed = {}) {
    const paths = scratch(scenario)
    const db = new Database(':memory:')
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    seedInto(store, paths.repo, seed)
    const facts = new StoreFacts(store, (_attemptId, value) => value)
    const secret = 'launch-test-secret'
    const tools = new MecToolsServer({
      secret,
      bridge: { request: async () => 'deny' },
      onCall: specialistTools({ store, facts, headOf: async () => 'unused' }),
    })
    const launcher = new AttemptLauncher({
      store,
      dataDir: paths.dataDir,
      policyText: POLICY,
      facts,
      tools: { url: 'http://127.0.0.1:9/mcp', secret, bumpGeneration: (id) => tools.bumpGeneration(id) },
      bridge: specialistBridge(store),
      gate: () => ({ verdict: 'run' }),
      drop: () => {},
    })
    closers.push(async () => {
      await launcher.close()
      db.close()
    })
    const payload = {
      attempt_id: 'att_1',
      task_id: 'task_1',
      work_item_id: 'wi_abcdefghij',
      slot_id: 'slot_linked',
      generation: 1,
    }
    return { ...paths, store, tools, secret, launcher, payload }
  }

  const refusals: [string, Seed, RegExp][] = [
    [
      'task and repo disagreement refuses before any effect',
      { task: { repoId: 'repo_b' } },
      /launch_mismatch/,
    ],
    ['a non-registry engine', { slot: { engine: 'codex' } }, /engine_not_launchable: codex/],
    ['a key-based slot', { slot: { kind: 'claude-api' } }, /slot_kind_unsupported/],
    ['an unknown role', { task: { role: 'wizard' } }, /unknown_role/],
    [
      'a model the table does not know',
      { task: { modelRequest: { model: 'no-such-model', reason: 'test' } } },
      /model_refused/,
    ],
    ['a failed bootstrap', { bootstrap: ['false'] }, /bootstrap_failed/],
  ]

  for (const [name, seed, reason] of refusals) {
    it(name, async () => {
      const { store, launcher, payload, bin, dataDir } = rig({ steps: SUCCESS }, seed)
      await expect(launcher.launch(payload)).rejects.toThrow(reason)
      expect(existsSync(join(bin, 'seen.json'))).toBe(false)
      expect(store.attempts.get('att_1')).toMatchObject({ state: 'failed' })
      expect(String(store.attempts.get('att_1')?.terminal_reason)).toMatch(reason)
      expect(store.workItems.get('wi_abcdefghij')?.state).toBe('blocked')
      expect(existsSync(join(dataDir, 'journal', 'att_1'))).toBe(false)
    })
  }

  it('task and repo disagreement leaves no worktree', async () => {
    const { launcher, payload, dataDir } = rig({ steps: SUCCESS }, { task: { repoId: 'repo_b' } })
    await expect(launcher.launch(payload)).rejects.toThrow(/launch_mismatch/)
    expect(existsSync(join(dataDir, 'work'))).toBe(false)
  })

  it('work admitted under other commands is refused', async () => {
    const { launcher, payload, store } = rig({ steps: SUCCESS })
    store.atomic(() => {
      const repo = store.engines.get('repo_a')
      store.engines.save({ ...repo, id: 'repo_a', bootstrap: ['touch changed'] })
    })
    await expect(launcher.launch(payload)).rejects.toThrow(/repo_profile_changed/)
  })

  it('an unhealthy slot defers and spends nothing', async () => {
    const { launcher, payload, bin, store } = rig({ steps: SUCCESS }, { slot: { state: 'degraded' } })
    await expect(launcher.launch(payload)).rejects.toBeInstanceOf(Later)
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
    expect(store.attempts.get('att_1')?.state).toBe('queued')
  })

  it('a repository with no identity refuses the attempt', async () => {
    const { launcher, payload, repo, root } = rig({ steps: SUCCESS })
    gitIn(repo, 'config', '--unset', 'user.name')
    gitIn(repo, 'config', '--unset', 'user.email')
    const home = process.env.HOME
    process.env.HOME = root
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    try {
      await expect(launcher.launch(payload)).rejects.toThrow(/no_commit_identity/)
    } finally {
      process.env.HOME = home
      delete process.env.GIT_CONFIG_NOSYSTEM
    }
  })

  it('the gate is asked again at the last moment', async () => {
    const { store, tools, secret, payload, dataDir, bin } = rig({ steps: SUCCESS })
    const facts = new StoreFacts(store, (_attemptId, value) => value)
    const launcher = new AttemptLauncher({
      store,
      dataDir,
      policyText: POLICY,
      facts,
      tools: { url: 'http://127.0.0.1:9/mcp', secret, bumpGeneration: (id) => tools.bumpGeneration(id) },
      bridge: specialistBridge(store),
      gate: () => ({ verdict: 'defer', reason: 'held' }),
      drop: () => {},
    })
    closers.push(() => launcher.close())
    await expect(launcher.launch(payload)).rejects.toBeInstanceOf(Later)
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it('stale generation is fenced after a relaunch', async () => {
    const { store, launcher, payload, tools, secret } = rig({
      steps: [{ init: true }, { result: 'completed' }],
    })
    await launcher.launch(payload)
    await until(() => store.attempts.get('att_1')?.state === 'work_complete')
    expect(tools.currentGeneration('att_1')).toBe(1)

    const before = issueToken({ attemptId: 'att_1', generation: 1, role: 'specialist', secret })
    store.atomic(() => {
      store.attempts.save({ ...store.attempts.get('att_1'), id: 'att_1', state: 'queued', generation: 2 })
    })
    await launcher.launch({ ...payload, generation: 2 })
    expect(tools.currentGeneration('att_1')).toBe(2)
    const { url } = await tools.start()
    closers.push(() => tools.stop())
    const rpc = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${before}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read', arguments: { resource: 'attempt/att_1' } },
      }),
    })
    expect(((await rpc.json()) as { error?: { message: string } }).error?.message).toBe('stale generation')
  })
})

describe('resolveBinary', () => {
  it('finds the first executable on PATH, skipping any shim directory', () => {
    const { bin, root } = scratch({ steps: [] })
    const shims = join(root, 'work', '.mec', 'bin')
    mkdirSync(shims, { recursive: true })
    copyFileSync(join(bin, 'claude'), join(shims, 'claude'))
    expect(resolveBinary('claude', `${shims}:${bin}`)).toBe(join(bin, 'claude'))
    expect(resolveBinary('claude', 'relative/dir')).toBeUndefined()
    expect(resolveBinary('no-such-binary', bin)).toBeUndefined()
  })
})

function dirnameOfSeen(seen: () => Record<string, unknown>): string {
  return join(String(seen().self), '..')
}
