/**
 * The OpenCode client (plan §9): one `opencode serve --stdio` per attempt (decision #31), through
 * an owned spawn, with a password this process mints. `OpenCodeAdapter` takes this shape through
 * its `connect` seam; `@mec/engines` depends on this package, so the shape is structural here.
 *
 * Facts from the real 2.2.5 server (docs/engines.md):
 * - Stdin EOF shuts the server down, so stdin stays piped and open for its whole life.
 * - stdout's first line is `{"url": ...}`, and the rest of stdout is drained.
 * - The stream goes on talking after the verdict, so the stream here ends a grace after it, and the
 *   adapter then flushes the exit it held.
 * - A permission reply POSTed while a read of the stream is pending stalls the turn. `sse` yields
 *   line by line from inside its read loop and reads on only when the consumer asks, so the
 *   adapter's bridge call and reply happen between reads.
 *
 * There is no OS sandbox behind this engine (§8.4). The attempt config is the whole boundary, so it
 * starts from deny and names what a worker may do. The last matching rule wins.
 */
import { randomBytes } from 'node:crypto'
import type { OwnedSpawn } from './owned-spawn'

/** The attempt-scoped secret, by name. The config file holds a reference and never the token. */
export const OPENCODE_TOKEN_VAR = 'MEC_TOOLS_TOKEN'

const VERDICTS: readonly unknown[] = ['session.execution.succeeded', 'session.execution.failed']

/** By the event's name: the brief echoes back in events, and it can mention a verdict by name. */
function isVerdict(line: string): boolean {
  if (!line.startsWith('data:')) return false
  try {
    return VERDICTS.includes((JSON.parse(line.slice('data:'.length)) as { type?: unknown }).type)
  } catch {
    return false
  }
}

const START_TIMEOUT_MS = 60_000
const VERDICT_GRACE_MS = 1500

export type OpenCodeRule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }

const rule = (action: string, resource: string, effect: OpenCodeRule['effect']): OpenCodeRule => ({
  action,
  resource,
  effect,
})

/** Reading, searching and MEC's own tools. Everything else starts denied. */
const READING: readonly OpenCodeRule[] = [
  rule('*', '*', 'deny'),
  rule('read', '*', 'allow'),
  rule('read', '*.env', 'deny'),
  rule('read', '*.env.*', 'deny'),
  rule('read', '.mec/*', 'deny'),
  rule('read', '*/.mec/*', 'deny'),
  rule('glob', '*', 'allow'),
  rule('grep', '*', 'allow'),
  rule('mec_*', '*', 'allow'),
]

const WRITING: readonly OpenCodeRule[] = [...READING, rule('edit', '*', 'ask'), rule('shell', '*', 'ask')]

export type OpenCodeAttemptConfig = {
  mcp: { servers: { mec: Record<string, unknown> } }
  agents: { build: { permissions: OpenCodeRule[] }; plan: { permissions: OpenCodeRule[] } }
}

/** The `OPENCODE_CONFIG` file of one attempt, with no secret in it. */
export function opencodeAttemptConfig(opts: { toolsUrl: string }): OpenCodeAttemptConfig {
  return {
    mcp: {
      servers: {
        mec: {
          type: 'remote',
          url: opts.toolsUrl,
          headers: { Authorization: `Bearer {env:${OPENCODE_TOKEN_VAR}}` },
          oauth: false,
          codemode: false,
        },
      },
    },
    agents: { build: { permissions: [...WRITING] }, plan: { permissions: [...READING] } },
  }
}

export type OpenCodeClient = {
  post: (path: string, body?: unknown) => Promise<unknown>
  sse: () => AsyncIterable<string>
  /** Resolves when the stream is open: the first event of a session goes out only once. */
  ready: () => Promise<void>
  pid: number | undefined
}

export type OpenCodeClientOptions = {
  binary: string
  cwd: string
  env: Record<string, string>
  /** For this process only: a key read at launch (§5.4), never in the attempt's env or plan. */
  secrets?: Record<string, string>
  spawn: OwnedSpawn
  startTimeoutMs?: number
  verdictGraceMs?: number
}

/** The first stdout line, then a drain: an unread pipe would stall the server. */
async function urlFrom(proc: ReturnType<OwnedSpawn>, timeoutMs: number): Promise<string> {
  const lines = proc.stdout[Symbol.asyncIterator]()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('opencode serve printed no url line in time')), timeoutMs)
    timer.unref()
  })
  try {
    const first = await Promise.race([lines.next(), timeout])
    if (first.done === true) throw new Error('opencode serve exited before its url line')
    const url = (JSON.parse(first.value) as { url?: unknown }).url
    if (typeof url !== 'string') throw new Error('opencode serve printed no url')
    void (async () => {
      for (;;) {
        const next = await lines.next()
        if (next.done === true) return
      }
    })()
    return url
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('opencode serve printed no url line')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function startOpenCodeClient(opts: OpenCodeClientOptions): Promise<OpenCodeClient> {
  const password = randomBytes(24).toString('hex')
  const argv = [opts.binary, 'serve', '--hostname', '127.0.0.1', '--port', '0', '--stdio']
  const proc = opts.spawn(argv, {
    cwd: opts.cwd,
    env: { ...opts.env, ...opts.secrets, OPENCODE_PASSWORD: password },
  })
  const url = await urlFrom(proc, opts.startTimeoutMs ?? START_TIMEOUT_MS)
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const graceMs = opts.verdictGraceMs ?? VERDICT_GRACE_MS

  let opened: () => void = () => {}
  let failed: (error: Error) => void = () => {}
  const open = new Promise<void>((resolve, reject) => {
    opened = resolve
    failed = reject
  })
  // A launch that never subscribes must not leave an unhandled rejection behind.
  open.catch(() => {})

  const post = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`opencode ${path} answered ${response.status}: ${text.slice(0, 200)}`)
    // The permission reply answers 204 with an empty body, which is no JSON.
    return text.trim() === '' ? undefined : (JSON.parse(text) as unknown)
  }

  const sse = async function* (): AsyncIterable<string> {
    let response: Response
    try {
      response = await fetch(`${url}/api/event`, {
        headers: { authorization, accept: 'text/event-stream' },
      })
    } catch (error) {
      failed(error as Error)
      throw error
    }
    if (!response.ok || response.body === null) {
      const error = new Error(`opencode /api/event answered ${response.status}`)
      failed(error)
      throw error
    }
    opened()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let verdictAt: number | undefined
    try {
      for (;;) {
        const remaining = verdictAt === undefined ? undefined : verdictAt + graceMs - Date.now()
        if (remaining !== undefined && remaining <= 0) return
        // A server that dies drops the connection: the stream is over, and exit-last says why.
        const chunk = await readUntil(reader, remaining).catch(() => undefined)
        if (chunk === undefined || chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.trim() === '') continue
          if (verdictAt === undefined && isVerdict(line)) verdictAt = Date.now()
          yield line
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  return { post, sse, ready: () => open, pid: proc.pid }
}

/** One read, or nothing once `ms` has gone. Only the time after a verdict is bounded. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number | undefined,
): Promise<Awaited<ReturnType<typeof reader.read>> | undefined> {
  if (ms === undefined) return reader.read()
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([reader.read(), late])
  } finally {
    clearTimeout(timer)
  }
}
