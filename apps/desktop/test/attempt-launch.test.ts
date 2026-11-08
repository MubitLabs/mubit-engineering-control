// M2.1's launch path end to end: a seeded queued attempt and launch row, the real server, the
// real queue and a real process through the fake CLI. No planner runs, so nothing here spends.
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
import { ownerHeaders, TEST_KEY } from './approval-rig'

const FAKE_CLI = fileURLToPath(new URL('../../../packages/testkit/fake-cli/claude', import.meta.url))
const POLICY = '{"preAuthorised":{}}'
const REAL_PATH = process.env.PATH

const roots: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  process.env.PATH = REAL_PATH
  process.env.MEC_REAL_RUNNER = '0'
  delete process.env.MEC_FAKE_ENGINE
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
      hostRunAgreedAt: '2026-11-05T08:00:00.000Z',
    })
    store.messages.save({ id: 'msg_1', text: 'please add the thing' })
    store.slots.save({
      id: 'slot_linked',
      engine: 'claude',
      kind: 'claude-sub',
      home: '/nowhere',
      linkedDefault: true,
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

async function serve(dataDir: string): Promise<{ url: string }> {
  const server = await startServer({ approvalKey: TEST_KEY, dataDir, policyText: POLICY, closeBoundMs: 4000 })
  closers.push(server.close)
  return server
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

async function until(test: () => boolean, ms = 45_000, seen?: () => string): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline)
      throw new Error(`condition never held${seen === undefined ? '' : ` (last seen: ${seen()})`}`)
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
    store.engines.save({
      id: 'repo_a',
      url: repo,
      bootstrap: [],
      checks: [],
      trust: false,
      hostRunAgreedAt: '2026-11-05T08:00:00.000Z',
    })
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

describe('the commit outside the sandbox', { timeout: 60_000 }, () => {
  const tampered = async (sh: string) => {
    const { dataDir, repo } = scratch({
      steps: [
        { init: true },
        { write: { path: 'made.txt', text: 'made\n' } },
        { sh },
        { result: 'completed' },
      ],
    })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo)
    await serve(dataDir)
    await reaches(dataDir, 'failed')
    const attempt = peek(dataDir, (store) => store.attempts.get('att_1'))
    return { attempt, work: join(dataDir, 'work', 'att_1') }
  }

  it('a repointed .git ends the attempt failed, with its reason, and commits nothing', async () => {
    const { attempt } = await tampered(`printf 'gitdir: /tmp/mec-elsewhere\\n' > .git`)
    expect(String(attempt?.terminal_reason)).toContain('git_pointer_moved')
    expect(attempt?.head_sha).toBeUndefined()
  })

  it('a .git swapped for a repository of the worker commits nothing there', async () => {
    const swap = '/usr/bin/git init -q "$TMPDIR/swapped" && rm .git && mv "$TMPDIR/swapped/.git" .git'
    const { attempt, work } = await tampered(swap)
    expect(String(attempt?.terminal_reason)).toContain('git_pointer_moved')
    expect(() => gitIn(work, 'rev-parse', 'HEAD')).toThrow()
  })
})

describe('a chat request', { timeout: 60_000 }, () => {
  const request = async (dataDir: string, tier = 'fast') => {
    const server = await startServer({
      approvalKey: TEST_KEY,
      dataDir,
      policyText: POLICY,
      closeBoundMs: 4000,
      brain: proposes(tier),
    })
    closers.push(server.close)
    const answer = await fetch(`${server.url}/api/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ownerHeaders },
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

  describe('the planner slot', () => {
    const plansOn = async (slot: Record<string, unknown>) => {
      const { dataDir, repo, bin, seen } = scratch({ steps: [{ init: true }, { result: 'completed' }] })
      seedSlots(dataDir, repo, [slot])
      peek(dataDir, (store) => store.engines.save({ id: 'settings/meta-slot', slotId: String(slot.id) }))
      process.env.CLAUDE_CONFIG_DIR = '/must/not/arrive'
      try {
        const server = await startServer({
          approvalKey: TEST_KEY,
          dataDir,
          policyText: POLICY,
          closeBoundMs: 4000,
        })
        closers.push(server.close)
        await fetch(`${server.url}/api/chat/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...ownerHeaders },
          body: JSON.stringify({ text: 'please add the thing', repoId: 'repo_a' }),
        })
        await until(() => existsSync(join(bin, 'seen.json')))
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR
      }
      return seen()
    }

    it('a linked slot plans with CLAUDE_CONFIG_DIR unset, as an interactive claude runs', async () => {
      const seen = await plansOn({ ...LINKED, home: '/home/someone/.claude', linkedDefault: true })
      expect(seen.config_dir).toBeNull()
    })

    it("a linked slot's own settings cannot widen the planner: explicit mode, no shell", async () => {
      const seen = await plansOn({ ...LINKED, home: '/home/someone/.claude', linkedDefault: true })
      const pairs = (seen.argv as string[]).map((arg, index, argv) => `${arg} ${argv[index + 1]}`)
      expect(pairs).toContain('--permission-mode default')
      for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit']) {
        expect(pairs).toContain(`--disallowedTools ${tool}`)
      }
      expect(pairs).toContain('--allowedTools mcp__mec__*')
      expect(seen.argv).toContain('--restricted')
    })

    it('a retired meta slot never launches, and the status says why', async () => {
      const { dataDir, repo, bin } = scratch({ steps: [{ init: true }, { result: 'completed' }] })
      seedSlots(dataDir, repo, [{ ...LINKED, state: 'retired' }])
      peek(dataDir, (store) => store.engines.save({ id: 'settings/meta-slot', slotId: LINKED.id }))
      const server = await startServer({
        approvalKey: TEST_KEY,
        dataDir,
        policyText: POLICY,
        closeBoundMs: 4000,
      })
      closers.push(server.close)

      await fetch(`${server.url}/api/chat/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ownerHeaders },
        body: JSON.stringify({ text: 'please add the thing', repoId: 'repo_a' }),
      })

      expect(existsSync(join(bin, 'seen.json'))).toBe(false)
      const status = (await (await fetch(`${server.url}/api/status`)).json()) as {
        parts: Record<string, { state: string; detail?: string }>
      }
      expect(status.parts[`slot:${LINKED.id}`]).toEqual({
        state: 'error',
        detail: `slot ${LINKED.id} is retired, so it cannot run the meta agent: choose another slot`,
      })
    })

    it('a retired meta slot with no home is refused by name too', async () => {
      const { dataDir, repo } = scratch({ steps: [{ init: true }, { result: 'completed' }] })
      const { home: _home, ...homeless } = LINKED
      seedSlots(dataDir, repo, [{ ...homeless, state: 'retired' }])
      peek(dataDir, (store) => store.engines.save({ id: 'settings/meta-slot', slotId: LINKED.id }))
      const server = await startServer({
        approvalKey: TEST_KEY,
        dataDir,
        policyText: POLICY,
        closeBoundMs: 4000,
      })
      closers.push(server.close)
      const status = (await (await fetch(`${server.url}/api/status`)).json()) as {
        parts: Record<string, { state: string; detail?: string }>
      }
      expect(status.parts[`slot:${LINKED.id}`]?.state).toBe('error')
    })

    it('a degraded meta slot still plans: a probe can bring it back', async () => {
      const seen = await plansOn({ ...LINKED, state: 'degraded' })
      expect(seen.argv).toContain('-p')
    })

    it('a slot with its own home plans under that home', async () => {
      const seen = await plansOn({ ...LINKED, id: 'slot_max', home: '/slots/claude/max' })
      expect(seen.config_dir).toBe('/slots/claude/max')
    })
  })

  /** A key slot's home whose opencode config lists `model` under `provider`. */
  const keyHome = (root: string, name: string, provider: string, model: string): string => {
    const home = join(root, name)
    mkdirSync(join(home, 'config', 'opencode'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'opencode', 'opencode.json'),
      JSON.stringify({ provider: { [provider]: { models: { [model]: {} } } } }),
    )
    return home
  }
  const gemini = (home: string) => ({
    id: 'gem-1',
    engine: 'opencode',
    kind: 'opencode-gemini',
    provider: 'google-gemini',
    home,
    state: 'healthy',
    env: {},
  })
  const glm = (home: string) => ({
    id: 'slot_a_glm',
    engine: 'opencode',
    kind: 'opencode-glm',
    provider: 'zai-coding-plan',
    home,
    state: 'healthy',
    env: {},
  })

  it('an opencode-gemini slot takes no work with the runner on, though it sorts first', async () => {
    const { root, dataDir, repo } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [LINKED, gemini(keyHome(root, 'gem', 'google', 'gemini-3.5-flash-lite'))])
    expect((await request(dataDir)).launchesEnqueued).toBe(1)
    expect(peek(dataDir, (store) => store.attempts.list()[0]?.slotId)).toBe('slot_linked')
  })

  it('an opencode-gemini slot takes no work with the runner off either (known-limits)', async () => {
    const { root, dataDir, repo } = scratch({ steps: SUCCESS })
    seedSlots(dataDir, repo, [gemini(keyHome(root, 'gem', 'google', 'gemini-3.5-flash-lite'))])
    expect((await request(dataDir)).launchesEnqueued).toBe(0)
    expect(peek(dataDir, (store) => store.attempts.list())).toEqual([])
  })

  it("a tier-only task takes the meta slot's engine over a launchable slot that sorts first", async () => {
    const { root, dataDir, repo } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [LINKED, glm(keyHome(root, 'glm', 'zai-coding-plan', 'glm-5.3-flash'))])
    peek(dataDir, (store) => store.engines.save({ id: 'settings/meta-slot', slotId: LINKED.id }))
    expect((await request(dataDir)).launchesEnqueued).toBe(1)
    const attempt = peek(dataDir, (store) => store.attempts.list()[0])
    expect(attempt?.slotId).toBe('slot_linked')
    expect(attempt?.placement).toBe("slot_linked: on the meta agent's engine, claude")
  })

  it('a retired meta slot sets no engine preference', async () => {
    const { root, dataDir, repo } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [
      LINKED,
      { ...LINKED, id: 'slot_old', state: 'retired' },
      glm(keyHome(root, 'glm', 'zai-coding-plan', 'glm-5.3-flash')),
    ])
    peek(dataDir, (store) => store.engines.save({ id: 'settings/meta-slot', slotId: 'slot_old' }))
    expect((await request(dataDir)).launchesEnqueued).toBe(1)
    expect(peek(dataDir, (store) => store.attempts.list()[0]?.slotId)).toBe('slot_a_glm')
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

  // `probeSlotAtStartup` saves this doc under MEC_PROBE_SLOT. A launch would be refused, so a plan
  // cannot be placed on it either.
  it('the startup probe slot places nothing: it names no home', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedSlots(dataDir, repo, [
      {
        id: 'slot_claude_probe',
        label: 'startup probe',
        engine: 'claude',
        kind: 'claude-sub',
        state: 'healthy',
      },
    ])
    expect((await request(dataDir)).tasksCreated).toBe(0)
    expect(peek(dataDir, (store) => store.attempts.list())).toEqual([])
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
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
  it('with no flag at all a launch is real', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    delete process.env.MEC_REAL_RUNNER
    seedStore(dataDir, repo, { checks: [{ name: 'made', cmd: 'test -f made.txt' }] })
    await serve(dataDir)
    await reaches(dataDir, 'succeeded')
    expect(existsSync(join(bin, 'seen.json'))).toBe(true)
  })

  it('MEC_REAL_RUNNER=0 starts no process and blocks with a reason', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '0'
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

  it('the fake flag wins over the default too', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    delete process.env.MEC_REAL_RUNNER
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

    // The brief is true about the shared clone: its writes are denied, so a worker's own commit
    // fails, and the worker is told to leave that to MEC instead of finding out and retrying.
    // §9: the objective goes on stdin, the first of the engine's input lines.
    const stdin = readFileSync(join(bin, 'stdin.jsonl'), 'utf8')
    const prompt = String(JSON.parse(stdin.split('\n')[0] ?? '{}').message.content)
    expect(prompt).toContain('Your shell is sandboxed')
    expect(prompt).toMatch(/shared clone[^.]*read-only/)
    expect(prompt).toContain('Do not run git add or git commit')
    expect(prompt).toContain('MEC commits it when you finish')
    expect(prompt).not.toMatch(/leave its refs alone/)

    // §26: the whole clone is out of the shell's reach, not the slice the brief describes.
    const common = realpathSync(gitIn(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    const settings = JSON.parse(readFileSync(join(worktree, '.mec', 'claude-settings.json'), 'utf8'))
    expect(settings.sandbox.filesystem.denyWrite).toEqual([common])

    // Its branch, its pinned base, a real commit under the repository's identity.
    const base = gitIn(repo, 'rev-parse', 'HEAD')
    expect(attempt.base_sha).toBe(base)
    expect(attempt.branch).toBe('mec/abcdefgh/task_1/a1')
    expect(attempt.head_sha).toBe(gitIn(worktree, 'rev-parse', 'HEAD'))
    expect(attempt.head_sha).not.toBe(base)
    expect(gitIn(worktree, 'log', '-1', '--format=%ae')).toBe('owner@example.com')
    expect(gitIn(worktree, 'log', '--name-only', '--format=', `${base}..HEAD`, '--', '.mec')).toBe('')

    // The bootstrap ran first, its file stayed out of the commit, the check ran on that head, and
    // the token left the worktree.
    expect(readdirSync(worktree)).toContain('boot-ran.txt')
    expect(gitIn(worktree, 'ls-files', 'boot-ran.txt')).toBe('')
    const check = peek(dataDir, (store) => store.engines.get('check/att_1/made'))
    expect(check).toMatchObject({ status: 'passed', exit_code: 0, sha: attempt.head_sha })
    expect(existsSync(join(worktree, '.mec', 'mcp.json'))).toBe(false)

    const task = peek(dataDir, (store) => store.tasks.get('task_1'))
    expect(task?.status).toBe('awaiting_review')
    const work = peek(dataDir, (store) => store.workItems.get('wi_abcdefghij'))
    expect(work?.base_sha).toBe(base)
    expect(existsSync(join(dataDir, 'journal', 'att_1', 'events.jsonl'))).toBe(true)
  })

  // §5.3 and the slot isolation row of §26: a slot added in Connections runs under its own home.
  it("the repository's CLAUDE.md and AGENTS.md at the base reach the brief, labelled and redacted", async () => {
    // Owner ruling, 7 November 2026: the repository's own instructions, as information.
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    const key = `sk-ant-api03-${'k'.repeat(90)}`
    writeFileSync(join(repo, 'CLAUDE.md'), `# Repo rules\nRun pnpm check before you finish.\nkey ${key}\n`)
    writeFileSync(join(repo, 'AGENTS.md'), '# Agents\nKeep commits small.\n')
    mkdirSync(join(repo, '.claude'))
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"env":{"SETTING_MARK":"from-repo"}}\n')
    gitIn(repo, 'add', '--all')
    gitIn(repo, 'commit', '--quiet', '-m', 'instructions')
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, { checks: [{ name: 'made', cmd: 'test -f made.txt' }] })
    await serve(dataDir)
    await reaches(dataDir, 'succeeded')

    const stdin = readFileSync(join(bin, 'stdin.jsonl'), 'utf8')
    const prompt = String(JSON.parse(stdin.split('\n')[0] ?? '{}').message.content)
    expect(prompt).toContain("The repository's own instructions, as information")
    expect(prompt).toContain('CLAUDE.md at the base:')
    expect(prompt).toContain('Run pnpm check before you finish.')
    expect(prompt).toContain('AGENTS.md at the base:')
    expect(prompt).toContain('Keep commits small.')
    expect(prompt).not.toContain(key)
    expect(prompt).not.toContain('SETTING_MARK')
  })

  it('a repository with neither file adds nothing to the brief', async () => {
    const { dataDir, repo, bin } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, { checks: [{ name: 'made', cmd: 'test -f made.txt' }] })
    await serve(dataDir)
    await reaches(dataDir, 'succeeded')
    const prompt = readFileSync(join(bin, 'stdin.jsonl'), 'utf8')
    expect(prompt).not.toContain("repository's own instructions")
  })

  it('a slot from Add connection launches under its own home, not the default login', async () => {
    const { dataDir, repo, seen } = scratch({ steps: SUCCESS })
    const adding = await startServer({
      approvalKey: TEST_KEY,
      dataDir,
      policyText: POLICY,
      closeBoundMs: 4000,
    })
    const added = await fetch(`${adding.url}/api/slots/dedicated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'claude', label: 'max-2' }),
    })
    expect(added.status).toBe(200)
    await adding.close()
    const slot = peek(dataDir, (store) => store.slots.get('slot_max-2'))
    expect(typeof slot?.home).toBe('string')
    expect(slot?.env).toEqual({ CLAUDE_CONFIG_DIR: slot?.home })

    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, {
      checks: [{ name: 'made', cmd: 'test -f made.txt' }],
      slot: { ...slot, id: 'slot_linked', state: 'healthy', linkedDefault: undefined },
    })
    await serve(dataDir)
    await reaches(dataDir, 'succeeded')
    expect(seen().config_dir).toBe(slot?.home)
  })

  // The probe's rule (§5.3): only `linkedDefault` means "the variable unset". A slot saved before
  // dcbbdc1 has no `env`, and no stored doc is rewritten, so its home has to be enough.
  it('a slot saved with no env launches under its home', async () => {
    const { dataDir, repo, seen } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, {
      checks: [{ name: 'made', cmd: 'test -f made.txt' }],
      slot: { linkedDefault: undefined, home: '/slots/claude/old', env: undefined },
    })
    await serve(dataDir)
    await reaches(dataDir, 'succeeded')
    expect(seen().config_dir).toBe('/slots/claude/old')
  })

  it('a slot of its own runs under its home, whatever its stored env says', async () => {
    const { dataDir, repo, seen } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, {
      checks: [{ name: 'made', cmd: 'test -f made.txt' }],
      slot: {
        linkedDefault: undefined,
        home: '/slots/claude/own',
        env: { CLAUDE_CONFIG_DIR: '/slots/claude/other' },
      },
    })
    await serve(dataDir)
    await reaches(dataDir, 'succeeded')
    expect(seen().config_dir).toBe('/slots/claude/own')
  })

  it('a linked slot needs no home: it runs as `claude` does', async () => {
    const { dataDir, repo, seen } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, {
      checks: [{ name: 'made', cmd: 'test -f made.txt' }],
      slot: { home: undefined },
    })
    await serve(dataDir)
    await reaches(dataDir, 'succeeded')
    expect(seen().config_dir).toBeNull()
  })

  it('a linked slot keeps the variable unset, whatever its stored env says', async () => {
    const { dataDir, repo, seen } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, {
      checks: [{ name: 'made', cmd: 'test -f made.txt' }],
      slot: { home: '/home/someone/.claude', env: { CLAUDE_CONFIG_DIR: '/home/someone/.claude' } },
    })
    await serve(dataDir)
    await reaches(dataDir, 'succeeded')
    expect(seen().config_dir).toBeNull()
  })

  // Composition reads a saved policy first (M3.3), so the launcher has to hold that text too.
  it('a launch reads the saved policy, not the text it replaced at boot', async () => {
    const { dataDir, repo } = scratch({ steps: SUCCESS })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, { checks: [{ name: 'made', cmd: 'test -f made.txt' }] })
    peek(dataDir, (store) => store.engines.save({ id: 'settings/policy', text: POLICY, revision: 1 }))
    const server = await startServer({
      approvalKey: TEST_KEY,
      dataDir,
      policyText: 'not a policy',
      closeBoundMs: 4000,
    })
    closers.push(server.close)
    await reaches(dataDir, 'succeeded')
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

  it('a token a worker wrote into its worktree is not served as an artifact', async () => {
    const { dataDir, repo, bin } = scratch({
      steps: [
        { init: true },
        { saveToken: true },
        { sh: 'printenv MEC_TOOLS_TOKEN > build.log' },
        { result: 'completed' },
      ],
    })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo)
    const server = await serve(dataDir)
    await reaches(dataDir, 'work_complete')

    const token = readFileSync(join(bin, 'token.txt'), 'utf8')
    expect(readFileSync(join(dataDir, 'work', 'att_1', 'build.log'), 'utf8')).toContain(token)
    const res = await fetch(`${server.url}/api/inspect/artifacts?attemptId=att_1&ref=build.log`, {
      headers: { 'x-mec-client': '1' },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(token)
    expect(body).toContain('[redacted:exact]')
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

  // §11: the plan stores `wallClockMs` (packages/meta/src/tools.ts); rows seeded in the brief's
  // spelling keep working. The default is 30 minutes, so an unread budget cannot end this run.
  it.each([
    ['a stored plan budget', { turns: 5, wallClockMs: 400 }],
    ['a seeded brief-shaped budget', { turns: 5, wall_clock_ms: 400 }],
  ])('%s ends the attempt on its own wall clock', async (_name, budget) => {
    const { dataDir, repo } = scratch({ steps: [{ init: true }, { forever: true }] })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo, { task: { budget } })
    await serve(dataDir)
    await until(() => attemptState(dataDir) === 'interrupted', 15_000)
    expect(peek(dataDir, (store) => store.attempts.get('att_1')?.terminal_reason)).toBe('wall_clock')
  })

  it('a stop request reaches the process group, and close stops what is left', async () => {
    const { dataDir, repo, seen } = scratch({
      steps: [{ init: true }, { ignoreTerm: true }, { child: { ignoreTerm: true } }, { forever: true }],
    })
    process.env.MEC_REAL_RUNNER = '1'
    seedStore(dataDir, repo)
    const server = await startServer({
      approvalKey: TEST_KEY,
      dataDir,
      policyText: POLICY,
      closeBoundMs: 6000,
    })
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
    const server = await startServer({
      approvalKey: TEST_KEY,
      dataDir,
      policyText: POLICY,
      closeBoundMs: 6000,
    })
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
    const server = await startServer({
      approvalKey: TEST_KEY,
      dataDir,
      policyText: POLICY,
      closeBoundMs: 6000,
    })
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
    const server = await startServer({
      approvalKey: TEST_KEY,
      dataDir,
      policyText: POLICY,
      closeBoundMs: 6000,
    })
    await reaches(dataDir, 'running')
    await server.close()
    expect(() => process.kill(-Number(seen().pid), 0)).toThrow()
    expect(attemptState(dataDir)).toBe('interrupted')
  })

  // Seatbelt itself, with the list the launch wrote: the engine's sandbox applies the same rule.
  it.runIf(existsSync('/usr/bin/sandbox-exec'))(
    "a worker's refused git writes hurt nothing, and MEC still commits its work",
    async () => {
      const refused = [
        "D=$(node -p \"JSON.parse(require('fs').readFileSync('.mec/claude-settings.json')).sandbox.filesystem.denyWrite[0]\")",
        'P="(version 1)(allow default)(deny file-write* (subpath \\"$D\\"))"',
        // The first command must pass, or a broken profile would read as four refusals.
        'for c in "git status" "git add --all" "git commit -am mine" "git update-ref refs/heads/evil HEAD"; do',
        '  sandbox-exec -p "$P" sh -c "$c" >/dev/null 2>&1; echo $? >> "$TMPDIR/refused.txt"',
        'done',
        'sandbox-exec -p "$P" sh -c \'echo x > "\'"$D"\'/refs/heads/evil"\' 2>/dev/null; echo $? >> "$TMPDIR/refused.txt"',
      ].join('\n')
      const { dataDir, repo } = scratch({
        steps: [
          { init: true },
          { write: { path: 'made.txt', text: 'made\n' } },
          { sh: refused },
          { result: 'completed' },
        ],
      })
      process.env.MEC_REAL_RUNNER = '1'
      seedStore(dataDir, repo, { checks: [{ name: 'made', cmd: 'test -f made.txt' }] })
      await serve(dataDir)
      await reaches(dataDir, 'succeeded')

      const codes = readFileSync(join(dataDir, 'tmp', 'att_1', 'refused.txt'), 'utf8')
        .trim()
        .split('\n')
      expect(codes).toHaveLength(5)
      expect(codes[0]).toBe('0')
      expect(codes.slice(1)).not.toContain('0')
      const worktree = join(dataDir, 'work', 'att_1')
      const attempt = peek(dataDir, (store) => store.attempts.get('att_1')) as Record<string, string>
      expect(attempt.head_sha).toBe(gitIn(worktree, 'rev-parse', 'HEAD'))
      expect(gitIn(worktree, 'log', '-1', '--format=%s')).toBe('mec: task_1 attempt att_1')
      expect(gitIn(worktree, 'ls-files', 'made.txt')).toBe('made.txt')
      expect(gitIn(worktree, 'for-each-ref', '--format=%(refname)', 'refs/heads/evil')).toBe('')
    },
  )

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
    ['a non-registry engine', { slot: { engine: 'gemini' } }, /engine_not_launchable: gemini/],
    ['a key-based slot', { slot: { kind: 'claude-api' } }, /slot_kind_unsupported/],
    [
      'a slot of its own with no home, as the startup probe saves one',
      { slot: { linkedDefault: undefined, home: undefined, env: undefined } },
      /slot_home_missing: slot_linked/,
    ],
    [
      'a slot of its own with an empty home',
      { slot: { linkedDefault: undefined, home: '' } },
      /slot_home_missing/,
    ],
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
    // `work_complete` moves on to `succeeded` once checks pass, so a poll can miss it: accept both, and
    // fail at once with the reason when the attempt settled any other way (not 45 s later, blind).
    await until(
      () => {
        const now = String(store.attempts.get('att_1')?.state)
        if (now === 'work_complete' || now === 'succeeded') return true
        if (SETTLED.includes(now)) {
          throw new Error(`attempt settled ${now}: ${String(store.attempts.get('att_1')?.terminal_reason)}`)
        }
        return false
      },
      undefined,
      () => String(store.attempts.get('att_1')?.state),
    )
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
