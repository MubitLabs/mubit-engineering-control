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
import { CODEX_ENGINE_VERSION, classifyCodexError, createCodexEventParser } from './protocol'

/**
 * Codex adapter (plan §9). One `codex app-server` process per slot speaking JSON-RPC over
 * stdio; one thread per attempt. The app-server process is supervised by the runtime
 * (plan §8.1), so the adapter only speaks the documented methods: `initialize`,
 * `thread/start` (or `thread/resume`), `turn/start`, `turn/steer`, `turn/interrupt`, and
 * answers the server-to-client approval requests (`item/commandExecution/requestApproval`
 * and friends) and `item/tool/requestUserInput`. `deps.post` and `deps.notifications` are
 * injectable — tests inject fakes, the runtime injects the client for its spawned
 * app-server process; nothing here ever runs the `codex` binary itself (the probe's
 * defaults defer to injected runners).
 */

/** How long the bridge may hold a requestApproval before the adapter declines it. */
export const CODEX_PERMISSION_DEADLINE_MS = 300_000

/** Sends one JSON-RPC message (request or response) over the app-server's stdio. */
export type CodexPost = (payload: unknown) => Promise<unknown>
/** The app-server's notification lines, one JSON-RPC notification per line. */
export type CodexNotifications = () => AsyncIterable<string>
/** `codex login status` (text on stderr; exit 0/1; plan §5) — injectable, never defaulted to a run here. */
export type CodexLoginStatus = () => Promise<{ code: number; stdout: string; stderr: string }>
/** `codex --version` — the runtime injects the runner; the default reports "unprobed". */
export type CodexVersionProbe = () => Promise<string | undefined>

export type CodexAdapterDeps = {
  post?: CodexPost
  notifications?: CodexNotifications
  loginStatus?: CodexLoginStatus
  versionProbe?: CodexVersionProbe
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

type Launch = { handle: AttemptHandle; spec: LaunchSpec; threadId: string; turnOpen: boolean }

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
          'login status',
        ],
        structured_stream: true, // JSON-RPC notifications over stdio
        questions: true, // item/tool/requestUserInput routed to the bridge
        tool_approval: true, // item/*/requestApproval answered accept/decline
        interrupt: true, // turn/interrupt
        resume: true, // thread/resume in the same CODEX_HOME
        usage: true, // thread/tokenUsage/updated
        rate_limit_events: true, // account/rateLimits/* mapping (protocol.ts)
        sandbox: true, // sandbox read-only / workspace-write (Seatbelt/landlock)
        restricted_mode: true, // read-only + approvalPolicy never
        mcp_http: true, // [mcp_servers.mec] url + bearer_token_env_var (plan §7)
        usage_mode: 'cumulative',
      },
      auth,
    }
  }

  async launch(spec: LaunchSpec): Promise<AttemptHandle> {
    await this.request('initialize', {
      clientInfo: { name: 'mec', title: 'Mubit Engineering Control', version: '0.1.0' },
    })
    const readOnly = spec.brief.isolation.read_only
    const started = spec.resume?.session_id
      ? ((await this.request('thread/resume', { threadId: spec.resume.session_id })) as {
          threadId?: string
        })
      : ((await this.request('thread/start', {
          cwd: spec.cwd,
          sandbox: readOnly ? 'read-only' : 'workspace-write',
          approvalPolicy: readOnly ? 'never' : 'on-request',
        })) as { threadId?: string })
    const threadId = started?.threadId || spec.resume?.session_id
    if (!threadId) throw new Error('codex adapter: thread/start returned no threadId')
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
    const method = launch.turnOpen ? 'turn/steer' : 'turn/start'
    launch.turnOpen = true
    await this.request(method, { prompt: input.text })
  }

  async interrupt(handle: AttemptHandle): Promise<void> {
    this.requireLaunch(handle)
    await this.request('turn/interrupt', {})
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
    for await (const line of this.deps.notifications()) {
      for (const body of parser.push(line)) {
        if (body.type === 'permission_request') {
          // The worktree is ours to state, not the engine thread's claim.
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
            new Date(Date.parse(now()) + CODEX_PERMISSION_DEADLINE_MS).toISOString(),
          )
          // allow answers once (`accept`, never `acceptForSession`: each approval binds one
          // operation, plan §13); deny and the deadline-expired deny both answer 'decline'.
          // The native 'cancel' is reserved for a user-aborted turn and never sent here.
          const native = decision === 'allow' ? 'accept' : 'decline'
          await this.post({ result: { id: body.request_id, decision: native } })
          yield {
            type: 'permission_result',
            request_id: body.request_id,
            decision: decision === 'allow' ? 'allow' : 'deny',
            seq: seq++,
            at: now(),
            attempt_id: handle.attempt_id,
            generation: handle.generation,
          }
        } else {
          yield {
            ...body,
            seq: seq++,
            at: now(),
            attempt_id: handle.attempt_id,
            generation: handle.generation,
          }
          if (body.type === 'exit') launch.turnOpen = false
        }
      }
    }
  }

  classify(error: unknown): ErrorClass {
    return classifyCodexError(error instanceof Error ? error.message : String(error))
  }

  mapReport(final: unknown): Report {
    const value = (final ?? {}) as Record<string, unknown>
    const text =
      typeof value.reason === 'string' ? value.reason : typeof value.result === 'string' ? value.result : ''
    const failed = value.status !== 'completed' // turn/completed status (failed, interrupted, …)
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
