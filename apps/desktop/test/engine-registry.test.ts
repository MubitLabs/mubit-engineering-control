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
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAdapter, OpenCodeAdapter } from '@mec/engines'
import { repoFields } from '@mec/meta'
import { SlotKeystore } from '@mec/slots'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  process.env.MEC_REAL_RUNNER = '0'
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}, 120_000)

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
    store.engines.save({
      id: 'repo_a',
      url: repo,
      bootstrap: [],
      checks: checks ?? [],
      trust: false,
      hostRunAgreedAt: '2026-11-05T08:00:00.000Z',
    })
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

async function until(test: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const attempt = (dataDir: string) => peek(dataDir, (store) => store.attempts.get('att_1'))

const SETTLED = ['succeeded', 'checks_failed', 'failed', 'interrupted', 'work_complete']

async function launched(dataDir: string, settled = SETTLED): Promise<Record<string, unknown>> {
  process.env.MEC_REAL_RUNNER = '1'
  const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 4000 })
  closers.push(server.close)
  await until(() => settled.includes(String(attempt(dataDir)?.state)))
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

  it('a kind that has not run for real is refused: opencode-gemini has no proof', async () => {
    const { dataDir, repo, bin } = scratch('opencode', { steps: [] })
    const slot = { engine: 'opencode', kind: 'opencode-gemini', provider: 'google-gemini' }
    seed(dataDir, repo, { slot, task: { modelRequest: { model: 'gemini-x', reason: 'cheap' } } })
    const end = await launched(dataDir)
    expect(String(end.terminal_reason)).toContain('slot_kind_unsupported')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it("a Claude specialist loads no CLAUDE.md, so a linked home's personal instructions stay out", () => {
    // Owner ruling 2026-11-07: specialists follow MEC's brief and the repository's instructions only.
    expect(ENGINE_ROWS.claude?.hygiene('att_1')).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' })
  })

  it('the planner sees exactly what a launch would accept', () => {
    const home = '/slots/one'
    expect(isLaunchableSlot({ id: 's', engine: 'codex', kind: 'codex-sub', home })).toBe(true)
    expect(isLaunchableSlot({ id: 's', engine: 'opencode', kind: 'opencode-glm', home })).toBe(true)
    expect(isLaunchableSlot({ id: 's', engine: 'opencode', kind: 'opencode-gemini', home })).toBe(false)
    expect(isLaunchableSlot({ id: 's', engine: 'codex', kind: 'codex-api', home })).toBe(false)
    expect(isLaunchableSlot({ id: 's', engine: 'gemini', kind: 'codex-sub', home })).toBe(false)
    expect(isLaunchableSlot({ id: 's', engine: 'codex', kind: 'codex-sub' })).toBe(false)
    expect(isLaunchableSlot({ id: 's', engine: 'codex', kind: 'codex-sub', linkedDefault: true })).toBe(true)
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

describe('Codex through the runner', { timeout: 180_000 }, () => {
  const ROW = ENGINE_ROWS.codex
  if (ROW === undefined) throw new Error('no codex row')

  it('advertised capabilities equal the probe', async () => {
    const { capabilities } = await new CodexAdapter({
      versionProbe: async () => '0.148.0',
      loginStatus: async () => ({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' }),
    }).probe()
    expect(ROW.capabilities).toEqual(capabilities)
    expect(ROW.pinned).toContain(capabilities.engine_version)
  })

  it('a turn gives a report, a commit on the head, and checks on that head', async () => {
    const { dataDir, repo, seen, root } = scratch('codex', { steps: SUCCESS })
    seed(dataDir, repo, { slot: CODEX_SLOT, checks: CHECKS })
    const end = await launched(dataDir, ['succeeded', 'checks_failed', 'failed'])
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
    expect(seen().token_file).toBe(false)
    expect(existsSync(join(String(end.worktree), '.mec', 'mcp.json'))).toBe(false)
  })

  it('the slot layer reaches the engine', async () => {
    const dedicated = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dedicated.dataDir, dedicated.repo, {
      slot: { ...CODEX_SLOT, home: '/slots/codex/one', env: { CODEX_HOME: '/slots/codex/one' } },
    })
    await launched(dedicated.dataDir)
    expect(dedicated.seen().codex_home).toBe('/slots/codex/one')
  })

  // §5.3's probe rule, by the engine's own variable: only `linkedDefault` means "unset".
  it('a slot saved with no env runs under its home, by the Codex variable', async () => {
    const { dataDir, repo, seen } = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dataDir, repo, { slot: { ...CODEX_SLOT, home: '/slots/codex/old', env: undefined } })
    await launched(dataDir)
    expect(seen().codex_home).toBe('/slots/codex/old')
    expect(seen().env_names).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('a slot of its own runs under its home, whatever its stored env says', async () => {
    const { dataDir, repo, seen } = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dataDir, repo, {
      slot: { ...CODEX_SLOT, home: '/slots/codex/own', env: { CODEX_HOME: '/home/someone/.codex' } },
    })
    await launched(dataDir)
    expect(seen().codex_home).toBe('/slots/codex/own')
  })

  it('a linked slot keeps the variable unset, whatever its stored env says', async () => {
    const { dataDir, repo, seen } = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dataDir, repo, {
      slot: {
        ...CODEX_SLOT,
        linkedDefault: true,
        home: '/home/someone/.codex',
        env: { CODEX_HOME: '/home/someone/.codex' },
      },
    })
    await launched(dataDir)
    expect(seen().codex_home).toBeNull()
  })

  it('a slot of its own with no home is refused with no spend', async () => {
    const { dataDir, repo, bin } = scratch('codex', { steps: [] })
    seed(dataDir, repo, { slot: { ...CODEX_SLOT, home: undefined } })
    const end = await launched(dataDir)
    expect(String(end.terminal_reason)).toContain('slot_home_missing: slot_x')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
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

  it("the profile refuses sibling attempts and keeps this attempt's own paths", async () => {
    const { dataDir, repo, seen } = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    await launched(dataDir)
    const profile = (seen().argv as string[]).find((arg) => arg.startsWith('permissions.mec=')) ?? ''
    expect(profile).toContain(`"${dataDir}/work"="deny"`)
    expect(profile).toContain(`"${dataDir}/tmp"="deny"`)
    expect(profile).toContain(`"${dataDir}/work/att_1"="write"`)
    expect(profile).toContain(`"${dataDir}/tmp/att_1"="write"`)
  })

  it('the repo cache is named untrusted, so thread/start cannot trust it (§8.4)', async () => {
    const { dataDir, repo, seen } = scratch('codex', { steps: [{ complete: 'completed' }] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    await launched(dataDir)
    const cache = realpathSync(join(dataDir, 'repos'))
    expect(seen().argv).toContain(`projects={"${cache}"={trust_level="untrusted"}}`)
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
    }, 30_000)
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

  it('a stop ends interrupted, with the group confirmed gone', async () => {
    const { dataDir, repo, seen } = scratch('codex', { steps: [{ sleep: 60_000 }] })
    seed(dataDir, repo, { slot: CODEX_SLOT, task: { budget: { wall_clock_ms: 800 } } })
    const end = await launched(dataDir)
    expect(end.state).toBe('interrupted')
    expect(() => process.kill(seen().pid, 0)).toThrow()
  })

  it('a stop takes a running command with it, in its own process group (§8.1)', async () => {
    const steps = [{ command: 60 }, { sleep: 60_000 }]
    const { dataDir, repo, bin } = scratch('codex', { steps })
    seed(dataDir, repo, { slot: CODEX_SLOT, task: { budget: { wall_clock_ms: 3000 } } })
    const end = await launched(dataDir)
    const pid = Number(readFileSync(join(bin, 'command.pid'), 'utf8'))
    try {
      expect(end.state).toBe('interrupted')
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone, as it should be
      }
    }
  })

  it('interrupted waits for a command that ignores SIGTERM (§8.1)', async () => {
    const steps = [{ stubborn: 60 }, { sleep: 60_000 }]
    const { dataDir, repo, bin } = scratch('codex', { steps })
    seed(dataDir, repo, { slot: CODEX_SLOT, task: { budget: { wall_clock_ms: 3000 } } })
    const end = await launched(dataDir)
    const pid = Number(readFileSync(join(bin, 'command.pid'), 'utf8'))
    try {
      expect(end.state).toBe('interrupted')
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone, as it should be
      }
    }
  })

  it('a stop takes a job the command backgrounded, which no parent leads to (§8.1)', async () => {
    const steps = [{ background: 60 }, { sleep: 60_000 }]
    const { dataDir, repo, bin } = scratch('codex', { steps })
    seed(dataDir, repo, { slot: CODEX_SLOT, task: { budget: { wall_clock_ms: 3000 } } })
    const end = await launched(dataDir)
    const pid = Number(readFileSync(join(bin, 'command.pid'), 'utf8'))
    try {
      expect(end.state).toBe('interrupted')
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone, as it should be
      }
    }
  })

  // SIGKILL that does not take is the kernel's doing, so only that much is faked.
  it('a command SIGKILL cannot take leaves a failed attempt, not an interrupted one (§8.1)', async () => {
    const steps = [{ stubborn: 60 }, { sleep: 60_000 }]
    const { dataDir, repo, bin } = scratch('codex', { steps })
    seed(dataDir, repo, { slot: CODEX_SLOT, task: { budget: { wall_clock_ms: 1500 } } })
    const commandPid = (): number | undefined => {
      const path = join(bin, 'command.pid')
      return existsSync(path) ? Number(readFileSync(path, 'utf8')) : undefined
    }
    const kill = process.kill.bind(process)
    const spy = vi
      .spyOn(process, 'kill')
      .mockImplementation((target, signal) =>
        Math.abs(target) === commandPid() ? true : kill(target, signal),
      )
    try {
      const end = await launched(dataDir)
      expect(end.state).toBe('failed')
      expect(String(end.terminal_reason)).toContain('refused to die')
    } finally {
      spy.mockRestore()
      const pid = commandPid()
      if (pid !== undefined) kill(pid, 'SIGKILL')
    }
  })

  it('a group that outlives its failed attempt holds capacity until it goes (§8.1)', async () => {
    const steps = [{ stubborn: 60 }, { sleep: 60_000 }]
    const { dataDir, repo, bin } = scratch('codex', { steps })
    seed(dataDir, repo, { slot: CODEX_SLOT, task: { budget: { wall_clock_ms: 1500 } } })
    const commandPid = (): number | undefined => {
      const path = join(bin, 'command.pid')
      return existsSync(path) ? Number(readFileSync(path, 'utf8')) : undefined
    }
    const kill = process.kill.bind(process)
    const spy = vi
      .spyOn(process, 'kill')
      .mockImplementation((target, signal) =>
        Math.abs(target) === commandPid() ? true : kill(target, signal),
      )
    const reapLater = (): void => {
      const pid = commandPid()
      if (pid === undefined) return
      try {
        kill(-pid, 'SIGKILL')
      } catch {
        // gone, as it should be
      }
    }
    try {
      const end = await launched(dataDir)
      expect(end.state).toBe('failed')
      const held = end.held_groups as { pid: number; started: string }[]
      expect(held.map((mark) => mark.pid)).toContain(commandPid())
      await new Promise((resolve) => setTimeout(resolve, 3000))
      expect(attempt(dataDir)?.held_groups).toBeDefined()

      spy.mockRestore()
      reapLater()
      await until(() => attempt(dataDir)?.held_groups === undefined, 20_000)
      expect(attempt(dataDir)?.state).toBe('failed')
      const events = peek(dataDir, (store) => store.events.read('attempt:att_1').map((event) => event.type))
      expect(events).toContain('attempt.capacity_released')
    } finally {
      spy.mockRestore()
      reapLater()
    }
  })

  it('the server dying mid-turn fails the attempt, it does not hang', async () => {
    const { dataDir, repo } = scratch('codex', { steps: [{ exit: 3 }] })
    seed(dataDir, repo, { slot: CODEX_SLOT })
    const end = await launched(dataDir)
    expect(end.state).toBe('failed')
  })
})

const GLM_SLOT = { engine: 'opencode', kind: 'opencode-glm', provider: 'zai-coding-plan' }
const GLM_TASK = { modelRequest: { model: 'glm-5.3-flash', reason: 'cheap' } }

const OPENCODE_SUCCESS = [
  { event: { type: 'session.text.ended', data: { text: 'done' } } },
  { write: { path: 'made.txt', text: 'made\n' } },
  { saveToken: true },
  { call: { tool: 'report', args: { kind: 'ready', summary: 'made the file' } } },
  { verdict: 'succeeded' },
]

describe('OpenCode through the runner', { timeout: 180_000 }, () => {
  const ROW = ENGINE_ROWS.opencode
  if (ROW === undefined) throw new Error('no opencode row')
  const WITH_TASK = { slot: GLM_SLOT, task: GLM_TASK }

  it('advertised capabilities equal the probe', async () => {
    const { capabilities } = await new OpenCodeAdapter({
      versionProbe: async () => '2.2.5',
      authList: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    }).probe()
    expect(ROW.capabilities).toEqual(capabilities)
    expect(ROW.pinned).toContain(capabilities.engine_version)
  })

  it('a turn gives a report, a commit on the head, and checks on that head', async () => {
    const { dataDir, repo } = scratch('opencode', { steps: OPENCODE_SUCCESS })
    seed(dataDir, repo, { ...WITH_TASK, checks: CHECKS })
    const end = await launched(dataDir, ['succeeded', 'checks_failed', 'failed'])
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
  })

  it('states there is no sandbox, on the attempt and in the brief', async () => {
    const { dataDir, repo } = scratch('opencode', { steps: [{ verdict: 'succeeded' }] })
    seed(dataDir, repo, WITH_TASK)
    const end = await launched(dataDir)
    expect(end.sandbox).toBe('off')
  })

  it('project config stays off, and the attempt config is the one it reads', async () => {
    const { dataDir, repo, seen } = scratch('opencode', { steps: [{ verdict: 'succeeded' }] })
    seed(dataDir, repo, WITH_TASK)
    const end = await launched(dataDir)
    expect(seen().project_config_off).toBe('1')
    expect(seen().config_path).toBe(join(String(end.worktree), '.mec', 'opencode.json'))
  })

  it('token is absent from argv, files, docs and events', async () => {
    const { dataDir, repo, seen, bin } = scratch('opencode', { steps: OPENCODE_SUCCESS })
    seed(dataDir, repo, WITH_TASK)
    const end = await launched(dataDir)
    const token = readFileSync(join(bin, 'token.txt'), 'utf8')
    expect(token.length).toBeGreaterThan(20)
    expect(JSON.stringify(seen())).not.toContain(token)
    expect(allDurable(dataDir)).not.toContain(token)
    const config = readFileSync(join(String(end.worktree), '.mec', 'opencode.json'), 'utf8')
    expect(config).not.toContain(token)
  })

  it('a pasted key reaches this process only, and is redacted wherever it comes back', async () => {
    const steps = [
      { event: { type: 'session.text.ended', data: { text: 'the key is key-value-0123456789' } } },
      { verdict: 'succeeded' },
    ]
    const { dataDir, repo, root, seen } = scratch('opencode', { steps })
    const home = join(root, 'slot')
    mkdirSync(home)
    new SlotKeystore(home).store('zai-coding-plan', 'key-value-0123456789')
    seed(dataDir, repo, { ...WITH_TASK, slot: { ...GLM_SLOT, home } })
    await launched(dataDir)
    expect(seen().env_names).toContain('ZHIPU_API_KEY')
    expect(allDurable(dataDir)).not.toContain('key-value-0123456789')
    const journal = readFileSync(join(dataDir, 'journal', 'att_1', 'events.jsonl'), 'utf8')
    expect(journal).not.toContain('key-value-0123456789')
  })

  it('every shell ask is refused, because nothing stands behind this engine', async () => {
    const steps = [
      { ask: { id: 'per_1', action: 'shell', resources: ['ls'] } },
      { ask: { id: 'per_2', action: 'shell', resources: ['git push origin main'] } },
      { verdict: 'succeeded' },
    ]
    const { dataDir, repo, lines } = scratch('opencode', { steps })
    seed(dataDir, repo, WITH_TASK)
    await launched(dataDir)
    const answers = lines('answers.jsonl') as unknown as { answer: { decision: string; message?: string } }[]
    expect(answers.map(({ answer }) => answer.decision)).toEqual(['reject', 'reject'])
    expect(answers[0]?.answer.message).toContain('MEC refused')
    const events = peek(dataDir, (store) => store.events.read('attempt:att_1'))
    expect(events.filter((event) => event.type === 'attempt.permission_requested')).toHaveLength(2)
  })

  it('an edit inside the worktree is allowed once; outside, or into a control dir, it is not', async () => {
    const steps = [
      { ask: { id: 'per_1', action: 'edit', resources: ['src/a.ts'] } },
      { ask: { id: 'per_2', action: 'edit', resources: ['/etc/passwd'] } },
      { ask: { id: 'per_3', action: 'edit', resources: ['.mec/opencode.json'] } },
      { ask: { id: 'per_4', action: 'edit', resources: ['../other/a.ts'] } },
      { verdict: 'succeeded' },
    ]
    const { dataDir, repo, lines } = scratch('opencode', { steps })
    seed(dataDir, repo, WITH_TASK)
    await launched(dataDir)
    const answers = lines('answers.jsonl') as unknown as { answer: { decision: string } }[]
    expect(answers.map(({ answer }) => answer.decision)).toEqual(['once', 'reject', 'reject', 'reject'])
  })

  it('two parallel asks: the one the engine settled itself is recorded, and the turn goes on', async () => {
    const steps = [
      {
        asks: [
          { id: 'per_1', action: 'shell', resources: ['ls'] },
          { id: 'per_2', action: 'edit', resources: ['src/a.ts'] },
        ],
      },
      ...OPENCODE_SUCCESS,
    ]
    const { dataDir, repo, lines } = scratch('opencode', { steps })
    seed(dataDir, repo, { ...WITH_TASK, checks: CHECKS })
    const end = await launched(dataDir, ['succeeded', 'checks_failed', 'failed'])
    expect(end.state).toBe('succeeded')
    expect(lines('answers.jsonl')).toEqual([
      { id: 'per_1', answer: expect.objectContaining({ decision: 'reject' }) },
      { id: 'per_2', answer: { dropped: true } },
    ])
    const journal = readFileSync(join(dataDir, 'journal', 'att_1', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((text) => JSON.parse(text))
    expect(journal.filter((event) => event.type === 'permission_request')).toHaveLength(2)
    expect(
      journal.filter((event) => event.type === 'permission_result').map((event) => event.decision),
    ).toEqual(['deny', 'deny'])
    expect(peek(dataDir, (store) => store.engines.get('report/att_1/1'))).toBeDefined()
  })

  it('a reply that fails any other way ends the attempt and says why', async () => {
    const steps = [{ ask: { id: 'per_1', action: 'shell', resources: ['ls'] } }, { verdict: 'succeeded' }]
    const { dataDir, repo } = scratch('opencode', { replyFails: 500, steps })
    seed(dataDir, repo, WITH_TASK)
    const end = await launched(dataDir)
    expect(end.state).toBe('failed')
    expect(String(end.terminal_reason)).toContain('engine_crashed')
    expect(String(end.terminal_reason)).toContain('answered 500')
  })

  it('each event reaches the journal as it happens, before the verdict (§8.6)', async () => {
    const steps = [
      { event: { type: 'session.text.ended', data: { text: 'said before the verdict' } } },
      { hold: 'go' },
      { verdict: 'succeeded' },
    ]
    const { dataDir, repo, bin } = scratch('opencode', { steps })
    seed(dataDir, repo, WITH_TASK)
    process.env.MEC_REAL_RUNNER = '1'
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 4000 })
    closers.push(server.close)
    const journal = join(dataDir, 'journal', 'att_1', 'events.jsonl')
    await until(
      () => existsSync(journal) && readFileSync(journal, 'utf8').includes('said before the verdict'),
      30_000,
    ).finally(() => writeFileSync(join(bin, 'go'), ''))
    await until(() => SETTLED.includes(String(attempt(dataDir)?.state)))
    expect(attempt(dataDir)?.state).not.toBe('failed')
  })

  // §5.3's probe rule, by the engine's own variables: the slot's XDG dirs, not the user's.
  it('a slot saved with no env runs under its home, by the XDG variables', async () => {
    const { dataDir, repo, seen } = scratch('opencode', { steps: [{ verdict: 'succeeded' }] })
    seed(dataDir, repo, { ...WITH_TASK, slot: { ...GLM_SLOT, home: '/slots/opencode/old', env: undefined } })
    await launched(dataDir)
    expect(seen().xdg_config_home).toBe('/slots/opencode/old/config')
    expect(seen().opencode_config_dir).toBe('/slots/opencode/old/config')
    expect(seen().xdg_data_home).toBe('/slots/opencode/old/data')
    expect(seen().env_names).not.toContain('CLAUDE_CONFIG_DIR')
  })

  describe('a committed link', () => {
    const committed = (repo: string): void => {
      gitIn(repo, 'add', '--all')
      gitIn(repo, 'commit', '--quiet', '-m', 'links')
    }

    it.each([
      ['to a file', (outside: string) => outside],
      ['to a missing file', (outside: string) => `${outside}.missing`],
    ])('out of the worktree %s refuses the launch with no spend', async (_name, target) => {
      const { dataDir, repo, bin, root } = scratch('opencode', { steps: [{ verdict: 'succeeded' }] })
      const outside = join(root, 'secret.txt')
      writeFileSync(outside, 'CANARY\n')
      symlinkSync(target(outside), join(repo, 'notes.txt'))
      committed(repo)
      seed(dataDir, repo, WITH_TASK)
      const end = await launched(dataDir)
      expect(end.state).toBe('failed')
      expect(String(end.terminal_reason)).toContain('worktree_link_outside: notes.txt')
      expect(existsSync(join(bin, 'seen.json'))).toBe(false)
    })

    it('out of the worktree through a link of the repo refuses too', async () => {
      const { dataDir, repo, bin, root } = scratch('opencode', { steps: [{ verdict: 'succeeded' }] })
      symlinkSync(root, join(repo, 'up'))
      symlinkSync('up/secret.txt', join(repo, 'notes.txt'))
      writeFileSync(join(root, 'secret.txt'), 'CANARY\n')
      committed(repo)
      seed(dataDir, repo, WITH_TASK)
      const end = await launched(dataDir)
      expect(String(end.terminal_reason)).toContain('worktree_link_outside')
      expect(existsSync(join(bin, 'seen.json'))).toBe(false)
    })

    it('inside the worktree launches', async () => {
      const { dataDir, repo } = scratch('opencode', { steps: [{ verdict: 'succeeded' }] })
      mkdirSync(join(repo, 'docs'))
      symlinkSync('../a.txt', join(repo, 'docs', 'a.txt'))
      committed(repo)
      seed(dataDir, repo, WITH_TASK)
      const end = await launched(dataDir)
      expect(end.state).not.toBe('failed')
    })
  })

  it('a task with no model refuses before any spend: a session inherits none', async () => {
    const { dataDir, repo, bin } = scratch('opencode', { steps: [] })
    seed(dataDir, repo, { slot: GLM_SLOT })
    const end = await launched(dataDir)
    expect(String(end.terminal_reason)).toContain('model_refused')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it('2.2.6, proven on the real binary, launches as 2.2.5 does', async () => {
    const { dataDir, repo } = scratch('opencode', { version: 'opencode v2.2.6', steps: OPENCODE_SUCCESS })
    seed(dataDir, repo, { ...WITH_TASK, checks: CHECKS })
    const end = await launched(dataDir, ['succeeded', 'checks_failed', 'failed'])
    expect(end.state).toBe('succeeded')
  })

  it('a drifted version degrades the slot and spends nothing', async () => {
    const { dataDir, repo, bin } = scratch('opencode', { version: 'opencode v2.3.0', steps: [] })
    seed(dataDir, repo, WITH_TASK)
    const end = await launched(dataDir)
    expect(String(end.terminal_reason)).toContain('engine_unsupported')
    expect(existsSync(join(bin, 'seen.json'))).toBe(false)
  })

  it('a server that never comes up fails the attempt and leaves no process', async () => {
    const { dataDir, repo, seen } = scratch('opencode', { noUrl: true, steps: [] })
    seed(dataDir, repo, WITH_TASK)
    const end = await launched(dataDir)
    expect(end.state).toBe('failed')
    expect(String(end.terminal_reason)).toContain('opencode serve')
    const { pid } = seen()
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 30_000)
  })

  it('a stop ends interrupted, with the group confirmed gone', async () => {
    const { dataDir, repo, seen } = scratch('opencode', { steps: [{ sleep: 60_000 }] })
    seed(dataDir, repo, { slot: GLM_SLOT, task: { ...GLM_TASK, budget: { wall_clock_ms: 800 } } })
    const end = await launched(dataDir)
    expect(end.state).toBe('interrupted')
    expect(() => process.kill(seen().pid, 0)).toThrow()
  })

  it('a failed turn fails the attempt, and the stream end is what carries the exit', async () => {
    const error = { error: { type: 'provider.unknown', status: 400, message: 'bad' } }
    const steps = [{ event: { type: 'session.execution.failed', data: error } }]
    const { dataDir, repo } = scratch('opencode', { steps })
    seed(dataDir, repo, WITH_TASK)
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

  it('is quiet on each OpenCode version the proof ran, and names them all on another', () => {
    const opencode = ENGINE_ROWS.opencode
    const proven = opencode?.capabilities
    if (opencode === undefined || proven === undefined) throw new Error('no opencode row')
    const on = (engine_version: string) =>
      driftOf(opencode, { capabilities: { ...proven, engine_version }, auth: { logged_in: true } })
    expect(on('2.2.5')).toBeUndefined()
    expect(on('2.2.6')).toBeUndefined()
    expect(on('2.2.7')).toBe('engine opencode is 2.2.7; this build proved 2.2.5, 2.2.6')
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
