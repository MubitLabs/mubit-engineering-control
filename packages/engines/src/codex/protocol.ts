import type { EngineEventBody, ErrorClass, OperationKind, TerminalReason, Window } from '@mec/contracts'

/**
 * Codex app-server JSON-RPC notifications → normalised EngineEvent bodies (plan §9; CONTRACTS §1).
 *
 * One `codex app-server` process per slot speaks JSON-RPC over stdio; every notification is one
 * line `{"method": "...", "params": {...}}`. Every rule below is proven by the synthetic fixtures
 * in packages/testkit/fixtures/codex/0.148.0 (CONTRACTS §9, recorded_by: 'fake') — synthesised
 * from the documented app-server protocol, never from a real `codex` binary:
 * - `thread/started` (or the first notification carrying `params.threadId`) → session_started
 *   (`session_id` is the threadId `thread/resume` needs)
 * - `item/commandExecution|fileChange|permissions/requestApproval` → permission_request; the
 *   method picks the operation kind (command→shell, file change→edit, anything else→other)
 * - `item/tool/requestUserInput` → permission_request kind 'other' (a question, not an operation)
 * - the approval answer the adapter sent — a line `{"result": {"id": ..., "decision": ...}}` —
 *   → permission_result (accept/acceptForSession→allow, decline/cancel→deny)
 * - `account/rateLimits/updated` and `/read` → rate_limit; `windowDurationMins` names the window
 *   (~300→five_hour, ~10080→seven_day), `resetsAt` arrives in unix seconds, and `usedPercent`
 *   picks the status (>=100 rejected, >=80 warning, else allowed)
 * - `thread/tokenUsage/updated` → usage with the cumulative tokens/cost the params carry; an
 *   event with no reading is skipped — missing stays unknown, not 0
 * - `turn/completed` is the turn end → exit: status `completed`→{0, completed},
 *   `interrupted`→aborted, anything else→{1, api_error}; an error seen earlier in the turn makes
 *   the exit `{code: 1, terminal_reason: 'api_error'}` whatever the status says. A stream that
 *   ends without `turn/completed` is a dead server: the runtime emits exit itself (CONTRACTS §1
 *   crash rule).
 * - a notification with method `error` (or `params.error`) → error via `classifyCodexError`.
 */

/** The app-server protocol revision the adapter and its fixtures were written against. */
export const CODEX_ENGINE_VERSION = '0.148.0'

type AnyRecord = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Error text → ErrorClass, from the documented failure shapes of the app-server and its API. */
export function classifyCodexError(text: string): ErrorClass {
  const v = text.toLowerCase()
  if (v.includes('usage limit') || v.includes('rate')) return 'quota'
  if (v.includes('login') || v.includes('auth')) return 'auth'
  if (v.includes('overloaded') || v.includes('5xx') || v.includes('stream error') || v.includes('timeout')) {
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

/** The documented approval methods → operation shape (plan §9 permission-bridge column). */
function permissionRequestOf(method: string, params: AnyRecord): EngineEventBody | undefined {
  const requestId = str(params.id)
  if (!requestId) return undefined
  let kind: OperationKind
  let summary: string
  let command: string[] | undefined
  let paths: string[] | undefined
  if (method === 'item/commandExecution/requestApproval') {
    kind = 'shell'
    command = Array.isArray(params.command) ? params.command.map(String) : undefined
    summary = command ? command.join(' ') : 'command approval request'
  } else if (method === 'item/fileChange/requestApproval') {
    kind = 'edit'
    paths = Array.isArray(params.paths) ? params.paths.map(String) : undefined
    summary = paths && paths.length > 0 ? `edit ${paths.join(' ')}` : 'file change approval request'
  } else if (method === 'item/permissions/requestApproval') {
    kind = 'other'
    summary = str(params.summary) || str(params.reason) || 'permission approval request'
  } else if (method === 'item/tool/requestUserInput') {
    kind = 'other' // a question for the user, not an operation on the worktree
    summary = str(params.summary) || str(params.question) || 'user input request'
  } else {
    return undefined
  }
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
      raw: JSON.parse(JSON.stringify(params)) as never,
      worktree: '/unknown', // notifications carry no cwd; the adapter states the worktree it owns
    },
  }
}

function mapCodexNotification(
  method: string,
  params: AnyRecord,
  state: { started: boolean; sawError: boolean },
): EngineEventBody[] {
  const events: EngineEventBody[] = []

  if (!state.started && (method === 'thread/started' || str(params.threadId) !== '')) {
    const threadId = str(params.threadId) || str(params.id)
    if (threadId) {
      events.push({
        type: 'session_started',
        session_id: threadId,
        engine: 'codex',
        engine_version: str(params.version) || CODEX_ENGINE_VERSION,
        model: str(params.model) || undefined,
      })
      state.started = true
    }
  }

  const approval = permissionRequestOf(method, params)
  if (approval) {
    events.push(approval)
    return events
  }

  if (method === 'account/rateLimits/updated' || method === 'account/rateLimits/read') {
    const primary = ((params.primary ?? {}) as AnyRecord) ?? {}
    const usedPercent = num(primary.usedPercent)
    events.push({
      type: 'rate_limit',
      window: windowFromDurationMins(num(primary.windowDurationMins)),
      status:
        usedPercent === undefined
          ? 'allowed'
          : usedPercent >= 100
            ? 'rejected'
            : usedPercent >= 80
              ? 'warning'
              : 'allowed',
      utilization: usedPercent === undefined ? undefined : Math.min(usedPercent / 100, 1),
      resets_at: isoFromUnixSeconds(primary.resetsAt) ?? 'unknown',
      raw: JSON.parse(JSON.stringify(params)) as never,
    })
    return events
  }

  if (method === 'thread/tokenUsage/updated') {
    const input = num(params.inputTokens)
    const output = num(params.outputTokens)
    const cached = num(params.cachedTokens)
    const cost = num(params.costUSD)
    if (input === undefined && output === undefined && cached === undefined && cost === undefined) {
      return events // no reading yet: unknown stays unknown, never 0 (CONTRACTS §0)
    }
    events.push({
      type: 'usage',
      input_tokens: input ?? 0,
      output_tokens: output ?? 0,
      cache_read: cached,
      cost_usd: cost,
    })
    return events
  }

  if (method === 'error' || params.error !== undefined) {
    const err = (params.error ?? params) as AnyRecord
    const message = str(err.message)
    state.sawError = true
    events.push({
      type: 'error',
      class: classifyCodexError(message),
      detail: message || 'codex reported an error',
      raw: JSON.parse(JSON.stringify(err)) as never,
    })
    return events
  }

  if (method === 'turn/completed') {
    const status = str(params.status)
    let code: number
    let reason: TerminalReason
    if (state.sawError) {
      code = 1
      reason = 'api_error' // the turn completed only nominally; the error owns the outcome
    } else if (status === 'completed') {
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
    return events
  }

  return events // turn/started, item/* progress and friends stay in the raw stream and the journal
}

/** Incremental form the adapter uses: push raw stdio lines, get completed bodies back. */
export type CodexEventParser = { push(line: string): EngineEventBody[] }

export function createCodexEventParser(): CodexEventParser {
  const state = { started: false, sawError: false }
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

      // The approval answer the adapter sent: {"result": {"id": ..., "decision": "accept"|"…"}}.
      const result = record.result
      if (result !== null && typeof result === 'object') {
        const id = str((result as AnyRecord).id)
        const decision = str((result as AnyRecord).decision)
        if (!id || !decision) return [] // a response to thread/start and friends: nothing to normalise
        return [
          {
            type: 'permission_result',
            request_id: id,
            decision: decision.startsWith('accept') ? 'allow' : 'deny', // accept, acceptForSession → allow
          },
        ]
      }

      const method = str(record.method)
      if (method === '') return []
      return mapCodexNotification(method, (record.params ?? {}) as AnyRecord, state)
    },
  }
}

/** Batch form the conformance suite uses: raw notification lines in, normalised bodies out. */
export function parseCodexEvents(rawLines: readonly string[]): EngineEventBody[] {
  const parser = createCodexEventParser()
  const events: EngineEventBody[] = []
  for (const line of rawLines) events.push(...parser.push(line))
  return events
}
