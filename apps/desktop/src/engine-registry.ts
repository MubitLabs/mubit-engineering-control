/**
 * The engines this build may launch (§9): one row each, added only when that engine's own proof
 * passed. One engine's pass never certifies another. A slot outside these rows refuses with no
 * spend, and neither the planner nor the launch can land on it.
 *
 * A row holds what differs between engines: its sandbox, what reaches the process, how an ask is
 * answered and how the adapter is built. The launch order, the worktree, the token, the journal
 * and the checks are the same for every engine and stay in `attempt-launch.ts`.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import type {
  AttemptRef,
  Capabilities,
  EngineAdapter,
  IsolationProfile,
  LaunchSpec,
  Operation,
  PermissionBridge,
  ProviderId,
  StoreDoc,
} from '@mec/contracts'
import type { WorkerReach } from '@mec/domain'
import {
  ClaudeAdapter,
  CODEX_ENGINE_VERSION,
  CODEX_FLAGS_VERIFIED,
  CodexAdapter,
  OPENCODE_ENGINE_VERSION,
  OPENCODE_FLAGS_VERIFIED,
  OPENCODE_PROVEN_VERSIONS,
  OpenCodeAdapter,
} from '@mec/engines'
import {
  buildAttemptSettings,
  CODEX_PROFILE,
  type CodexModelListing,
  checkDrift,
  codexAttemptArgs,
  codexOtherServers,
  defaultDenyRead,
  listCodexModels,
  type OpenCodeRule,
  type OwnedSpawn,
  opencodeAttemptConfig,
  opencodeSlotEnv,
  ownedSpawn,
  Supervisor,
  serialiseAttemptSettings,
  startCodexClient,
  startOpenCodeClient,
} from '@mec/runtime'
import { engineHomeEnv, SlotKeystore } from '@mec/slots'
import { judgeOperation } from './specialist-tools'

/** §13's always-confirm commands, refused by the engine itself: see the Claude row. */
const CLAUDE_DENIED_TOOLS = 'Bash(git push:*),Bash(gh:*)'

const PROBE_TIMEOUT_MS = 60_000

/** A repository's file list can be long, and a cut one would pass links unseen. */
const LISTING_BYTES = 256 * 1024 * 1024

/** What `docs/log/HANDSHAKES.md` shows of Codex through the runner, and it equals the adapter's probe. */
const CODEX_CAPABILITIES: Capabilities = {
  engine_version: CODEX_ENGINE_VERSION,
  flags_verified: [...CODEX_FLAGS_VERIFIED],
  structured_stream: true,
  questions: false,
  tool_approval: true,
  interrupt: false,
  resume: false,
  usage: true,
  rate_limit_events: true,
  sandbox: true,
  restricted_mode: false,
  mcp_http: true,
  usage_mode: 'cumulative',
}

/** What a launch knows by the time a row writes its files. */
export type PrepareContext = {
  attemptId: string
  worktree: string
  tempDir: string
  homeDir: string
  dataDir: string
  sharedClone: string
  isolation: IsolationProfile
  toolsUrl: string
  binary: string
  /** The slot's env, for a vendor command this launch has to run before the engine starts. */
  probeEnv: Record<string, string>
}

/** What a row hands the launch. `env` joins the attempt layer; `briefEnv` rides the brief. */
export type Prepared = {
  env?: Record<string, string>
  briefEnv?: Record<string, string>
  /** The engine's argv, once the launch's model is known. */
  argv?: (spec: LaunchSpec) => readonly string[]
}

export type AdapterContext = {
  binary: string
  cwd: string
  prepared: Prepared
  spawn: (hooks: { stdin: boolean }) => OwnedSpawn
  /** A key read at launch (§5.4), for this process only. */
  secrets: Record<string, string>
  /** Text for the attempt's failure reason, which carries the engine's stderr tail and this. */
  onFailure: (detail: string) => void
}

export type EngineRow = {
  engine: string
  /** Slot kinds this row proved. */
  kinds: readonly string[]
  sandbox: IsolationProfile['sandbox']
  /** Domains the attempt's sandbox allows, which is the engine's own and nothing else. */
  domains: readonly string[]
  /** The versions a proof ran on. `undefined` keeps today's unpinned launch (Claude, M2.1). */
  pinned?: readonly string[]
  /** What that proof showed, which is all a build may advertise (§9). */
  capabilities?: Capabilities
  /** Whether a launch can run with no model: an OpenCode session inherits none. */
  modelRequired: boolean
  /** §5.12's slot layer. */
  hygiene: (attemptId: string) => Record<string, string>
  /** The variables that put a process under a slot's home (§5.3). */
  homeEnv: (home: string) => Record<string, string>
  /** Whether the token also lands in `.mec/mcp.json`; other engines read it from the env. */
  tokenFile: boolean
  /** The lines of the worker's brief that say what its shell can do. */
  notes: readonly string[]
  /**
   * Whether every ask is a request to leave the sandbox. On Codex an allowed command runs
   * unsandboxed, so nothing a worker asks for is the decider's to grant.
   */
  asksLeaveSandbox: boolean
  prepare: (ctx: PrepareContext) => Promise<Prepared> | Prepared
  adapter: (ctx: AdapterContext) => EngineAdapter
  /** Its version and login now, spending nothing; a row with none keeps today's launch. */
  probe?: (binary: string, env: Record<string, string>) => Promise<EngineProbe>
  /**
   * The models the slot's home offers, spending nothing (§3 rule 2). Asked only once the probe
   * passed; a row with none resolves on the table alone.
   */
  listModels?: (binary: string, env: Record<string, string>) => Promise<CodexModelListing>
  /** The slot's key, read at launch: never in the attempt's env, which reaches its shell. */
  secretsOf?: (slot: StoreDoc) => Record<string, string>
}

export type EngineProbe = {
  capabilities: Capabilities
  auth: { logged_in: boolean; detail?: string }
}

/** One vendor command, with the slot's env and nothing of the host's. */
function run(
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const options = { env, timeout: PROBE_TIMEOUT_MS, maxBuffer: LISTING_BYTES }
    execFile(binary, [...args], options, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const versionOf = (text: string): string | undefined => text.match(/\d+\.\d+\.\d+/)?.[0]

const DENIED_WRITES_NOTE = [
  'Your shell is sandboxed: write only to the worktree and temp dir. The shared clone behind the worktree',
  'is read-only to your shell, so anything that writes to git fails there, and that is expected.',
  'Do not run git add or git commit: reading with git status, diff and log works.',
]

const COMMIT_NOTE = [
  'Leave your work in the worktree; MEC commits it when you finish and then runs the repository checks',
  'on that commit. A run that is stopped or runs out of turns gets no commit.',
]

const claudeRow: EngineRow = {
  engine: 'claude',
  kinds: ['claude-sub'],
  sandbox: 'required',
  domains: ['claude.ai', 'api.claude.com'],
  modelRequired: false,
  hygiene: (attemptId) => ({
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
    CLAUDE_CODE_PROJECT_DIR_NAME: attemptId,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // Owner ruling 2026-11-07: a specialist follows MEC's brief, not the owner's own CLAUDE.md,
    // which a linked home would load through `--setting-sources user`. In 2.1.319's text this
    // gates only the CLAUDE.md loaders: settings and the sign-in stay as they are.
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  }),
  homeEnv: (home) => engineHomeEnv('claude', home),
  tokenFile: true,
  notes: [...DENIED_WRITES_NOTE, ...COMMIT_NOTE],
  asksLeaveSandbox: false,
  prepare: (ctx) => {
    const settings = buildAttemptSettings(ctx.isolation, {
      worktree: ctx.worktree,
      tempDir: ctx.tempDir,
      allowedDomains: [],
      homeDir: ctx.homeDir,
      dataDir: ctx.dataDir,
      sharedClone: ctx.sharedClone,
    })
    const settingsPath = join(ctx.worktree, '.mec', 'claude-settings.json')
    writeFileSync(settingsPath, serialiseAttemptSettings(settings))
    return {
      briefEnv: {
        MEC_SETTINGS_PATH: settingsPath,
        MEC_MCP_CONFIG_PATH: join(ctx.worktree, '.mec', 'mcp.json'),
        MEC_ALLOWED_TOOLS: 'mcp__mec__*',
        // A linked slot runs under the user's own settings, whose allow rules can answer a Bash
        // ask before `mcp__mec__confirm` hears it.
        MEC_DISALLOWED_TOOLS: CLAUDE_DENIED_TOOLS,
      },
    }
  },
  // §9, §12.4: the objective and every later message go on stdin, so it stays open.
  adapter: ({ binary, spawn }) =>
    new ClaudeAdapter({ binary, streamInput: true, spawnFn: spawn({ stdin: true }) }),
}

/** What `docs/log/HANDSHAKES.md` shows of OpenCode through the runner, and it equals the adapter's probe. */
const OPENCODE_CAPABILITIES: Capabilities = {
  engine_version: OPENCODE_ENGINE_VERSION,
  flags_verified: [...OPENCODE_FLAGS_VERIFIED],
  structured_stream: true,
  questions: false,
  tool_approval: true,
  interrupt: false,
  resume: false,
  usage: true,
  rate_limit_events: false,
  sandbox: false,
  restricted_mode: false,
  mcp_http: true,
  usage_mode: 'cumulative',
}

/** §5.7: where a pasted key goes at launch. `MEC_OPENCODE_KEY` is what a slot config's `{env:}` names. */
const KEY_VARS: Readonly<Record<string, string>> = {
  'zai-coding-plan': 'ZHIPU_API_KEY',
  'google-gemini': 'GOOGLE_GENERATIVE_AI_API_KEY',
}

/** Where a link really leads, following every link. One that dangles counts by its target's path. */
function linkTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(realpathSync(dirname(path)), readlinkSync(path))
  }
}

/**
 * The tracked links that lead out of the worktree. OpenCode's `read` is allowed and judged by the
 * name it was given, so a repository's link reaches any file the user can. The worker has no shell
 * to make a new one, which leaves the links the repository came with.
 */
async function linksOutside(worktree: string, env: Record<string, string>): Promise<string[]> {
  const listing = await run('git', ['-C', worktree, 'ls-files', '-z', '--stage'], env)
  if (listing.code !== 0) throw new Error('git ls-files failed, so the launch cannot check for links')
  const root = realpathSync(worktree)
  return listing.stdout
    .split('\0')
    .filter((entry) => entry.startsWith('120000 '))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
    .filter((path) => {
      const target = linkTarget(join(worktree, path))
      return target !== root && !target.startsWith(`${root}${sep}`)
    })
}

const opencodeRow: EngineRow = {
  engine: 'opencode',
  kinds: ['opencode-glm'],
  // No OS sandbox (§8.4). `off` is the truth, and the decider then refuses every shell ask.
  sandbox: 'off',
  domains: [],
  pinned: OPENCODE_PROVEN_VERSIONS,
  capabilities: OPENCODE_CAPABILITIES,
  modelRequired: true,
  // Project config stays off for a trusted repository too: nothing else stands in for a sandbox.
  hygiene: () => opencodeSlotEnv(false),
  homeEnv: (home) => engineHomeEnv('opencode', home),
  tokenFile: false,
  notes: [
    'You have no shell here: this engine has no sandbox behind it, so MEC refuses every shell command, git',
    'included. Do not retry one. Read and edit files with your file tools, inside the worktree only.',
    ...COMMIT_NOTE,
  ],
  asksLeaveSandbox: false,
  prepare: async (ctx) => {
    const links = await linksOutside(ctx.worktree, ctx.probeEnv)
    if (links.length > 0) throw new Error(`worktree_link_outside: ${links.join(', ')}`)
    const path = join(ctx.worktree, '.mec', 'opencode.json')
    writeFileSync(path, `${JSON.stringify(opencodeAttemptConfig({ toolsUrl: ctx.toolsUrl }))}\n`)
    return { env: { OPENCODE_CONFIG: path } }
  },
  adapter: ({ binary, cwd, secrets, spawn, onFailure }) =>
    new OpenCodeAdapter({
      onFailure,
      connect: (spec) =>
        startOpenCodeClient({ binary, cwd, env: spec.env, secrets, spawn: spawn({ stdin: true }) }),
    }),
  // `auth list` shows integrations only, so a key slot reads as logged out while it works: a dead
  // key arrives at the first turn as `provider.auth`, and that parks the attempt.
  probe: async (binary, env) => {
    const { capabilities } = await new OpenCodeAdapter({
      authList: async () => ({ code: 0, stdout: '[]', stderr: '' }),
      versionProbe: async () => versionOf((await run(binary, ['--version'], env)).stdout),
    }).probe()
    return { capabilities, auth: { logged_in: true } }
  },
  secretsOf: (slot): Record<string, string> => {
    const name = KEY_VARS[String(slot.provider)]
    if (name === undefined || typeof slot.home !== 'string') return {}
    const key = new SlotKeystore(slot.home).read(slot.provider as ProviderId)
    return key === undefined ? {} : { [name]: key, MEC_OPENCODE_KEY: key }
  },
}

const codexRow: EngineRow = {
  engine: 'codex',
  kinds: ['codex-sub'],
  sandbox: 'required',
  domains: [],
  pinned: [CODEX_ENGINE_VERSION],
  capabilities: CODEX_CAPABILITIES,
  modelRequired: false,
  hygiene: () => ({}),
  homeEnv: (home) => engineHomeEnv('codex', home),
  tokenFile: false,
  notes: [
    ...DENIED_WRITES_NOTE,
    'Asking to leave the sandbox is always refused, so do not ask: say what you could not do in your report.',
    ...COMMIT_NOTE,
  ],
  asksLeaveSandbox: true,
  prepare: async (ctx) => {
    // A `-c` table merges into the user's, so each of a linked home's servers is named to go.
    const listing = await run(ctx.binary, ['mcp', 'list', '--json'], ctx.probeEnv)
    if (listing.code !== 0) throw new Error('codex mcp list failed, so the launch cannot fence its servers')
    const otherServers = codexOtherServers(listing.stdout)
    return {
      argv: (spec) =>
        codexAttemptArgs({
          worktree: ctx.worktree,
          tempDir: ctx.tempDir,
          sharedClone: ctx.sharedClone,
          denyRead: defaultDenyRead(ctx.homeDir, ctx.dataDir),
          toolsUrl: ctx.toolsUrl,
          otherServers,
          readOnly: ctx.isolation.read_only,
          ...(spec.model?.effort !== undefined && { effort: spec.model.effort }),
        }),
    }
  },
  adapter: ({ binary, cwd, prepared, spawn }) =>
    new CodexAdapter({
      profile: CODEX_PROFILE,
      connect: async (spec) =>
        startCodexClient({
          // By its real path: the app-server re-execs its own path for the fs helper that applies
          // a patch, under the profile. `~/.local/bin/codex` links into `~/.codex`, which the
          // profile denies, so run by the link every fileChange failed "Failed to write file"
          // (0.3.5 att_7, 0.3.6 att_10) and every update "fs sandbox helper failed" (att_15).
          binary: realpathSync(binary),
          args: prepared.argv?.(spec) ?? [],
          cwd,
          env: spec.env,
          spawn: spawn({ stdin: true }),
        }),
    }),
  probe: async (binary, env) =>
    new CodexAdapter({
      loginStatus: () => run(binary, ['login', 'status'], env),
      versionProbe: async () => versionOf((await run(binary, ['--version'], env)).stdout),
    }).probe(),
  // A ChatGPT sign-in refuses models the table names (0.3.4: gpt-6-luna, model_not_found), and
  // `model/list` on the home's own app-server says which it offers before any thread starts.
  listModels: (binary, env) =>
    listCodexModels({
      binary,
      cwd: tmpdir(),
      env,
      spawn: ownedSpawn(new Supervisor(), { attemptId: 'model-list', generation: 1 }, { stdin: true }),
    }),
}

/** Stand-in paths for reading a row's launch config: only their shape matters, nothing is touched. */
const SAMPLE = {
  worktree: '/mec-reach/work/att',
  tempDir: '/mec-reach/tmp/att',
  homeDir: '/mec-reach/home',
  dataDir: '/mec-reach/data',
  sharedClone: '/mec-reach/repo.git',
  toolsUrl: 'http://127.0.0.1:9/mcp',
}

/** The one shell command a worker asks for, as MEC's decider judges it under this row's sandbox. */
const shellAllowed = (row: EngineRow): boolean =>
  judgeOperation(
    { kind: 'shell', summary: 'npm test', command: ['npm test'] },
    { worktree: SAMPLE.worktree, tempDir: SAMPLE.tempDir, sandboxRequired: row.sandbox === 'required' },
  ).allow

/** OpenCode's last matching rule wins; `*` matches any action. */
function opencodeEffect(rules: readonly OpenCodeRule[], action: string): OpenCodeRule['effect'] {
  const match = rules.filter(
    (rule) => (rule.action === '*' || rule.action === action) && rule.resource === '*',
  )
  return match.at(-1)?.effect ?? 'deny'
}

/** The isolation a launch builds for a writing role on this row (`attempt-launch.ts`). */
const sampleIsolation = (row: EngineRow): IsolationProfile => ({
  sandbox: row.sandbox,
  read_only: false,
  allow_write: [],
  deny_read: [],
  allowed_domains: [...row.domains],
  blocked_commands: [],
  background_cap_ms: 0,
  permission_mode: 'bridge',
  repo_trusted: false,
})

/**
 * What a writing worker on this row can do (owner's horse tinder test, 9 November 2026), read off
 * the config the row really writes, never typed in by hand: OpenCode's attempt permission rules and
 * the decider that answers its asks, Claude's sandbox settings, Codex's sandbox profile. The
 * planner sees it per connection, and plans and placement keep work that needs commands off a
 * worker that cannot run them.
 */
export function reachOf(row: EngineRow): WorkerReach {
  if (row.engine === 'opencode') {
    const rules = opencodeAttemptConfig({ toolsUrl: SAMPLE.toolsUrl }).agents.build.permissions
    const shell = opencodeEffect(rules, 'shell')
    const commands = shell === 'allow' || (shell === 'ask' && shellAllowed(row))
    return {
      commands,
      edits: opencodeEffect(rules, 'edit') !== 'deny',
      network: opencodeEffect(rules, 'webfetch') !== 'deny',
    }
  }
  if (row.engine === 'codex') {
    const argv = codexAttemptArgs({
      worktree: SAMPLE.worktree,
      tempDir: SAMPLE.tempDir,
      sharedClone: SAMPLE.sharedClone,
      denyRead: defaultDenyRead(SAMPLE.homeDir, SAMPLE.dataDir),
      toolsUrl: SAMPLE.toolsUrl,
      otherServers: [],
      readOnly: false,
    })
    // Every ask leaves the sandbox and is refused, so a command runs only inside it, unasked.
    return {
      commands: row.sandbox === 'required',
      edits: argv.some((arg) => arg.includes(`${JSON.stringify(SAMPLE.worktree)}="write"`)),
      network: argv.some((arg) => arg.includes('network')) || !argv.includes('web_search="disabled"'),
    }
  }
  const settings = buildAttemptSettings(sampleIsolation(row), {
    worktree: SAMPLE.worktree,
    tempDir: SAMPLE.tempDir,
    allowedDomains: [],
    homeDir: SAMPLE.homeDir,
    dataDir: SAMPLE.dataDir,
    sharedClone: SAMPLE.sharedClone,
  })
  const own = new Set(row.domains)
  return {
    commands: settings.sandbox.enabled && shellAllowed(row),
    edits: settings.sandbox.filesystem.allowWrite.includes(SAMPLE.worktree),
    network: settings.sandbox.network.allowedDomains.some((domain) => !own.has(domain)),
  }
}

/** Where the last listing of a slot's models is kept, for planning between launches. */
export const modelListingId = (slotId: string): string => `slot-models/${slotId}`

/** The rows, each added only with its own proof. */
export const ENGINE_ROWS: Readonly<Record<string, EngineRow>> = {
  claude: claudeRow,
  codex: codexRow,
  opencode: opencodeRow,
}

/**
 * §5.3, the probe's rule: a linked slot runs with its home variable unset and any other runs
 * under its home. Without a home it has nowhere to run but the default login, which is not its own.
 */
export const lacksHome = (slot: StoreDoc): boolean =>
  slot.linkedDefault !== true && (typeof slot.home !== 'string' || slot.home === '')

/** Whether a launch of this slot could start at all: engine, kind and home, health aside. */
export function isLaunchableSlot(slot: StoreDoc): boolean {
  return ENGINE_ROWS[String(slot.engine)]?.kinds.includes(String(slot.kind)) === true && !lacksHome(slot)
}

/** A version or a capability the proof relied on is gone: the slot degrades, and nothing runs. */
export function driftOf(row: EngineRow, probe: EngineProbe): string | undefined {
  if (row.capabilities === undefined) return undefined
  if (!row.pinned?.includes(probe.capabilities.engine_version)) {
    return `engine ${row.engine} is ${probe.capabilities.engine_version}; this build proved ${row.pinned?.join(', ')}`
  }
  const drift = checkDrift(probe.capabilities, row.capabilities.flags_verified)
  return drift.degraded ? drift.detail : undefined
}

/** Records the ask, then answers it. A row whose asks leave the sandbox never reaches the decider. */
export function bridgeOf(
  row: EngineRow,
  decider: PermissionBridge,
  facts: { permissionRequested(attempt: AttemptRef, id: string, operation: Operation): void },
  atomic: <T>(fn: () => T) => T,
): PermissionBridge {
  return {
    request: (attempt, operation, evidence, deadline) => {
      const id = createHash('sha256').update(JSON.stringify(operation)).digest('hex').slice(0, 16)
      atomic(() => facts.permissionRequested(attempt, id, operation))
      if (row.asksLeaveSandbox) return Promise.resolve('deny')
      return decider.request(attempt, operation, evidence, deadline)
    },
  }
}
