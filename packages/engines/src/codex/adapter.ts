import type {
  AttemptHandle,
  AuthHealth,
  Capabilities,
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
 * One `codex app-server` process per slot speaking JSON-RPC over stdio; one thread per
 * attempt; one turn at a time. The app-server process is supervised by the runtime
 * (plan §8.1), so the adapter only speaks the documented methods: `initialize` + the
 * `initialized` notification, `thread/start` (or `thread/resume`), `turn/start`,
 * `turn/steer`, `turn/interrupt`, and answers the server→client approval REQUESTS
 * (`item/commandExecution/requestApproval` and friends, answered as JSON-RPC responses
 * with the same id) and `item/tool/requestUserInput` (answered `{answers: {}}`).
 * `deps.post` and `deps.notifications` are injectable — tests inject fakes, the runtime
 * injects the client for its spawned app-server process; nothing here ever runs the
 * `codex` binary itself (the probe's defaults defer to injected runners).
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

export type CodexAdapterDeps = {
  post?: CodexPost
  notifications?: CodexNotifications
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

  constructor(private readonly deps: CodexAdapterDeps = {}) {}

  async probe(_slot: SlotRef): Promise<{ capabilities: Capabilities; auth: AuthHealth }> {
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
        flags_verified: [
          'initialize',
          'thread/start',
          'thread/resume',
          'turn/start',
          'turn/steer',
          'turn/interrupt',
          'account/rateLimits/read',
          'item/commandExecution/requestApproval',
          'login status',
        ],
        structured_stream: true, // JSON-RPC notifications over stdio
        questions: true, // item/tool/requestUserInput routed to the bridge
        tool_approval: true, // item/*/requestApproval answered accept/decline
        interrupt: true, // turn/interrupt (needs the active turn id)
        resume: true, // thread/resume in the same CODEX_HOME
        usage: true, // thread/tokenUsage/updated (cumulative totals; no cost on ChatGPT plans)
        rate_limit_events: true, // account/rateLimits/updated, primary + secondary windows
        sandbox: true, // sandbox read-only / workspace-write (Seatbelt/landlock)
        restricted_mode: true, // read-only sandbox + approvalPolicy never
        mcp_http: true, // [mcp_servers.mec] url + bearer_token_env_var (plan §7)
        usage_mode: 'cumulative',
      },
      auth,
    }
  }

  async launch(spec: LaunchSpec): Promise<AttemptHandle> {
    await this.request('initialize', {
      clientInfo: { name: 'mec', title: 'Mubit Engineering Control', version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    })
    await this.post({ jsonrpc: '2.0', method: 'initialized' }) // notification: no id
    const sandbox = spec.brief.isolation.read_only ? 'read-only' : 'workspace-write'
    const approvalPolicy = spec.brief.isolation.permission_mode === 'bridge' ? 'on-request' : 'never'
    const started = spec.resume?.session_id
      ? ((await this.request('thread/resume', { threadId: spec.resume.session_id })) as {
          thread?: { id?: string }
        })
      : ((await this.request('thread/start', {
          cwd: spec.cwd,
          sandbox,
          approvalPolicy,
        })) as { thread?: { id?: string } })
    const threadId = started?.thread?.id || spec.resume?.session_id
    if (!threadId) throw new Error('codex adapter: thread/start returned no thread id')
    const handle: AttemptHandle = {
      attempt_id: spec.brief.attempt_id,
      generation: spec.brief.generation,
      session_id: threadId,
    }
    this.launches.set(spec.brief.attempt_id, { handle, spec, threadId, turnOpen: false })
    return handle
  }

  async send(handle: AttemptHandle, input: Input): Promise<void> {
    const launch = this.requireLaunch(handle)
    const inputParam = [{ type: 'text', text: input.text, text_elements: [] }]
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
    if (!this.deps.notifications) {
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
    for await (const line of this.deps.notifications()) {
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
          const answer =
            native?.method === 'item/tool/requestUserInput'
              ? { answers: {} }
              : { decision: decision === 'allow' ? 'accept' : 'decline' }
          await this.post({ jsonrpc: '2.0', id: native?.id ?? body.request_id, result: answer })
          yield envelope({
            type: 'permission_result',
            request_id: body.request_id,
            decision: decision === 'allow' ? 'allow' : 'deny',
          })
        } else {
          yield envelope(body)
          if (body.type === 'exit') launch.turnOpen = false
        }
      }
      const turnId = parser.activeTurnId()
      if (turnId) {
        launch.turnId = turnId
        launch.turnOpen = true
      }
    }
    // The stream ended. If the turn never completed (a killed or endlessly-retrying
    // server), the exit is synthesised here from the process exit code (CONTRACTS §1).
    for (const body of parser.finish(this.deps.processExitCode?.())) {
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
    if (!this.deps.post) {
      throw new Error('codex adapter: deps.post is not wired to the app-server')
    }
    return this.deps.post(payload)
  }
}
