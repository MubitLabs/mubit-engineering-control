import type {
  AttemptHandle,
  AuthHealth,
  Capabilities,
  EngineAdapter,
  EngineEvent,
  ErrorClass,
  Input,
  LaunchSpec,
  Report,
  SlotRef,
} from '@mec/contracts'
import { classifyOpencodeError, createOpenCodeEventParser, OPENCODE_ENGINE_VERSION } from './protocol'

/**
 * OpenCode V2 adapter (plan §9). One `opencode serve --hostname 127.0.0.1 --port 0 --stdio`
 * process per slot, MEC-generated `OPENCODE_PASSWORD`, HTTP Basic user `opencode`; one
 * server session per attempt. The serve process is supervised by the runtime (plan §8.1),
 * so the adapter speaks only the V2 server API: `POST /api/session`, `POST …/prompt`,
 * `POST …/interrupt`, the permission reply endpoint and the `GET /api/event` SSE stream.
 * `deps.post` and `deps.sse` are injectable — tests inject fakes, the runtime injects the
 * authenticated client for its spawned serve process; `deps.spawnFn` is the seam that
 * client will use, unused here because no test runs the real binary.
 */

/** How long the bridge may hold a `permission.asked` before the adapter denies it. */
export const OPENCODE_PERMISSION_DEADLINE_MS = 300_000

export type OpenCodePost = (path: string, body?: unknown) => Promise<unknown>
export type OpenCodeSse = () => AsyncIterable<string>
export type OpenCodeAuthList = () => Promise<{ code: number; stdout: string; stderr: string }>
export type OpenCodeSpawnFn = (
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => { pid: number | undefined; kill(signal?: string): void }

export type OpenCodeAdapterDeps = {
  post?: OpenCodePost
  sse?: OpenCodeSse
  spawnFn?: OpenCodeSpawnFn
  authList?: OpenCodeAuthList
  /** Clock for event timestamps and bridge deadlines; injectable for deterministic tests. */
  now?: () => string
}

const defaultAuthList: OpenCodeAuthList = async () => {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    // The slot layer owns the XDG environment; until it lands, the ambient env is used.
    execFile('opencode', ['auth', 'list', '--format', 'json'], (error, stdout, stderr) => {
      resolve({
        code: error ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

type Launch = { handle: AttemptHandle; spec: LaunchSpec; sessionId: string }

export class OpenCodeAdapter implements EngineAdapter {
  private readonly launches = new Map<string, Launch>()

  constructor(private readonly deps: OpenCodeAdapterDeps = {}) {}

  async probe(_slot: SlotRef): Promise<{ capabilities: Capabilities; auth: AuthHealth }> {
    const list = this.deps.authList ?? defaultAuthList
    const result = await list()
    let entries: Record<string, unknown>[] = []
    try {
      const parsed = JSON.parse(result.stdout.trim() || '[]') as unknown
      if (Array.isArray(parsed)) entries = parsed as Record<string, unknown>[]
    } catch {
      // unparseable output is no providers, never a throw
    }
    const providers = entries
      .map(
        (entry) =>
          (typeof entry.type === 'string' ? entry.type : '') ||
          (typeof entry.id === 'string' ? entry.id : ''),
      )
      .filter((provider) => provider !== '')
    return {
      capabilities: {
        engine_version: OPENCODE_ENGINE_VERSION,
        flags_verified: ['--hostname', '--port', '--stdio', 'auth list --format json', 'run --format json'],
        structured_stream: true, // GET /api/event SSE
        questions: true, // ask_user via mec-tools
        tool_approval: true, // permission.asked + reply endpoint
        interrupt: true, // POST /interrupt
        resume: true, // server session id in the same data dir
        usage: true, // session.usage.updated
        rate_limit_events: true, // 429 RESOURCE_EXHAUSTED mapping (protocol.ts)
        sandbox: false, // no OS sandbox (plan §8.4); permissions list instead
        restricted_mode: true, // read-only agent
        mcp_http: true, // mcp.servers remote entries
        usage_mode: 'cumulative',
      },
      auth:
        providers.length > 0
          ? { logged_in: true, method: providers[0], detail: providers.join(', ') }
          : { logged_in: false, detail: 'no authenticated providers' },
    }
  }

  async launch(spec: LaunchSpec): Promise<AttemptHandle> {
    let sessionId = spec.resume?.session_id
    if (!sessionId) {
      const created = (await this.post('/api/session', {
        location: { directory: spec.cwd },
        agent: spec.brief.isolation.read_only ? 'read-only' : 'build',
        model: undefined, // the slot's provider profile owns the default model (plan §5.7)
      })) as { id?: string }
      sessionId = created.id
    }
    if (!sessionId) throw new Error('opencode adapter: POST /api/session returned no session id')
    const handle: AttemptHandle = {
      attempt_id: spec.brief.attempt_id,
      generation: spec.brief.generation,
      session_id: sessionId,
    }
    this.launches.set(spec.brief.attempt_id, { handle, spec, sessionId })
    return handle
  }

  async send(handle: AttemptHandle, input: Input): Promise<void> {
    const launch = this.requireLaunch(handle)
    await this.post(`/api/session/${launch.sessionId}/prompt`, { text: input.text })
  }

  async interrupt(handle: AttemptHandle): Promise<void> {
    const launch = this.requireLaunch(handle)
    await this.post(`/api/session/${launch.sessionId}/interrupt`)
  }

  /** Graceful stop for one attempt is the same interrupt; the serve process belongs to the slot. */
  async stop(handle: AttemptHandle): Promise<void> {
    await this.interrupt(handle)
  }

  async *events(handle: AttemptHandle): AsyncIterable<EngineEvent> {
    const launch = this.requireLaunch(handle)
    if (!this.deps.sse) throw new Error('opencode adapter: deps.sse is not wired to the serve process')
    const now = this.deps.now ?? (() => new Date().toISOString())
    const parser = createOpenCodeEventParser(now())
    let seq = 1
    for await (const line of this.deps.sse()) {
      for (const body of parser.push(line)) {
        if (body.type === 'permission_request') {
          // The worktree is ours to state, not the engine session's claim.
          const corrected = {
            ...body,
            evidence: { ...body.evidence, worktree: launch.spec.brief.worktree },
          }
          yield {
            ...corrected,
            seq: seq++,
            at: now(),
            attempt_id: handle.attempt_id,
            generation: handle.generation,
          }
          const decision = await launch.spec.bridge.request(
            { attempt_id: handle.attempt_id, generation: handle.generation },
            corrected.operation,
            corrected.evidence,
            new Date(Date.parse(now()) + OPENCODE_PERMISSION_DEADLINE_MS).toISOString(),
          )
          // allow answers once (never `always`: each approval binds one operation, plan §13)
          const native = decision === 'allow' ? 'once' : 'reject'
          await this.post(`/api/session/${launch.sessionId}/permission/${body.request_id}/reply`, {
            decision: native,
          })
        } else {
          yield {
            ...body,
            seq: seq++,
            at: now(),
            attempt_id: handle.attempt_id,
            generation: handle.generation,
          }
        }
      }
    }
  }

  classify(error: unknown): ErrorClass {
    const value = error instanceof Error ? error.message : error
    return classifyOpencodeError(value)
  }

  mapReport(final: unknown): Report {
    const value = (final ?? {}) as Record<string, unknown>
    const text =
      typeof value.text === 'string' ? value.text : typeof value.result === 'string' ? value.result : ''
    const isError = value.error !== undefined
    return {
      kind: isError ? 'failed' : 'ready',
      summary: text.slice(0, 2000) || (isError ? 'engine reported an error result' : 'engine completed'),
    }
  }

  private requireLaunch(handle: AttemptHandle): Launch {
    const launch = this.launches.get(handle.attempt_id)
    if (!launch) throw new Error(`opencode adapter: unknown attempt ${handle.attempt_id}`)
    return launch
  }

  private post(path: string, body?: unknown): Promise<unknown> {
    if (!this.deps.post) {
      throw new Error('opencode adapter: deps.post is not wired to the serve process')
    }
    return this.deps.post(path, body)
  }
}
