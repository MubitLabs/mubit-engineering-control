// M2.4 Part B: the registry, and each engine's launch path end to end. A seeded queued attempt and
// launch row, the real server, the real queue and a real process through the fake CLI. No planner
// runs, so nothing here spends. Each engine is proven on its own.
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
import { CodexAdapter } from '@mec/engines'
import { repoFields } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'
import { bridgeOf, driftOf, ENGINE_ROWS, isLaunchableSlot } from '../src/engine-registry'

const fakeCli = (name: string): string =>
  fileURLToPath(new URL(`../../../packages/testkit/fake-cli/${name}`, import.meta.url))
const POLICY = '{"preAuthorised":{}}'
const REAL_PATH = process.env.PATH

const roots: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  process.env.PATH = REAL_PATH
  delete process.env.MEC_REAL_RUNNER
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

type Seed = {
  slot: Record<string, unknown>
  checks?: { name: string; cmd: string }[]
  task?: Record<string, unknown>
}

function scratch(engine: string, scenario: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'mec-registry-'))
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
  copyFileSync(fakeCli(engine), join(bin, engine))
  writeFileSync(join(bin, 'scenario.json'), JSON.stringify(scenario))
  process.env.PATH = `${bin}:${REAL_PATH}`
  const lines = (name: string): Record<string, never>[] =>
    existsSync(join(bin, name))
      ? readFileSync(join(bin, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  return {
    root,
    dataDir,
    repo,
    bin,
    lines,
    seen: () => JSON.parse(readFileSync(join(bin, 'seen.json'), 'utf8')),
  }
}

function seed(dataDir: string, repo: string, { slot, checks, task }: Seed): void {
  const db = new Database(join(dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  store.atomic(() => {
    store.engines.save({ id: 'repo_a', url: repo, bootstrap: [], checks: checks ?? [], trust: false })
    store.messages.save({ id: 'msg_1', text: 'please add the thing' })
    store.slots.save({ id: 'slot_x', home: '/nowhere', state: 'healthy', env: {}, ...slot } as never)
    store.workItems.save({
      id: 'wi_abcdefghij',
      state: 'executing',
      repoId: 'repo_a',
      pin: repoFields(store, 'repo_a', POLICY).pin as never,
      mandate: { originMessageId: 'msg_1' },
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
      ...task,
    })
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_1',
      workItemId: 'wi_abcdefghij',
      slotId: 'slot_x',
      state: 'queued',
      generation: 1,
      createdAt: '2026-11-05T10:00:00.000Z',
    })
    store.effects.enqueue('launch', 'att_1:1', {
      attempt_id: 'att_1',
      task_id: 'task_1',
      work_item_id: 'wi_abcdefghij',
      slot_id: 'slot_x',
      generation: 1,
    })
  })
  db.close()
}

function peek<T>(dataDir: string, read: (store: SqliteStore, db: Database.Database) => T): T {
  const db = new Database(join(dataDir, 'mec.db'))
  try {
    return read(new SqliteStore(db), db)
  } finally {
    db.close()
  }
}

async function until(test: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const attempt = (dataDir: string) => peek(dataDir, (store) => store.attempts.get('att_1'))

const SETTLED = ['succeeded', 'checks_failed', 'failed', 'interrupted', 'work_complete']

async function launched(dataDir: string): Promise<Record<string, unknown>> {
  process.env.MEC_REAL_RUNNER = '1'
  const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 4000 })
  closers.push(server.close)
  await until(() => SETTLED.includes(String(attempt(dataDir)?.state)))
  return attempt(dataDir) as Record<string, unknown>
}

/** Every table's rows, as text: a token in any of them would show. */
const allDurable = (dataDir: string): string =>
  peek(dataDir, (_store, db) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()))
      .join(''),
  )

describe('the registry', () => {
  it('unproven engine is refused with no spend', async () => {
    const { dataDir, repo, bin } = scratch('codex', { steps: [] })
    copyFileSync(fakeCli('codex'), join(bin, 'gemini'))
    seed(dataDir, repo, { slot: { engine: 'gemini', kind: 'gemini-key' } })
    const end = await launched(dataDir)
    expect(end.state).toBe('failed')
    expect(String(end.terminal_reason)).toContain('engine_not_launchable: gemini')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it('a proven engine refuses a slot kind its proof did not cover', async () => {
    const { dataDir, repo, bin } = scratch('codex', { steps: [] })
    seed(dataDir, repo, { slot: { engine: 'codex', kind: 'codex-api' } })
    const end = await launched(dataDir)
    expect(String(end.terminal_reason)).toContain('slot_kind_unsupported')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it('the planner sees exactly what a launch would accept', () => {
    expect(isLaunchableSlot({ id: 's', engine: 'codex', kind: 'codex-sub' })).toBe(true)
    expect(isLaunchableSlot({ id: 's', engine: 'codex', kind: 'codex-api' })).toBe(false)
    expect(isLaunchableSlot({ id: 's', engine: 'gemini', kind: 'codex-sub' })).toBe(false)
  })
})

const CODEX_SLOT = { engine: 'codex', kind: 'codex-sub' }
const CHECKS = [{ name: 'unit', cmd: 'true' }]

const SUCCESS = [
  { notify: { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } } },
  { write: { path: 'made.txt', text: 'made\n' } },
  { saveToken: true },
  { call: { tool: 'report', args: { kind: 'ready', summary: 'made the file' } } },
  { complete: 'completed' },
]

describe('Codex through the runner', { timeout: 60_000 }, () => {
  const ROW = ENGINE_ROWS.codex
  if (ROW === undefined) throw new Error('no codex row')

  it('advertised capabilities equal the probe', async () => {
    const { capabilities } = await new CodexAdapter({
      versionProbe: async () => '0.148.0',
      loginStatus: async () => ({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' }),
    }).probe()
    expect(ROW.capabilities).toEqual(capabilities)
    expect(ROW.pinned).toBe(capabilities.engine_version)
  })

  it('a turn gives a report, a commit on the head, and checks on that head', async () => {
    const { dataDir, repo, seen, root } = scratch('codex', { steps: SUCCESS })
    seed(dataDir, repo, { slot: CODEX_SLOT, checks: CHECKS })
    const end = await launched(dataDir)
    expect(end.state).toBe('succeeded')
    const worktree = String(end.worktree)
    const head = gitIn(worktree, 'rev-parse', 'HEAD')
    expect(gitIn(worktree, 'show', '--name-only', '--format=', 'HEAD')).toBe('made.txt')
    const stored = peek(dataDir, (store) => ({
      check: store.engines.get('check/att_1/unit'),
      report: store.engines.get('report/att_1/1'),
    }))
    expect(stored.check).toMatchObject({ status: 'passed', sha: head })
    expect(JSON.stringify(stored.report)).toContain('made the file')
    expect(seen().self).not.toContain('.mec')
    expect(existsSync(join(root, 'bin', 'token.txt'))).toBe(true)
  })

  it('the engine binary is not the shim, and starts in the worktree', async () => {
    const { dataDir, repo, seen } = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    const end = await launched(dataDir)
    expect(seen().path0).toContain(join('.mec', 'bin'))
    expect(seen().cwd).toBe(String(end.worktree).replace(/^\/var\//, '/private/var/'))
  })

  it('token is absent from argv, files, docs and events', async () => {
    const { dataDir, repo, seen, bin } = scratch('codex', { steps: SUCCESS })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    const end = await launched(dataDir)
    const token = readFileSync(join(bin, 'token.txt'), 'utf8')
    expect(token.length).toBeGreaterThan(20)
    expect(JSON.stringify(seen())).not.toContain(token)
    expect(allDurable(dataDir)).not.toContain(token)
    expect(existsSync(join(String(end.worktree), '.mec', 'mcp.json'))).toBe(false)
  })

  it('the slot layer reaches the engine, and a linked slot sets no home', async () => {
    const dedicated = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dedicated.dataDir, dedicated.repo, {
      slot: { ...CODEX_SLOT, env: { CODEX_HOME: '/slots/codex/one' } },
    })
    await launched(dedicated.dataDir)
    expect(dedicated.seen().codex_home).toBe('/slots/codex/one')
  })

  it('every ask is refused, because an allowed command would leave the sandbox', async () => {
    const steps = [
      {
        ask: {
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 't', turnId: 'u', itemId: 'i', command: 'touch /outside/x' },
        },
      },
      { complete: 'completed' },
    ]
    const { dataDir, repo, lines } = scratch('codex', { steps })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    await launched(dataDir)
    expect(lines('answers.jsonl')).toEqual([
      { method: 'item/commandExecution/requestApproval', answer: { decision: 'decline' } },
    ])
    const events = peek(dataDir, (store) => store.events.read('attempt:att_1'))
    expect(events.some((event) => event.type === 'attempt.permission_requested')).toBe(true)
  })

  it("a server of the user's is named to go, and the listing's other fields stay out", async () => {
    const scenario = {
      mcp: [{ name: 'runpod', transport: 'streamable_http' }],
      steps: [{ complete: 'completed' }],
    }
    const { dataDir, repo, seen } = scratch('codex', scenario)
    seed(dataDir, repo, { slot: CODEX_SLOT })
    await launched(dataDir)
    expect(seen().argv).toContain('mcp_servers.runpod={url="http://127.0.0.1:9/",enabled=false}')
  })

  it('the sandbox profile names the real clone and the scratch data dir', async () => {
    const { dataDir, repo, seen } = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    await launched(dataDir)
    const profile = (seen().argv as string[]).find((arg) => arg.startsWith('permissions.mec=')) ?? ''
    expect(profile).toMatch(/repos\/[^"]+"="read"/)
    expect(profile).toContain(`${dataDir}/mec.db"="deny"`)
    expect(profile).toContain(`${dataDir}/journal"="deny"`)
  })

  it('a thread without the profile refuses, and leaves no process behind', async () => {
    const { dataDir, repo, seen } = scratch('codex', { profile: null, steps: [] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    const end = await launched(dataDir)
    expect(end.state).toBe('failed')
    expect(String(end.terminal_reason)).toContain('sandbox profile is not active')
    const { pid } = seen()
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 5000)
  })

  it('a drifted version degrades the slot and spends nothing', async () => {
    const { dataDir, repo, bin } = scratch('codex', { version: 'codex-cli 0.149.0', steps: [] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    const end = await launched(dataDir)
    expect(end.state).toBe('failed')
    expect(String(end.terminal_reason)).toContain('engine_unsupported')
    expect(peek(dataDir, (store) => store.slots.get('slot_x'))).toMatchObject({
      state: 'degraded',
      state_reason: 'engine_unsupported',
    })
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it('a slot that lost its login refuses and spends nothing', async () => {
    const { dataDir, repo, bin } = scratch('codex', { login: 'Not logged in', steps: [] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    const end = await launched(dataDir)
    expect(String(end.terminal_reason)).toContain('auth_required')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it('the server dying mid-turn fails the attempt, it does not hang', async () => {
    const { dataDir, repo } = scratch('codex', { steps: [{ exit: 3 }] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    const end = await launched(dataDir)
    expect(end.state).toBe('failed')
  })
})

describe('driftOf', () => {
  const ROW = ENGINE_ROWS.codex
  if (ROW?.capabilities === undefined) throw new Error('no codex row')
  const { capabilities } = ROW

  it('is quiet on what the proof ran', () => {
    expect(driftOf(ROW, { capabilities, auth: { logged_in: true } })).toBeUndefined()
  })

  it('names a flag the probe lost', () => {
    const lost = { ...capabilities, flags_verified: capabilities.flags_verified.slice(1) }
    expect(driftOf(ROW, { capabilities: lost, auth: { logged_in: true } })).toContain('initialize')
  })
})

describe('bridgeOf', () => {
  const attemptRef = { attempt_id: 'att_1', generation: 1 }
  const operation = { kind: 'edit' as const, summary: 'x', paths: ['/w/a'] }
  const evidence = { raw: null, worktree: '/w' }
  const later = '2099-01-01T00:00:00.000Z'

  it('records each ask, and hands a row that keeps its sandbox to the decider', async () => {
    const asked: unknown[] = []
    const claude = ENGINE_ROWS.claude
    if (claude === undefined) throw new Error('no claude row')
    const bridge = bridgeOf(
      claude,
      { request: async () => 'allow' },
      { permissionRequested: (_a, _i, op) => asked.push(op) },
      (fn) => fn(),
    )
    await expect(bridge.request(attemptRef, operation, evidence, later)).resolves.toBe('allow')
    expect(asked).toEqual([operation])
  })

  it('never asks the decider for a row whose asks leave the sandbox', async () => {
    const codex = ENGINE_ROWS.codex
    if (codex === undefined) throw new Error('no codex row')
    const bridge = bridgeOf(
      codex,
      { request: async () => 'allow' },
      { permissionRequested: () => {} },
      (fn) => fn(),
    )
    await expect(bridge.request(attemptRef, operation, evidence, later)).resolves.toBe('deny')
  })
})
