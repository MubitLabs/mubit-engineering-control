/**
 * The Codex client (plan §9): one `codex app-server` per attempt (decision #31), speaking JSON-RPC
 * over stdio through an owned spawn, so the process group is the attempt's and stop confirms it
 * gone. `CodexAdapter` takes this shape through its `connect` seam; `@mec/engines` depends on this
 * package, so the shape is structural here.
 *
 * Everything an attempt needs reaches the process on its argv and in its environment, because the
 * token, `MEC_*` and the worktree are the attempt's and §6's slot config is not.
 *
 * - The sandbox is a named permissions profile, not `sandbox: workspace-write`: only a profile says
 *   what a worktree needs. `:root` reads, the worktree and temp dir write, the shared clone stays
 *   readable and unwritable, and the deny list refuses reading too. `thread/start` must then leave
 *   `sandbox` out: 0.148.0 drops the profile when it is sent. The adapter checks the profile came
 *   back active.
 * - `thread/start` under a profile that can write the cwd marks the repo cache trusted in the
 *   home's config.toml, then loads the repository's `.codex/` (§8.4 says never). Naming the cache
 *   `untrusted` stops both; `project_root_markers=[]` does not.
 * - `:root` reads, so other attempts' worktrees and temp dirs go by name: a sibling's `.mec/mcp.json`
 *   is a live bearer. The most specific entry wins, which keeps this attempt's own.
 * - A `-c` table merges into the user's, so MCP servers do not go by replacing the table: each is
 *   named and disabled, and a server that cannot be named refuses the launch.
 */
import { dirname } from 'node:path'
import type { Writable } from 'node:stream'
import type { OwnedSpawn } from './owned-spawn'

/** The one attempt-scoped secret, by name. The token itself stays in the process environment. */
export const CODEX_TOKEN_VAR = 'MEC_TOOLS_TOKEN'

/** The name `default_permissions` selects; the adapter checks it came back active. */
export const CODEX_PROFILE = 'mec'

/** Long enough for a loaded machine, short enough that a wedged server does not hold a launch job. */
const REQUEST_TIMEOUT_MS = 60_000

/** What a linked home would otherwise add to a worker. A dedicated slot's home has none of it. */
const DISABLED_FEATURES = [
  'hooks',
  'plugins',
  'apps',
  'memories',
  'computer_use',
  'browser_use',
  'in_app_browser',
  'image_generation',
  'shell_snapshot',
  'tool_suggest',
  'multi_agent',
]

/** A name that is safe as a bare TOML key on a `-c` line. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/

export type CodexServerRef = { name: string; transport: string }

export type CodexAttemptOptions = {
  worktree: string
  tempDir: string
  /** The bare clone behind the worktree: readable, for git, and never writable. */
  sharedClone: string
  /** Paths refused for reading and writing, the same list Claude's sandbox gets. */
  denyRead: readonly string[]
  toolsUrl: string
  /** The MCP servers this home's config adds, each of which is switched off. */
  otherServers: readonly CodexServerRef[]
  readOnly: boolean
  effort?: string
}

const toml = (value: string): string => JSON.stringify(value)

/** An entry that replaces a configured server; each layer must parse alone, so it stays valid. */
function disabledServer({ name, transport }: CodexServerRef): string {
  if (!BARE_KEY.test(name)) throw new Error(`codex: cannot fence MCP server ${JSON.stringify(name)}`)
  const body = transport === 'stdio' ? 'command="true"' : 'url="http://127.0.0.1:9/"'
  return `mcp_servers.${name}={${body},enabled=false}`
}

/** The `codex app-server` argv for one attempt. It names the token's variable, never the token. */
export function codexAttemptArgs(opts: CodexAttemptOptions): string[] {
  const filesystem: Record<string, string> = {
    ':root': 'read',
    [dirname(opts.worktree)]: 'deny',
    [dirname(opts.tempDir)]: 'deny',
    [opts.worktree]: opts.readOnly ? 'read' : 'write',
    [opts.tempDir]: 'write',
    [opts.sharedClone]: 'read',
    [`${opts.worktree}/.mec`]: 'read',
    [`${opts.worktree}/.git`]: 'read',
  }
  for (const path of opts.denyRead) filesystem[path] = 'deny'
  const entries = Object.entries(filesystem).map(([path, access]) => `${toml(path)}=${toml(access)}`)
  const overrides = [
    `default_permissions=${toml(CODEX_PROFILE)}`,
    `projects={${toml(dirname(opts.sharedClone))}={trust_level="untrusted"}}`,
    `permissions.${CODEX_PROFILE}={filesystem={${entries.join(',')}}}`,
    `mcp_servers.mec={url=${toml(opts.toolsUrl)},bearer_token_env_var=${toml(CODEX_TOKEN_VAR)},default_tools_approval_mode="approve"}`,
    ...opts.otherServers.filter(({ name }) => name !== 'mec').map(disabledServer),
    `shell_environment_policy.exclude=[${toml(CODEX_TOKEN_VAR)}]`,
    'allow_login_shell=false',
    'web_search="disabled"',
    ...(opts.effort === undefined ? [] : [`model_reasoning_effort=${toml(opts.effort)}`]),
  ]
  return [
    'app-server',
    ...overrides.flatMap((override) => ['-c', override]),
    ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  ]
}

/** The names and transports in `codex mcp list --json`, the only fields read from it. */
export function codexOtherServers(listing: string): CodexServerRef[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(listing)
  } catch {
    throw new Error('codex mcp list did not answer JSON, so the launch cannot fence its servers')
  }
  if (!Array.isArray(parsed)) throw new Error('codex mcp list did not answer a list')
  return (parsed as { name?: unknown; transport?: { type?: unknown } }[]).map((entry) => ({
    name: String(entry.name),
    transport: String(entry.transport?.type),
  }))
}

export type CodexClient = {
  post: (payload: unknown) => Promise<unknown>
  notifications: () => AsyncIterable<string>
  processExitCode: () => number | undefined
  pid: number | undefined
}

export type CodexClientOptions = {
  binary: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  spawn: OwnedSpawn
  requestTimeoutMs?: number
}

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export function startCodexClient(opts: CodexClientOptions): CodexClient {
  const proc = opts.spawn([opts.binary, ...opts.args], { cwd: opts.cwd, env: opts.env })
  const stdin = proc.stdin as Writable | undefined
  if (stdin === undefined) throw new Error('codex client: the spawn gave no stdin')
  const pending = new Map<number | string, Waiter>()
  const queue: string[] = []
  const wakeups: (() => void)[] = []
  let ended = false
  let exitCode: number | undefined
  const wake = (): void => {
    for (const waiter of wakeups.splice(0)) waiter()
  }
  const settle = (id: number | string): Waiter | undefined => {
    const waiter = pending.get(id)
    if (waiter !== undefined) {
      pending.delete(id)
      clearTimeout(waiter.timer)
    }
    return waiter
  }

  const take = (line: string): void => {
    if (line.trim() === '') return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return // a torn line is skipped; the parser would skip it too
    }
    const id = message.id as number | string | undefined
    const answer = message.method === undefined && id !== undefined
    const waiter = answer ? settle(id) : undefined
    if (waiter === undefined) {
      // notifications and server→client requests (approval asks) feed the adapter
      queue.push(line)
      wake()
    } else if (message.error !== undefined) {
      waiter.reject(new Error(JSON.stringify(message.error)))
    } else {
      waiter.resolve(message.result)
    }
  }

  void (async () => {
    for await (const line of proc.stdout) take(line)
    exitCode = await proc.exited
    ended = true
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(new Error(`codex app-server exited with ${exitCode}`))
    }
    wake()
  })()

  return {
    pid: proc.pid,
    post: (payload) =>
      new Promise((resolve, reject) => {
        const message = payload as { id?: number | string; method?: string }
        const line = `${JSON.stringify(payload)}\n`
        // a notification (no id) or a response to a server request (no method): nothing comes back
        if (message.method === undefined || message.id === undefined) {
          stdin.write(line, () => resolve({}))
          return
        }
        if (ended) {
          reject(new Error(`codex app-server exited with ${exitCode}`))
          return
        }
        const { id, method } = message
        const timer = setTimeout(() => {
          settle(id)?.reject(new Error(`codex app-server did not answer ${method}`))
        }, opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
        timer.unref()
        pending.set(id, { resolve, reject, timer })
        stdin.write(line)
      }),
    notifications: () => ({
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<string>> {
          while (queue.length === 0 && !ended) {
            await new Promise<void>((resolve) => wakeups.push(resolve))
          }
          return queue.length > 0
            ? { value: queue.shift() as string, done: false }
            : { value: undefined, done: true }
        },
      }),
    }),
    processExitCode: () => exitCode,
  }
}
