import { isAbsolute, resolve } from 'node:path'
import type {
  AttemptHandle,
  AuthHealth,
  Capabilities,
  EngineAdapter,
  EngineEvent,
  EngineEventBody,
  ErrorClass,
  Input,
  LaunchModel,
  LaunchSpec,
  Report,
  SlotRef,
} from '@mec/contracts'
import { classifyOpencodeError, createOpenCodeEventParser, OPENCODE_ENGINE_VERSION } from './protocol'

/**
 * OpenCode V2 adapter (plan §9, reconciled to the real 2.2.5 server — R2.2).
 * One `opencode serve --hostname 127.0.0.1 --port 0 --stdio` process per attempt
 * (decision #31), MEC-generated `OPENCODE_PASSWORD`, HTTP Basic user `opencode`; the serve
 * process prints `{"url": "http://127.0.0.1:<port>"}` on stdout line 1 and the
 * runtime connects to that URL; one server session per attempt. The serve
 * process is supervised by the runtime (plan §8.1), so the adapter speaks only
 * the V2 server API: `POST /api/session {location, agent, model}` (response
 * enveloped as `{data: {id}}`), `POST …/prompt` (enqueues; always 200 —
 * failures arrive as `session.*.failed` events), `POST …/interrupt`, the
 * permission reply endpoint and the `GET /api/event` SSE stream. The location
 * directory must exist on disk or every request fails `LocationNotFoundError`.
 * Real agent ids on 2.2.5: `build` (default) and `plan` (read-only).
 * `deps.post` and `deps.sse` are injectable for tests; the runtime passes
 * `deps.connect`, which starts the attempt's serve process at launch and gives
 * the authenticated client, so the spawn sees the attempt's env.
 */

/** What a launch relies on, so what a probe says it still has. */
export const OPENCODE_FLAGS_VERIFIED: readonly string[] = ['--hostname', '--port', '--stdio']

/** How long the bridge may hold a `permission.asked` before the adapter denies it. */
export const OPENCODE_PERMISSION_DEADLINE_MS = 300_000

/** What a rejected ask tells the model. The rule that refused it is the bridge's to record. */
const REFUSED = 'MEC refused this. Carry on without it, and say so in your report.'

export type OpenCodePost = (path: string, body?: unknown) => Promise<unknown>
export type OpenCodeSse = () => AsyncIterable<string>
export type OpenCodeAuthList = () => Promise<{ code: number; stdout: string; stderr: string }>
export type OpenCodeSpawnFn = (
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => { pid: number | undefined; kill(signal?: string): void }

/** What the runtime's client gives the adapter once its process runs. */
export type OpenCodeConnection = {
  post: OpenCodePost
  sse: OpenCodeSse
  /** Resolves once the stream is open; `session.created` goes out only once. */
  ready: () => Promise<void>
}

export type OpenCodeAdapterDeps = {
  post?: OpenCodePost
  sse?: OpenCodeSse
  /** Starts the serve process for this launch. A launch through it also sends the brief. */
  connect?: (spec: LaunchSpec) => Promise<OpenCodeConnection>
  spawnFn?: OpenCodeSpawnFn
  authList?: OpenCodeAuthList
  /** `opencode --version` — the runtime injects the runner; the default reports the revision. */
  versionProbe?: () => Promise<string | undefined>
  /**
   * The slot's default model `{id, providerID}` (plan §5.7 — the provider profile
   * owns it; `session.create` without a model does NOT inherit the config-file
   * default, verified zero-token on 2.2.5). Sent on every fresh session create.
   */
  defaultModel?: { id: string; providerID: string }
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

/**
 * LaunchSpec.model.id arrives engine-facing — `provider/model`, optionally carrying
 * its effort as `provider/model#variant` — and the V2 session API wants
 * `{providerID, id, variant}` (review §4). An explicit `variant` field wins over a
 * hash suffix inside the id.
 */
function sessionModelOf(model: LaunchModel): { providerID: string; id: string; variant?: string } {
  const hashAt = model.id.indexOf('#')
  const withoutVariant = hashAt === -1 ? model.id : model.id.slice(0, hashAt)
  const hashVariant = hashAt === -1 ? undefined : model.id.slice(hashAt + 1)
  const slash = withoutVariant.indexOf('/')
  if (slash <= 0 || slash === withoutVariant.length - 1) {
    throw new Error(`opencode adapter: model id '${model.id}' is not provider/model`)
  }
  const variant = model.variant ?? hashVariant
  return {
    providerID: withoutVariant.slice(0, slash),
    id: withoutVariant.slice(slash + 1),
    ...(variant !== undefined && { variant }),
  }
}

type Launch = {
  handle: AttemptHandle
  spec: LaunchSpec
  sessionId: string
  /**
   * The SSE subscription started BEFORE the session was created (see launch);
   * undefined when deps.sse is not wired. The PUMP owns parsing AND the
   * permission round trip: 2.2.5 finding (verified live, reproducible) — a
   * permission reply POSTed from outside the SSE read loop (a reader.read()
   * pending in flight) leaves the turn stalled forever (204 lands, the pending
   * list clears, execution never resumes; a 3s in-loop delay still succeeds),
   * so the bridge call and the reply POST run between reads, inside the pump.
   * `events()` only drains the normalised bodies.
   */
  stream:
    | {
        bodies: EngineEventBody[]
        ended: boolean
        wake: (() => void)[]
      }
    | undefined
}

export class OpenCodeAdapter implements EngineAdapter {
  private readonly launches = new Map<string, Launch>()
  private connection: OpenCodeConnection | undefined

  constructor(private readonly deps: OpenCodeAdapterDeps = {}) {}

  async probe(_slot?: SlotRef): Promise<{ capabilities: Capabilities; auth: AuthHealth }> {
    const list = this.deps.authList ?? defaultAuthList
    const result = await list()
    const version = (await this.deps.versionProbe?.())?.trim()
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
        engine_version: version || OPENCODE_ENGINE_VERSION,
        flags_verified: [...OPENCODE_FLAGS_VERIFIED],
        structured_stream: true, // GET /api/event SSE
        questions: false, // denied by the attempt config: routing them to the user needs M2.2
        tool_approval: true, // permission.asked + reply endpoint
        interrupt: false, // a stop kills the group; POST /interrupt has not run through the runner
        resume: false, // a session id has not been resumed through the runner
        usage: true, // session.usage.updated
        rate_limit_events: false, // the quota fixture is synthetic: no real rejection was recorded
        sandbox: false, // no OS sandbox (plan §8.4); permissions ruleset instead
        restricted_mode: false, // the read-only `plan` agent has not run through the runner
        mcp_http: true, // mcp.servers remote entries
        usage_mode: 'cumulative',
      },
      auth:
        providers.length > 0
          ? { logged_in: true, method: providers[0], detail: providers.join(', ') }
          : {
              logged_in: false,
              // 2.2.5 finding: `auth list` shows only integration (OAuth) logins —
              // config-file API-key slots (the GLM/Gemini slot kinds, R2.2) show []
              // while working; their validity check is the slot-layer zero-token
              // provider probe (packages/slots probes / server validate route).
              detail:
                'no authenticated integrations (config-file API-key slots probe via the provider endpoint)',
            },
    }
  }

  async launch(spec: LaunchSpec): Promise<AttemptHandle> {
    // The V2 server emits `session.created` ON THE EVENT STREAM the moment the
    // session is POSTed — subscribing later (at events() time) misses it. The
    // SSE subscription therefore starts HERE and buffers into the launch;
    // events() drains the buffer (2.2.5 finding).
    if (this.deps.connect) this.connection = await this.deps.connect(spec)
    const sseFactory = this.connection?.sse ?? this.deps.sse
    const stream: Launch['stream'] =
      sseFactory === undefined ? undefined : { bodies: [], ended: false, wake: [] }
    let sessionId = spec.resume?.session_id
    const handle: AttemptHandle = {
      attempt_id: spec.brief.attempt_id,
      generation: spec.brief.generation,
      session_id: '',
    }
    if (sseFactory !== undefined && stream !== undefined) {
      const now = this.deps.now ?? (() => new Date().toISOString())
      const parser = createOpenCodeEventParser(now())
      void (async () => {
        try {
          for await (const line of sseFactory()) {
            for (const body of parser.push(line)) {
              stream.bodies.push(body)
              // The permission round trip runs INSIDE the read loop (see the
              // Launch type's 2.2.5 finding note): bridge → reply post →
              // synthesised permission_result (2.2.5 sends no echo event).
              if (body.type === 'permission_request') {
                // An edit's target may be relative: the decider judges the real path.
                const paths = body.operation.paths?.map((path) =>
                  isAbsolute(path) ? path : resolve(spec.brief.worktree, path),
                )
                const corrected = {
                  ...body,
                  operation: { ...body.operation, ...(paths !== undefined && { paths }) },
                  evidence: { ...body.evidence, worktree: spec.brief.worktree },
                }
                stream.bodies[stream.bodies.length - 1] = corrected
                const decision = await spec.bridge.request(
                  { attempt_id: spec.brief.attempt_id, generation: spec.brief.generation },
                  corrected.operation,
                  corrected.evidence,
                  new Date(Date.parse(now()) + OPENCODE_PERMISSION_DEADLINE_MS).toISOString(),
                )
                // allow answers once (never `always`: each approval binds one operation, plan §13)
                // A reject without a message ends the turn; with one, the model hears it and goes on.
                await this.post(`/api/session/${sessionId}/permission/${body.request_id}/reply`, {
                  decision: decision === 'allow' ? 'once' : 'reject',
                  ...(decision !== 'allow' && { message: REFUSED }),
                })
                stream.bodies.push({
                  type: 'permission_result',
                  request_id: body.request_id,
                  decision,
                })
              }
            }
          }
        } catch {
          // a dead stream ends the attempt; the runtime's crash rule applies
        } finally {
          for (const flush of parser.flush()) stream.bodies.push(flush)
          stream.ended = true
          for (const wake of stream.wake.splice(0)) wake()
        }
      })()
    }
    await this.connection?.ready()
    if (!sessionId) {
      // §8.4: bridge mode routes shell to `ask` so every command outside the
      // bootstrap/check profiles surfaces as a permission request; `none` keeps
      // the agent's own defaults (the `plan` agent is read-only anyway).
      const permissions =
        spec.brief.isolation.permission_mode === 'bridge'
          ? [{ action: 'bash', resource: '*', effect: 'ask' }]
          : undefined
      // LaunchSpec.model (additive v0.1) wins over deps.defaultModel: it is the
      // runtime's resolveModel output for THIS attempt — `{providerID, id, variant}`
      // per the V2 session API (review §4). `id` arrives engine-facing as
      // `provider/model` (+ optional `#variant`, carried as the variant field).
      const created = (await this.post('/api/session', {
        location: { directory: spec.cwd },
        // Real 2.2.5 agent ids: `plan` is the read-only agent; `build` the default.
        agent: spec.brief.isolation.read_only ? 'plan' : 'build',
        model: spec.model !== undefined ? sessionModelOf(spec.model) : this.deps.defaultModel,
        permissions,
      })) as { data?: { id?: string }; id?: string }
      sessionId = created.data?.id ?? created.id // the response is enveloped: {data: {id}}
    }
    if (!sessionId) throw new Error('opencode adapter: POST /api/session returned no session id')
    handle.session_id = sessionId
    this.launches.set(spec.brief.attempt_id, { handle, spec, sessionId, stream })
    // The brief is the first turn, as it is on Claude's argv: nobody else starts one.
    if (this.deps.connect) await this.post(`/api/session/${sessionId}/prompt`, { text: spec.brief.objective })
    return handle
  }

  async send(handle: AttemptHandle, input: Input): Promise<void> {
    // Delivery into a running attempt is 21's `deliver`, and nothing has proven it on this engine.
    if (this.deps.connect) throw new Error('opencode adapter: send is not proven; it stays unsupported')
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
    const stream = launch.stream
    if (stream === undefined) {
      throw new Error('opencode adapter: deps.sse is not wired to the serve process')
    }
    const now = this.deps.now ?? (() => new Date().toISOString())
    let seq = 1
    // The pump (launch) already parsed every line and ran the permission round
    // trip inside the read loop; this only wraps the buffered bodies.
    for (;;) {
      while (stream.bodies.length === 0 && !stream.ended) {
        await new Promise<void>((resolve) => stream.wake.push(resolve))
      }
      if (stream.bodies.length === 0) break // ended and drained
      const body = stream.bodies.shift() as EngineEventBody
      yield {
        ...body,
        seq: seq++,
        at: now(),
        attempt_id: handle.attempt_id,
        generation: handle.generation,
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
    const post = this.connection?.post ?? this.deps.post
    if (!post) {
      throw new Error('opencode adapter: deps.post is not wired to the serve process')
    }
    return post(path, body)
  }
}
