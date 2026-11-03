import type { EngineEventBody, ErrorClass, Json, OperationKind, TerminalReason, Window } from '@mec/contracts'

/**
 * OpenCode V2 SSE → normalised EngineEvent bodies (plan §9; CONTRACTS §1).
 *
 * One `opencode serve --stdio` process per slot streams `GET /api/event` as SSE: an
 * `event: <name>` line followed by one `data: {json}` line (a bare `data: {"type": …}`
 * line without the `event:` prefix is accepted too — the V2 server sends both forms).
 * Every rule below is proven by the synthetic fixtures in
 * packages/testkit/fixtures/opencode/2.2.5 (CONTRACTS §9, recorded_by: 'fake'):
 * - `session.created` → session_started (`session_id` is the server session id resume needs)
 * - `permission.asked` → permission_request; the permission's shape picks the operation
 *   kind (command→shell, file edit→edit, webfetch→network, anything else→other)
 * - the reply echo (`permission.updated`) → permission_result (once/always→allow, reject→deny)
 * - `session.step.*` and `session.usage.updated` → usage with the cumulative tokens/cost
 *   the data carries; an event with no reading is skipped — missing stays unknown, not 0
 * - `session.idle` is the turn end → exit; an error seen earlier in the turn makes it
 *   `{code: 1, terminal_reason: 'api_error'}`, otherwise `{code: 0, terminal_reason: 'completed'}`.
 *   A stream that ends without `session.idle` is a dead server: the runtime emits exit itself
 *   (CONTRACTS §1 crash rule).
 * - an event carrying `data.error` → error via `classifyOpencodeError`; a quota error
 *   (429 RESOURCE_EXHAUSTED) also emits `rate_limit` rejected first, with `resets_at` from
 *   `RetryInfo.retryDelay` seconds added to `now` and the window from the QuotaFailure
 *   `quotaId` (per-minute vs per-day, plan §5.9); no RetryInfo → resets_at 'unknown'.
 */

/** The V2 protocol revision the adapter and its fixtures were written against. */
export const OPENCODE_ENGINE_VERSION = '2.2.5'

type AnyRecord = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Error payload (`{code, status, message}`) or text → ErrorClass, from the documented provider error shapes. */
export function classifyOpencodeError(error: unknown): ErrorClass {
  const record = (error ?? {}) as AnyRecord
  const code = num(record.code)
  const text =
    `${str(record.status)} ${str(record.message)} ${typeof error === 'string' ? error : ''}`.toLowerCase()
  if (code === 429 || text.includes('resource_exhausted') || text.includes('quota')) return 'quota'
  if (code === 401 || code === 403 || text.includes('unauthor') || text.includes('auth')) return 'auth'
  if (code !== undefined && code >= 500) return 'provider_down'
  if (text.includes('unavailable') || text.includes('overloaded') || text.includes('internal')) {
    return 'provider_down'
  }
  return 'unknown'
}

/** The documented permission shapes → OperationKind. */
function operationKindOf(permission: AnyRecord): OperationKind {
  const type = str(permission.type).toLowerCase()
  if (type === 'command' || type === 'bash' || type === 'shell') return 'shell'
  if (type === 'edit' || type === 'file_edit') return 'edit'
  if (type === 'webfetch' || type === 'websearch') return 'network'
  return 'other'
}

/** Google-style `details[]` → the RetryInfo delay and the QuotaFailure quotaId, when the provider sent them. */
function retryFacts(err: AnyRecord): { retryDelay: string | undefined; quotaId: string | undefined } {
  let retryDelay: string | undefined
  let quotaId: string | undefined
  const details = Array.isArray(err.details) ? err.details : []
  for (const entry of details) {
    if (entry === null || typeof entry !== 'object') continue
    const detail = entry as AnyRecord
    const type = str(detail['@type'])
    if (type.endsWith('RetryInfo')) retryDelay = retryDelay ?? (str(detail.retryDelay) || undefined)
    if (type.endsWith('QuotaFailure')) {
      const violations = Array.isArray(detail.violations) ? detail.violations : []
      const first = violations[0]
      if (first !== null && typeof first === 'object') {
        quotaId = quotaId ?? (str((first as AnyRecord).quotaId) || undefined)
      }
    }
  }
  return { retryDelay: retryDelay ?? (str(err.retryDelay) || undefined), quotaId }
}

/** `'12s'` (Google `RetryInfo.retryDelay` format) → seconds. */
function parseDelaySeconds(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^([\d.]+)s$/.exec(value.trim())
  const seconds = match?.[1] === undefined ? Number.NaN : Number.parseFloat(match[1])
  return Number.isFinite(seconds) ? seconds : undefined
}

/** `quotaId` names the window it exhausted (per-minute vs per-day, plan §5.9). */
function windowFromQuotaId(quotaId: string | undefined): Window {
  const id = (quotaId ?? '').toLowerCase()
  if (id.includes('perminute')) return 'per_minute'
  if (id.includes('perday')) return 'per_day'
  return 'unknown'
}

function mapOpenCodeEvent(name: string, data: AnyRecord, now: string): EngineEventBody[] {
  const events: EngineEventBody[] = []

  if (name === 'session.created') {
    const sessionId = str(data.sessionID) || str(data.session_id) || str(data.id)
    if (sessionId) {
      events.push({
        type: 'session_started',
        session_id: sessionId,
        engine: 'opencode',
        engine_version: str(data.version) || 'unknown',
        model: str(data.model) || undefined,
      })
    }
    return events
  }

  if (name === 'permission.asked') {
    const requestId = str(data.requestID) || str(data.request_id)
    if (!requestId) return events
    const permission = (data.permission ?? {}) as AnyRecord
    const command = Array.isArray(permission.command) ? permission.command.map(String) : undefined
    events.push({
      type: 'permission_request',
      request_id: requestId,
      operation: {
        kind: operationKindOf(permission),
        summary:
          str(permission.summary) ||
          (command ? command.join(' ') : '') ||
          `${str(permission.type) || 'permission'} request`,
        command,
        paths: Array.isArray(permission.paths) ? permission.paths.map(String) : undefined,
        hosts: Array.isArray(permission.hosts) ? permission.hosts.map(String) : undefined,
        tool: str(permission.tool) || undefined,
      },
      evidence: {
        raw: data as Json,
        worktree: str(data.directory) || '/unknown',
      },
    })
    return events
  }

  if (name === 'permission.updated') {
    const requestId = str(data.requestID) || str(data.request_id)
    const native = str(data.decision) || str(data.status)
    if (!requestId || !native) return events
    events.push({
      type: 'permission_result',
      request_id: requestId,
      decision: native === 'reject' ? 'deny' : 'allow', // once/always → allow; echo of the reply we sent
    })
    return events
  }

  if (name.startsWith('session.step.') || name === 'session.usage.updated') {
    const usage = (data.usage ?? {}) as AnyRecord
    const tokens = (data.tokens ?? usage) as AnyRecord
    const input = num(tokens.input) ?? num(tokens.input_tokens)
    const output = num(tokens.output) ?? num(tokens.output_tokens)
    const cacheRead = num(tokens.cache_read) ?? num(tokens.cache_read_input_tokens)
    const cacheWrite = num(tokens.cache_write) ?? num(tokens.cache_creation_input_tokens)
    const cost = num(data.cost) ?? num(usage.cost)
    if (
      input === undefined &&
      output === undefined &&
      cacheRead === undefined &&
      cacheWrite === undefined &&
      cost === undefined
    ) {
      return events // no reading yet: unknown stays unknown, never 0 (CONTRACTS §0)
    }
    events.push({
      type: 'usage',
      input_tokens: input ?? 0,
      output_tokens: output ?? 0,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      cost_usd: cost,
    })
    return events
  }

  if (name === 'error' || data.error !== undefined) {
    const err = (data.error ?? data) as AnyRecord
    const klass = classifyOpencodeError(err)
    if (klass === 'quota') {
      const { retryDelay, quotaId } = retryFacts(err)
      const delaySeconds = parseDelaySeconds(retryDelay)
      events.push({
        type: 'rate_limit',
        window: windowFromQuotaId(quotaId),
        status: 'rejected',
        resets_at:
          delaySeconds === undefined
            ? 'unknown'
            : new Date(Date.parse(now) + delaySeconds * 1000).toISOString(),
        raw: {
          code: num(err.code) ?? null,
          status: str(err.status) || null,
          quotaId: quotaId ?? null,
          retryDelay: retryDelay ?? null,
        },
      })
    }
    events.push({
      type: 'error',
      class: klass,
      detail: str(err.message) || str(err.status) || 'opencode reported an error',
      raw: err as Json,
    })
    return events
  }

  return events // session.updated and friends stay in the raw stream and the journal
}

/** Incremental form the adapter uses: push raw SSE lines, get completed bodies back. */
export type OpenCodeEventParser = { push(line: string): EngineEventBody[] }

export function createOpenCodeEventParser(now: string = new Date().toISOString()): OpenCodeEventParser {
  let pendingName: string | undefined
  let sawError = false
  return {
    push(line: string): EngineEventBody[] {
      const trimmed = line.trim()
      if (trimmed === '') return []
      if (trimmed.startsWith('event:')) {
        pendingName = trimmed.slice('event:'.length).trim()
        return []
      }
      if (!trimmed.startsWith('data:')) return []
      let data: AnyRecord
      try {
        data = JSON.parse(trimmed.slice('data:'.length).trim()) as AnyRecord
      } catch {
        return [] // a torn line is skipped; the journal owns durability
      }
      const name = pendingName ?? str(data.type)
      pendingName = undefined
      if (!name) return []
      const bodies = mapOpenCodeEvent(name, data, now)
      if (bodies.some((body) => body.type === 'error')) sawError = true
      if (name === 'session.idle') {
        bodies.push({
          type: 'exit',
          code: sawError ? 1 : 0,
          terminal_reason: (sawError ? 'api_error' : 'completed') as TerminalReason,
        })
      }
      return bodies
    },
  }
}

/** Batch form the conformance suite uses: raw SSE lines in, normalised bodies out. */
export function parseOpenCodeEvents(
  rawLines: readonly string[],
  now: string = new Date().toISOString(),
): EngineEventBody[] {
  const parser = createOpenCodeEventParser(now)
  const events: EngineEventBody[] = []
  for (const line of rawLines) events.push(...parser.push(line))
  return events
}
