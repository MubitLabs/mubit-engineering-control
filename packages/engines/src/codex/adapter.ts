import type {
  AttemptHandle,
  AuthHealth,
  Capabilities,
  Decision,
  EngineAdapter,
  EngineEvent,
  EngineEventBody,
  ErrorClass,
  Input,
  LaunchSpec,
  Report,
  SlotRef,
} from '@mec/contracts'
import { CODEX_ENGINE_VERSION, classifyCodexError, createCodexEventParser } from './protocol'

/**
 * Codex adapter (plan §9), verified against the real 0.148.0 app-server (docs/engines.md).
 * One `codex app-server` process per attempt (decision #31) speaking JSON-RPC over stdio;
 * one thread and one turn at a time. The app-server process is supervised by the runtime
 * (plan §8.1), so the adapter only speaks the documented methods: `initialize` + the
 * `initialized` notification, `thread/start` (or `thread/resume`), `turn/start`,
 * `turn/steer`, `turn/interrupt`, and answers the server→client approval REQUESTS
 * (`item/commandExecution/requestApproval` and friends, answered as JSON-RPC responses
 * with the same id) and `item/tool/requestUserInput` (answered `{answers: {}}`).
 * `deps.post` and `deps.notifications` are injectable for tests; the runtime passes
 * `deps.connect`, which starts the attempt's app-server at launch and gives both, so the
 * spawn sees the attempt's env. Nothing here ever runs the `codex` binary itself (the
 * probe's defaults defer to injected runners).
 *
 * Real 0.148.0 facts the code leans on: `turn/start` takes
 * `{threadId, input: [{type:'text', text, text_elements: []}]}` — not `{prompt}`; the turn
 * id arrives only via the `turn/started` notification, and `turn/steer`/`turn/interrupt`
 * need it (`expectedTurnId` / `turnId`), so a steer or interrupt before events have been
 * drained is refused with a clear error instead of a malformed request.
 */

/** How long the bridge may hold a requestApproval before the adapter declines it. */
export const CODEX_PERMISSION_DEADLINE_MS = 300_000

/** Sends one JSON-RPC message (request, response or notification) over the app-server's stdio. */
export type CodexPost = (payload: unknown) => Promise<unknown>
/** The app-server's stdout lines, one JSON-RPC message per line. */
export type CodexNotifications = () => AsyncIterable<string>
/** `codex login status` (text on stderr; exit 0/1; plan §5) — injectable, never defaulted to a run here. */
export type CodexLoginStatus = () => Promise<{ code: number; stdout: string; stderr: string }>
/** `codex --version` — the runtime injects the runner; the default reports "unprobed". */
export type CodexVersionProbe = () => Promise<string | undefined>
/** The spawned app-server's process exit code, once its stdout has closed; feeds the crash-rule exit. */
export type CodexProcessExitCode = () => number | undefined

/** What the runtime's client gives the adapter once its process runs. */
export type CodexConnection = {
  post: CodexPost
  notifications: CodexNotifications
  processExitCode: CodexProcessExitCode
}

export type CodexAdapterDeps = {
  post?: CodexPost
  notifications?: CodexNotifications
  /** Starts the app-server for this launch. A launch through it also starts the turn. */
  connect?: (spec: LaunchSpec) => Promise<CodexConnection>
  /**
   * The permissions profile the app-server was started with. `sandbox` then stays out of
   * `thread/start`, which would drop the profile, and a thread without it refuses the launch.
   */
  profile?: string
  loginStatus?: CodexLoginStatus
  versionProbe?: CodexVersionProbe
  processExitCode?: CodexProcessExitCode
  /** Clock for event timestamps and bridge deadlines; injectable for deterministic tests. */
  now?: () => string
}

const defaultLoginStatus: CodexLoginStatus = async () => {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    // The slot layer owns CODEX_HOME; until it lands, the ambient env is used.
    execFile('codex', ['login', 'status'], (error, stdout, stderr) => {
      resolve({
        code: error ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

const defaultVersionProbe: CodexVersionProbe = async () => undefined // unprobed → the revision constant

/** What a launch relies on, so what a probe says it still has. */
export const CODEX_FLAGS_VERIFIED: readonly string[] = [
  'initialize',
  'thread/start',
  'turn/start',
  'account/rateLimits/read',
  'item/commandExecution/requestApproval',
  'login status',
]

/** The approval answer each native request understands; `decision` here is the bridge's. */
function answerOf(method: string | undefined, decision: Decision): unknown {
  const allow = decision === 'allow'
  switch (method) {
    case 'item/tool/requestUserInput':
      return { answers: {} }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' } // grants nothing, whatever was asked
    case 'mcpServer/elicitation/request':
      return { action: allow ? 'accept' : 'decline', content: null, _meta: null }
    default:
      return { decision: allow ? 'accept' : 'decline' }
  }
}

type Launch = {
  handle: AttemptHandle
  spec: LaunchSpec
  threadId: string
  /** The active turn id, learned from the `turn/started` notification; steer/interrupt need it. */
  turnId?: string
  turnOpen: boolean
}

export class CodexAdapter implements EngineAdapter {
  private readonly launches = new Map<string, Launch>()
  private nextRequestId = 0
  private connection: CodexConnection | undefined
  private initialized = false

  constructor(private readonly deps: CodexAdapterDeps = {}) {}

  async probe(_slot?: SlotRef): Promise<{ capabilities: Capabilities; auth: AuthHealth }> {
    const status = await (this.deps.loginStatus ?? defaultLoginStatus)()
    const line = (status.stderr || status.stdout).trim()
    const text = line.toLowerCase()
    let auth: AuthHealth
    if (text.includes('not logged in')) {
      auth = { logged_in: false, detail: line || 'Not logged in' }
    } else if (text.includes('logged in')) {
      // The status line names the mode (plan §5: "the mode its status line names").
      const method = text.includes('api key') ? 'api_key' : text.includes('chatgpt') ? 'chatgpt' : undefined
      auth = method ? { logged_in: true, method, detail: line } : { logged_in: true, detail: line }
    } else {
      auth = { logged_in: false, detail: line || 'codex login status returned no status' }
    }
    const version = (await (this.deps.versionProbe ?? defaultVersionProbe)())?.trim()
    return {
      capabilities: {
        engine_version: version || CODEX_ENGINE_VERSION,
        flags_verified: [...CODEX_FLAGS_VERIFIED],
        structured_stream: true, // JSON-RPC notifications over stdio
        questions: false, // answered empty: routing them to the user needs M2.2
        tool_approval: true, // item/*/requestApproval answered accept/decline
        interrupt: false, // a stop kills the group; turn/interrupt has not run through the runner
        resume: false, // thread/resume has not run through the runner
        usage: true, // thread/tokenUsage/updated (cumulative totals; no cost on ChatGPT plans)
        rate_limit_events: true, // account/rateLimits/updated, primary + secondary windows
        sandbox: true, // a permissions profile on Seatbelt: see codex-client.ts
        restricted_mode: false, // the read-only role has not run through the runner
        mcp_http: true, // mcp_servers.mec url + bearer_token_env_var (plan §7)
        usage_mode: 'cumulative',
      },
      auth,
    }
  }

  async launch(spec: LaunchSpec): Promise<AttemptHandle> {
    if (this.deps.connect) this.connection = await this.deps.connect(spec)
    // One process takes one handshake: a second `initialize` is refused.
    if (!this.initialized) {
      await this.request('initialize', {
        clientInfo: { name: 'mec', title: 'Mubit Engineering Control', version: '0.1.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      })
      await this.post({ jsonrpc: '2.0', method: 'initialized' }) // notification: no id
      this.initialized = true
    }
    const sandbox = spec.brief.isolation.read_only ? 'read-only' : 'workspace-write'
    const approvalPolicy = spec.brief.isolation.permission_mode === 'bridge' ? 'on-request' : 'never'
    // LaunchSpec.model (additive v0.1): the documented app-server model selection —
    // `model` in thread/start (review §4; the CLI's `-m`/`-c` forms belong to the
    // runtime's argv_additions, not this process).
    const started = spec.resume?.session_id
      ? ((await this.request('thread/resume', { threadId: spec.resume.session_id })) as {
          thread?: { id?: string }
        })
      : ((await this.request('thread/start', {
          cwd: spec.cwd,
          ...(this.deps.profile === undefined && { sandbox }),
          approvalPolicy,
          ...(spec.model?.id !== undefined && { model: spec.model.id }),
        })) as { thread?: { id?: string } })
    const threadId = started?.thread?.id || spec.resume?.session_id
    if (!threadId) throw new Error('codex adapter: thread/start returned no thread id')
    const active = (started as { activePermissionProfile?: { id?: string } | null })?.activePermissionProfile
    if (this.deps.profile !== undefined && active?.id !== this.deps.profile) {
      throw new Error(`codex adapter: the '${this.deps.profile}' sandbox profile is not active`)
    }
    const handle: AttemptHandle = {
      attempt_id: spec.brief.attempt_id,
      generation: spec.brief.generation,
      session_id: threadId,
    }
    this.launches.set(spec.brief.attempt_id, { handle, spec, threadId, turnOpen: false })
    // The brief is the first turn, as it is on Claude's argv: nobody else starts one.
    if (this.deps.connect) await this.startTurn(handle, spec.brief.objective)
    return handle
  }

  async send(handle: AttemptHandle, input: Input): Promise<void> {
    // Delivery into a running attempt is 21's `deliver`, and nothing has proven it on this engine.
    if (this.deps.connect) throw new Error('codex adapter: send is not proven; it stays unsupported')
    await this.startTurn(handle, input.text)
  }

  private async startTurn(handle: AttemptHandle, text: string): Promise<void> {
    const launch = this.requireLaunch(handle)
    const inputParam = [{ type: 'text', text, text_elements: [] }]
    if (!launch.turnOpen) {
      launch.turnOpen = true
      await this.request('turn/start', { threadId: launch.threadId, input: inputParam })
      return
    }
    // turn/steer needs the active turn id, which only the turn/started notification carries.
    if (!launch.turnId) {
      throw new Error('codex adapter: turn/steer needs the active turn id; drain events until turn/started')
    }
    await this.request('turn/steer', {
      threadId: launch.threadId,
      input: inputParam,
      expectedTurnId: launch.turnId,
    })
  }

  async interrupt(handle: AttemptHandle): Promise<void> {
    const launch = this.requireLaunch(handle)
    if (!launch.turnOpen) return // no active turn: nothing to interrupt
    if (!launch.turnId) {
      throw new Error(
        'codex adapter: turn/interrupt needs the active turn id; drain events until turn/started',
      )
    }
    await this.request('turn/interrupt', { threadId: launch.threadId, turnId: launch.turnId })
  }

  /** Graceful stop for one attempt is the same interrupt; the app-server process belongs to the slot. */
  async stop(handle: AttemptHandle): Promise<void> {
    await this.interrupt(handle)
  }

  async *events(handle: AttemptHandle): AsyncIterable<EngineEvent> {
    const launch = this.requireLaunch(handle)
    const notifications = this.connection?.notifications ?? this.deps.notifications
    if (!notifications) {
      throw new Error('codex adapter: deps.notifications is not wired to the app-server')
    }
    const now = this.deps.now ?? (() => new Date().toISOString())
    const parser = createCodexEventParser()
    let seq = 1
    const envelope = (body: EngineEventBody): EngineEvent => ({
      ...body,
      seq: seq++,
      at: now(),
      attempt_id: handle.attempt_id,
      generation: handle.generation,
    })
    for await (const line of notifications()) {
      for (const body of parser.push(line)) {
        if (body.type === 'permission_request') {
          // The worktree is ours to state, not the engine thread's claim.
          const corrected = {
            ...body,
            evidence: { ...body.evidence, worktree: launch.spec.brief.worktree },
          }
          yield envelope(corrected)
          const decision = await launch.spec.bridge.request(
            { attempt_id: handle.attempt_id, generation: handle.generation },
            corrected.operation,
            corrected.evidence,
            new Date(Date.parse(now()) + CODEX_PERMISSION_DEADLINE_MS).toISOString(),
          )
          // allow answers once (`accept`, never `acceptForSession`: each approval binds one
          // operation, plan §13); deny and the deadline-expired deny both answer 'decline'.
          // The native 'cancel' is reserved for a user-aborted turn and never sent here.
          // A user-input QUESTION has no decision vocabulary: it is answered `{answers: {}}`.
          const native = parser.nativeRequest(body.request_id)
          await this.post({
            jsonrpc: '2.0',
            id: native?.id ?? body.request_id,
            result: answerOf(native?.method, decision),
          })
          yield envelope({
            type: 'permission_result',
            request_id: body.request_id,
            decision: decision === 'allow' ? 'allow' : 'deny',
          })
        } else {
          yield envelope(body)
          if (body.type === 'exit') {
            launch.turnOpen = false
            // The app-server never exits on its own; the turn's end is the end of this stream.
            if (this.deps.connect) return
          }
        }
      }
      for (const { id, method } of parser.takeUnhandled()) {
        await this.post({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `${method} is not supported` },
        })
      }
      const turnId = parser.activeTurnId()
      if (turnId) {
        launch.turnId = turnId
        launch.turnOpen = true
      }
    }
    // The stream ended. If the turn never completed (a killed or endlessly-retrying
    // server), the exit is synthesised here from the process exit code (CONTRACTS §1).
    const exitCode = this.connection?.processExitCode ?? this.deps.processExitCode
    for (const body of parser.finish(exitCode?.())) {
      yield envelope(body)
      if (body.type === 'exit') launch.turnOpen = false
    }
  }

  classify(error: unknown): ErrorClass {
    return classifyCodexError(error instanceof Error ? error.message : String(error))
  }

  mapReport(final: unknown): Report {
    const value = (final ?? {}) as Record<string, unknown>
    const turn = (value.turn ?? value) as Record<string, unknown>
    const text =
      typeof turn.reason === 'string'
        ? turn.reason
        : typeof value.reason === 'string'
          ? value.reason
          : typeof value.result === 'string'
            ? value.result
            : ''
    const failed = turn.status !== undefined ? turn.status !== 'completed' : value.status !== 'completed'
    return {
      kind: failed ? 'failed' : 'ready',
      summary: text.slice(0, 2000) || (failed ? 'engine reported an error result' : 'engine completed'),
    }
  }

  private requireLaunch(handle: AttemptHandle): Launch {
    const launch = this.launches.get(handle.attempt_id)
    if (!launch) throw new Error(`codex adapter: unknown attempt ${handle.attempt_id}`)
    return launch
  }

  private request(method: string, params: unknown): Promise<unknown> {
    this.nextRequestId += 1
    return this.post({ jsonrpc: '2.0', id: this.nextRequestId, method, params })
  }

  private post(payload: unknown): Promise<unknown> {
    const post = this.connection?.post ?? this.deps.post
    if (!post) {
      throw new Error('codex adapter: deps.post is not wired to the app-server')
    }
    return post(payload)
  }
}
