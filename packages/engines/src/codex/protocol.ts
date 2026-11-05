import type { EngineEventBody, ErrorClass, OperationKind, TerminalReason, Window } from '@mec/contracts'

/**
 * Codex app-server JSON-RPC → normalised EngineEvent bodies (plan §9; CONTRACTS §1).
 *
 * One `codex app-server` process per slot speaks JSON-RPC over stdio; every message is one
 * line. Three line kinds flow from the server: responses (`{id, result|error}`, no `method`),
 * notifications (`{method, params}`, no `id`) and server→client REQUESTS
 * (`{method, id, params}` — the approval asks), which the client answers with a response
 * carrying the SAME id. Every rule below is proven by the recordings in
 * packages/testkit/fixtures/codex/0.148.0 — `smoke`, `permission_request` and `auth_expired`
 * are real (recorded against the logged-in slot and an empty CODEX_HOME, 3 Nov 2026);
 * `rate_limit_rejected` stays a corrected synthesis (real rejection needs window exhaustion).
 * Shapes verified against `codex app-server generate-ts` for 0.148.0 and the live stream:
 * - `thread/started` carries the whole thread object: `params.thread.id` is the session id
 *   (`thread/resume` needs it) and `params.thread.cliVersion` is the engine version.
 * - `item/completed` with `params.item.type === 'agentMessage'` → assistant `message`
 *   (deltas `item/agentMessage/delta` stay raw-only); `commandExecution` items → `tool_call`
 *   with the item's `exitCode`/`aggregatedOutput`/`durationMs`; `userMessage` echoes are skipped.
 * - approvals arrive as REQUESTS, not notifications: `item/commandExecution|fileChange|
 *   permissions/requestApproval` with the request id at the TOP level (`params.id` does not
 *   exist). `command` is a single shell line string, not argv; `fileChange` params carry no
 *   paths, only `reason` and an optional `grantRoot`.
 * - the client's recorded answer line `{"jsonrpc":"2.0","id":…,"result":{"decision":…}}` →
 *   permission_result (accept, acceptForSession → allow; decline, cancel → deny).
 * - `item/tool/requestUserInput` (a question, `questions[].question`) → permission_request
 *   kind 'other'; its answer is `{answers: {}}`, NOT a decision.
 * - `account/rateLimits/updated` carries `params.rateLimits` with `primary` AND `secondary`
 *   windows; one `rate_limit` event is emitted per window (`windowDurationMins` ~300 →
 *   five_hour, ~10080 → seven_day; `resetsAt` in unix seconds; `usedPercent` picks the status).
 * - `thread/tokenUsage/updated` carries cumulative tokens under `params.tokenUsage.total`
 *   (`inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`); ChatGPT
 *   subscriptions report no cost, so `cost_usd` stays undefined.
 * - `error` notifications carry `params.error` = `{message, codexErrorInfo, additionalDetails}`;
 *   an expired login surfaces as `message: "Reconnecting… N/5"` with
 *   `codexErrorInfo.responseStreamDisconnected.httpStatusCode === 401` — classification reads
 *   all three fields, the message alone says nothing about auth.
 * - `turn/completed` carries the whole turn: `params.turn.status` ∈ completed | interrupted |
 *   failed | inProgress (plus `turn.error` when failed) → exit completed→{0, completed},
 *   interrupted→{0, aborted}, anything else→{1, api_error}. An error notification does NOT
 *   override a later completed turn (reconnects recover).
 * - a stream that ENDS without `turn/completed` never exits on its own (an auth-expired
 *   server retries 401s forever): `finish(exitCode?)` synthesises the exit itself —
 *   ≥128 (a signal) → `crashed`, otherwise `{1, api_error}` (CONTRACTS §1 crash rule).
 */

/** The app-server protocol revision the adapter and its fixtures were written against. */
export const CODEX_ENGINE_VERSION = '0.148.0'

type AnyRecord = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const clone = (v: unknown) => JSON.parse(JSON.stringify(v)) as never

/** Error text → ErrorClass, from the real failure shapes recorded in the fixtures. */
export function classifyCodexError(text: string): ErrorClass {
  const v = text.toLowerCase()
  if (v.includes('401') || v.includes('unauthorized') || v.includes('login') || v.includes('auth')) {
    return 'auth'
  }
  if (v.includes('usage limit') || v.includes('rate limit') || v.includes('429')) return 'quota'
  if (
    v.includes('overloaded') ||
    v.includes('5xx') ||
    v.includes('stream error') ||
    v.includes('stream disconnected') ||
    v.includes('timeout') ||
    v.includes('unavailable')
  ) {
    return 'provider_down'
  }
  return 'unknown'
}

/** `windowDurationMins` names the ChatGPT window it reports (~5h vs ~7d); anything else is unknown. */
function windowFromDurationMins(mins: number | undefined): Window {
  if (mins === undefined) return 'unknown'
  if (Math.abs(mins - 300) <= 75) return 'five_hour'
  if (Math.abs(mins - 10080) <= 2520) return 'seven_day'
  return 'unknown'
}

function isoFromUnixSeconds(seconds: unknown): string | undefined {
  const n = num(seconds)
  if (n === undefined) return undefined
  return new Date(n * 1000).toISOString()
}

/**
 * The documented approval REQUESTS → operation shape (plan §9 permission-bridge column).
 * The request id sits at the top level of the JSON-RPC request line, not inside params.
 */
function permissionRequestOf(
  method: string,
  id: unknown,
  params: AnyRecord,
): { body: EngineEventBody; requestId: string } | undefined {
  const requestId = id === undefined ? '' : String(id)
  if (!requestId) return undefined
  let kind: OperationKind
  let summary: string
  let command: string[] | undefined
  let paths: string[] | undefined
  if (method === 'item/commandExecution/requestApproval') {
    kind = 'shell'
    const line = str(params.command)
    command = line ? [line] : undefined // a single shell line, not parsed argv
    summary = line || str(params.reason) || 'command approval request'
  } else if (method === 'item/fileChange/requestApproval') {
    kind = 'edit'
    const root = str(params.grantRoot)
    paths = root ? [root] : undefined
    summary = str(params.reason) || (root ? `edit under ${root}` : 'file change approval request')
  } else if (method === 'item/permissions/requestApproval') {
    kind = 'other'
    summary = str(params.reason) || 'permission approval request'
  } else if (method === 'mcpServer/elicitation/request') {
    kind = 'other' // an MCP server asking through the engine: no worker tool of ours does
    summary = str(params.message) || `elicitation from ${str(params.serverName) || 'an MCP server'}`
  } else if (method === 'item/tool/requestUserInput') {
    kind = 'other' // a question for the user, not an operation on the worktree
    const questions = Array.isArray(params.questions) ? (params.questions as AnyRecord[]) : []
    summary = str(questions[0]?.question) || str(questions[0]?.header) || 'user input request'
    return { body: permissionBody(requestId, kind, summary, undefined, undefined, params), requestId }
  } else {
    return undefined
  }
  return { body: permissionBody(requestId, kind, summary, command, paths, params), requestId }
}

function permissionBody(
  requestId: string,
  kind: OperationKind,
  summary: string,
  command: string[] | undefined,
  paths: string[] | undefined,
  params: AnyRecord,
): EngineEventBody {
  return {
    type: 'permission_request',
    request_id: requestId,
    operation: {
      kind,
      summary,
      command,
      paths,
    },
    evidence: {
      raw: clone(params),
      worktree: '/unknown', // notifications carry no cwd; the adapter states the worktree it owns
    },
  }
}

/** A turn item that did not run: the bridge declined it, or it failed before it started. */
const refused = (item: AnyRecord): boolean => ['declined', 'failed'].includes(str(item.status))

function mapCodexNotification(
  method: string,
  params: AnyRecord,
  state: { started: boolean; exited: boolean },
): EngineEventBody[] {
  const events: EngineEventBody[] = []

  if (!state.started && method === 'thread/started') {
    const thread = (params.thread ?? {}) as AnyRecord
    const threadId = str(thread.id)
    if (threadId) {
      events.push({
        type: 'session_started',
        session_id: threadId,
        engine: 'codex',
        engine_version: str(thread.cliVersion) || CODEX_ENGINE_VERSION,
      })
      state.started = true
    }
  }

  if (method === 'item/completed') {
    const item = (params.item ?? {}) as AnyRecord
    const itemType = str(item.type)
    if (itemType === 'agentMessage') {
      events.push({ type: 'message', role: 'assistant', text: str(item.text) })
    } else if (itemType === 'commandExecution') {
      const exitCode = num(item.exitCode)
      events.push({
        type: 'tool_call',
        tool: 'commandExecution',
        input: clone({ command: item.command, cwd: item.cwd }) as never,
        output: item.aggregatedOutput === null ? undefined : clone(item.aggregatedOutput),
        ok: exitCode === undefined ? (refused(item) ? false : undefined) : exitCode === 0,
        duration_ms: num(item.durationMs),
      })
    } else if (itemType === 'fileChange' && refused(item)) {
      // An applied change shows in the head; one that was refused shows nowhere else.
      events.push({ type: 'tool_call', tool: 'fileChange', input: null, ok: false })
    } else if (itemType === 'mcpToolCall') {
      events.push({
        type: 'tool_call',
        tool: `mcp__${str(item.server)}__${str(item.tool)}`,
        input: clone(item.arguments ?? null) as never,
        ok: str(item.status) === 'completed',
        duration_ms: num(item.durationMs),
      })
    }
    return events
  }

  if (method === 'account/rateLimits/updated' || method === 'account/rateLimits/read') {
    const snapshot = (params.rateLimits ?? params) as AnyRecord // read responses unwrap one level
    for (const slot of ['primary', 'secondary'] as const) {
      const window = (snapshot[slot] ?? null) as AnyRecord | null
      if (window === null) continue
      const usedPercent = num(window.usedPercent)
      events.push({
        type: 'rate_limit',
        window: windowFromDurationMins(num(window.windowDurationMins)),
        status:
          usedPercent === undefined
            ? 'allowed'
            : usedPercent >= 100
              ? 'rejected'
              : usedPercent >= 80
                ? 'warning'
                : 'allowed',
        utilization: usedPercent === undefined ? undefined : Math.min(usedPercent / 100, 1),
        resets_at: isoFromUnixSeconds(window.resetsAt) ?? 'unknown',
        raw: clone({ slot, usedPercent, windowDurationMins: window.windowDurationMins }),
      })
    }
    return events
  }

  if (method === 'thread/tokenUsage/updated') {
    const usage = ((params.tokenUsage ?? {}) as AnyRecord).total as AnyRecord | undefined
    if (usage === undefined) return events
    events.push({
      type: 'usage',
      input_tokens: num(usage.inputTokens) ?? 0,
      output_tokens: num(usage.outputTokens) ?? 0,
      cache_read: num(usage.cachedInputTokens),
      cache_write: num(usage.cacheWriteInputTokens),
      // ChatGPT subscriptions report tokens only; cost stays unknown, never 0 (CONTRACTS §0)
    })
    return events
  }

  // NB: `mcpServer/startupStatus/updated` carries `error: null` in flight — only a
  // truthy params.error (or the `error` method itself) is an error.
  if (method === 'error' || (params.error !== null && params.error !== undefined)) {
    const err = (params.error ?? params) as AnyRecord
    const message = str(err.message)
    const details = str(err.additionalDetails)
    const info = err.codexErrorInfo === undefined ? '' : JSON.stringify(err.codexErrorInfo)
    events.push({
      type: 'error',
      class: classifyCodexError(`${message} ${details} ${info}`),
      detail: message || details || 'codex reported an error',
      raw: clone(err),
    })
    return events
  }

  if (method === 'turn/completed') {
    const turn = (params.turn ?? {}) as AnyRecord
    const status = str(turn.status)
    if (turn.error !== null && turn.error !== undefined) {
      const err = turn.error as AnyRecord
      const message = str(err.message)
      events.push({
        type: 'error',
        class: classifyCodexError(`${message} ${str(err.additionalDetails)}`),
        detail: message || 'turn failed',
        raw: clone(err),
      })
    }
    let code: number
    let reason: TerminalReason
    if (status === 'completed') {
      code = 0
      reason = 'completed'
    } else if (status === 'interrupted') {
      code = 0
      reason = 'aborted'
    } else {
      code = 1
      reason = 'api_error'
    }
    events.push({ type: 'exit', code, terminal_reason: reason })
    state.exited = true
    return events
  }

  return events // turn/started, deltas, item/started and friends stay in the raw stream and the journal
}

/** Incremental form the adapter uses: push raw stdio lines, get completed bodies back. */
export type CodexEventParser = {
  push(line: string): EngineEventBody[]
  /**
   * End of stream. A turn that never saw `turn/completed` (a killed or endlessly-retrying
   * server) gets its exit synthesised here: ≥128 is a signal → `crashed`, else `api_error`.
   */
  finish(exitCode?: number): EngineEventBody[]
  /** The id of the currently active turn, from `turn/started` (turn/steer and turn/interrupt need it). */
  activeTurnId(): string | undefined
  /** The native JSON-RPC request behind a permission_request id (id type + method), for answering. */
  nativeRequest(requestId: string): { id: string | number; method: string } | undefined
  /** Server requests with no bridge mapping, since the last call. Unanswered, they hang the turn. */
  takeUnhandled(): { id: string | number; method: string }[]
}

export function createCodexEventParser(): CodexEventParser {
  const state = { started: false, exited: false }
  const nativeRequests = new Map<string, { id: string | number; method: string }>()
  const unhandled: { id: string | number; method: string }[] = []
  let turnId: string | undefined
  return {
    push(line: string): EngineEventBody[] {
      const trimmed = line.trim()
      if (trimmed === '') return []
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return [] // a torn line is skipped; the journal owns durability
      }
      if (parsed === null || typeof parsed !== 'object') return []
      const record = parsed as AnyRecord

      const method = str(record.method)

      // The client's recorded answer to an approval request:
      // {"jsonrpc":"2.0","id":…,"result":{"decision":"accept"|…}} — server responses to
      // client requests never carry result.decision, so the two cannot collide.
      if (method === '' && record.result !== null && typeof record.result === 'object') {
        const decision = str((record.result as AnyRecord).decision)
        if (decision !== '') {
          const requestId = record.id === undefined ? '' : String(record.id)
          if (!requestId) return []
          return [
            {
              type: 'permission_result',
              request_id: requestId,
              decision: decision.startsWith('accept') ? 'allow' : 'deny',
            },
          ]
        }
        return [] // a response to initialize/thread/start and friends: nothing to normalise
      }
      if (method === '') return []

      // A server→client REQUEST (approval asks): the id rides at the top level.
      if (record.id !== undefined) {
        const approval = permissionRequestOf(method, record.id, (record.params ?? {}) as AnyRecord)
        if (approval) {
          nativeRequests.set(approval.requestId, { id: record.id as string | number, method })
          return [approval.body]
        }
        unhandled.push({ id: record.id as string | number, method })
        return []
      }

      if (method === 'turn/started') {
        const turn = (((record.params ?? {}) as AnyRecord).turn ?? {}) as AnyRecord
        turnId = str(turn.id) || turnId
      }
      return mapCodexNotification(method, (record.params ?? {}) as AnyRecord, state)
    },
    finish(exitCode?: number): EngineEventBody[] {
      if (state.exited) return []
      const code = exitCode ?? 1
      return [
        {
          type: 'exit',
          code,
          terminal_reason: code >= 128 ? 'crashed' : 'api_error',
        },
      ]
    },
    activeTurnId(): string | undefined {
      return turnId
    },
    nativeRequest(requestId: string): { id: string | number; method: string } | undefined {
      return nativeRequests.get(requestId)
    },
    takeUnhandled(): { id: string | number; method: string }[] {
      return unhandled.splice(0)
    },
  }
}

/** Batch form the conformance suite uses: raw stream lines in, normalised bodies out. */
export function parseCodexEvents(
  rawLines: readonly string[],
  opts: { exitCode?: number } = {},
): EngineEventBody[] {
  const parser = createCodexEventParser()
  const events: EngineEventBody[] = []
  for (const line of rawLines) events.push(...parser.push(line))
  events.push(...parser.finish(opts.exitCode))
  return events
}
