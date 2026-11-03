import type { EngineEventBody, ErrorClass, RateLimitStatus, TerminalReason, Window } from '@mec/contracts'

/**
 * Claude Code stream-json → normalised EngineEvent bodies (plan §9; CONTRACTS §1).
 *
 * Every rule below is proven by a real recording in packages/testkit/fixtures/claude/2.1.317:
 * - `system/init` → session_started (engine_version from `claude_code_version`)
 * - other `system/*` events (e.g. commands_changed) are not normalised
 * - a static `-p` prompt is NOT echoed; `user` events carry `tool_result` blocks and
 *   complete the pending `tool_call`
 * - a synthetic assistant message (`model: "<synthetic>"` or an `error` field) is an
 *   error, never a message — on auth failure `result.subtype` says `success` while
 *   `terminal_reason` says `api_error`; exit keys off `terminal_reason`
 * - one `rate_limit_event` fans out per `unifiedWindows` entry; `resetsAt` arrives in
 *   unix seconds; `allowed_warning` maps to `warning`
 * - with no `result` (a crash), the caller supplies the process exit code and the exit
 *   is synthesised as `crashed` (>= 128, i.e. 128+signal)
 */

type AnyRecord = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function isoFromUnixSeconds(seconds: unknown): string | undefined {
  const n = num(seconds)
  if (n === undefined) return undefined
  return new Date(n * 1000).toISOString()
}

const statusMap: Record<string, RateLimitStatus> = {
  allowed: 'allowed',
  allowed_warning: 'warning',
  warning: 'warning',
  rejected: 'rejected',
}

export type ParseOptions = {
  /** The real process exit code; used for the `exit` event. */
  exitCode?: number
}

export function parseClaudeStream(rawLines: readonly string[], opts: ParseOptions = {}): EngineEventBody[] {
  const events: EngineEventBody[] = []
  const pendingTools = new Map<string, { tool: string; input: unknown }>()
  let terminalReason: string | undefined

  for (const line of rawLines) {
    if (line.trim() === '') continue
    let parsed: AnyRecord
    try {
      parsed = JSON.parse(line) as AnyRecord
    } catch {
      continue // a torn line is skipped; the journal owns durability
    }
    const type = str(parsed.type)

    if (type === 'system') {
      if (str(parsed.subtype) === 'init') {
        events.push({
          type: 'session_started',
          session_id: str(parsed.session_id),
          engine: 'claude',
          engine_version: str(parsed.claude_code_version),
          model: str(parsed.model) || undefined,
        })
      }
      continue
    }

    if (type === 'assistant' || type === 'user') {
      const message = parsed.message as AnyRecord | undefined
      const content = (message?.content ?? parsed.content) as unknown
      const errorField = str(parsed.error) || str(message?.error)
      const synthetic = str(message?.model) === '<synthetic>' || errorField !== ''
      if (Array.isArray(content)) {
        for (const block of content as AnyRecord[]) {
          const blockType = str(block.type)
          if (blockType === 'text' && type === 'assistant' && !synthetic) {
            events.push({ type: 'message', role: 'assistant', text: str(block.text) })
          }
          if (blockType === 'tool_use' && type === 'assistant') {
            pendingTools.set(str(block.id), { tool: str(block.name), input: block.input })
          }
          if (blockType === 'tool_result' && type === 'user') {
            const pending = pendingTools.get(str(block.tool_use_id))
            if (pending) {
              pendingTools.delete(str(block.tool_use_id))
              events.push({
                type: 'tool_call',
                tool: pending.tool,
                input: (pending.input ?? {}) as AnyRecord,
                output: (block.content ?? null) as unknown,
                ok: block.is_error === true ? false : true,
              })
            }
          }
        }
      }
      if (type === 'assistant' && synthetic) {
        const text = extractSyntheticText(content)
        events.push({
          type: 'error',
          class: classifyClaudeError(errorField || text),
          detail: text || errorField,
          raw: { error: errorField || null, is_api_error_message: parsed.is_api_error_message === true },
        })
      }
      continue
    }

    if (type === 'rate_limit_event') {
      const info = (parsed.rate_limit_info ?? {}) as AnyRecord
      const windows = (info.unifiedWindows ?? {}) as Record<string, AnyRecord>
      for (const [window, raw] of Object.entries(windows)) {
        const status = statusMap[str(raw.status)] ?? 'allowed'
        events.push({
          type: 'rate_limit',
          window: window as Window,
          status,
          utilization: num(raw.utilization),
          resets_at: isoFromUnixSeconds(raw.resetsAt ?? info.resetsAt) ?? 'unknown',
          raw: {
            rateLimitType: str(info.rateLimitType),
            overageStatus: str(info.overageStatus) || undefined,
            isUsingOverage: info.isUsingOverage === true,
          },
        })
      }
      continue
    }

    if (type === 'result') {
      terminalReason = str(parsed.terminal_reason)
      const usage = (parsed.usage ?? {}) as AnyRecord
      events.push({
        type: 'usage',
        input_tokens: num(usage.input_tokens) ?? 0,
        output_tokens: num(usage.output_tokens) ?? 0,
        cache_read: num(usage.cache_read_input_tokens),
        cache_write: num(usage.cache_creation_input_tokens),
        cost_usd: num(parsed.total_cost_usd),
      })
    }
  }

  const code = opts.exitCode ?? 0
  const reason = terminalReason ?? (code >= 128 ? 'crashed' : 'completed')
  events.push({ type: 'exit', code, terminal_reason: reason as TerminalReason })
  return events
}

function extractSyntheticText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  for (const block of content as AnyRecord[]) {
    if (str(block.type) === 'text') return str(block.text)
  }
  return ''
}

/** Error text → ErrorClass, from the real failure shapes recorded in the fixtures. */
export function classifyClaudeError(value: string): ErrorClass {
  const v = value.toLowerCase()
  if (v.includes('authentication') || v.includes('not logged in') || v.includes('login')) return 'auth'
  if (v.includes('rate') || v.includes('quota') || v.includes('usage limit')) return 'quota'
  if (v.includes('overloaded') || v.includes('5') || v.includes('unavailable') || v.includes('down')) {
    return 'provider_down'
  }
  return 'unknown'
}
