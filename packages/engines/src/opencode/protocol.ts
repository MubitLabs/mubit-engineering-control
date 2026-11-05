import type { EngineEventBody, ErrorClass, Json, OperationKind, TerminalReason, Window } from '@mec/contracts'

/**
 * OpenCode V2 SSE → normalised EngineEvent bodies (plan §9; CONTRACTS §1).
 *
 * Reconciled against a real `opencode serve --stdio` 2.2.5 on 3 Nov 2026 (R2.2,
 * slot glm-2 on the z.ai Coding Plan and slot gem-1 on a Gemini key); the
 * recordings live in packages/testkit/fixtures/opencode/2.2.5 (CONTRACTS §9).
 * One serve process per slot streams `GET /api/event` as SSE. Every event is a
 * single `data:` line whose JSON is `{id, created, type, location, data}` — the
 * event NAME is the top-level `type`, the PAYLOAD is nested under `data`. The
 * server also emits `: heartbeat` comment lines (skipped), prefixes the stream
 * with `server.connected`, and does NOT send `event:` name lines (an `event:`
 * line is still accepted if a future version starts sending one).
 *
 * Turn lifecycle (real shapes, replacing the plan's §9 guesses):
 * - `session.created` → session_started (`data.sessionID` is the server session
 *   id resume needs; `data.model` is `{id, providerID}`)
 * - `session.text.ended` → message (assistant) — `data.text` is the full part
 * - `session.step.ended` → usage with the step's tokens/cost; the shape is
 *   `data.tokens = {input, output, reasoning, cache: {read, write}}` (NOT flat
 *   cache_read/cache_write) and `data.cost` — the GLM Coding Plan reports cost 0
 *   (subscription-style), Gemini reports real USD
 * - `session.usage.updated` → usage, same token shape, cumulative; it fires more
 *   than once per turn (after each step and once at the end)
 * - `session.execution.succeeded` is the turn end → exit completed. There is NO
 *   `session.idle` on 2.2.5. `session.execution.failed` → error (from
 *   `data.error`) then exit `{code: 1, api_error}`; `session.step.failed` carries
 *   the same error one event earlier. A stream that ends without an execution
 *   verdict is a dead server: the runtime emits exit itself (CONTRACTS §1 crash
 *   rule).
 * - an error payload `{type: 'provider.auth', status, message, response: {body}}`
 *   (dot-namespaced `provider.*` types; the provider's own JSON rides inside
 *   `response.body` as a STRING) → error via `classifyOpencodeError`; a quota
 *   error also emits `rate_limit` rejected first, with `resets_at` from a Google
 *   `RetryInfo.retryDelay` inside `response.body` added to `now` and the window
 *   from the `QuotaFailure` `quotaId` (per-minute vs per-day, plan §5.9); no
 *   RetryInfo → resets_at 'unknown'.
 * - `server.*`, `project/provider/model/agent/…​.updated`, `session.inbox.*`,
 *   `session.reasoning.*`, `session.renamed` and friends stay in the raw stream
 *   and the journal.
 */

/** The V2 protocol revision the adapter and its fixtures were written against. */
export const OPENCODE_ENGINE_VERSION = '2.2.5'

type AnyRecord = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Parses `response.body` JSON when the error carries the provider's raw body. */
function responseBody(error: AnyRecord): AnyRecord | undefined {
  const response = (error.response ?? {}) as AnyRecord
  if (typeof response.body !== 'string' || response.body === '') return undefined
  try {
    const parsed: unknown = JSON.parse(response.body)
    return typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : undefined
  } catch {
    return undefined
  }
}

/**
 * Error payload → ErrorClass, from the real 2.2.5 shapes: `{type:
 * 'provider.auth'|'provider.rateLimit'|…, status, message, response: {body}}`
 * where `response.body` stringifies the provider's own error JSON (z.ai
 * `{"error":{"code":"1000","message":"身份验证失败。"}}`, Google
 * `RESOURCE_EXHAUSTED` with `details[]`). Status/text heuristics stay as the
 * fallback for shapes the recordings have not shown yet.
 */
export function classifyOpencodeError(error: unknown): ErrorClass {
  const record = (error ?? {}) as AnyRecord
  const code = num(record.status) ?? num(record.code)
  const type = str(record.type).toLowerCase()
  const body = responseBody(record) ?? {}
  const bodyError = (body.error ?? {}) as AnyRecord
  const text =
    `${str(record.status)} ${str(record.message)} ${str(bodyError.status)} ${str(bodyError.message)} ${
      typeof error === 'string' ? error : ''
    }`.toLowerCase()
  const bodyCode = num(bodyError.code)
  if (
    type.includes('auth') ||
    text.includes('unauthor') ||
    text.includes('invalid api key') ||
    text.includes('身份验证失败') ||
    code === 401 ||
    code === 403 ||
    bodyCode === 401
  ) {
    return 'auth'
  }
  if (
    code === 429 ||
    bodyCode === 429 ||
    type.includes('rate') ||
    type.includes('quota') ||
    type.includes('exhaust') ||
    text.includes('resource_exhausted') ||
    text.includes('quota')
  ) {
    return 'quota'
  }
  if (code !== undefined && code >= 500) return 'provider_down'
  if (text.includes('unavailable') || text.includes('overloaded') || text.includes('internal')) {
    return 'provider_down'
  }
  return 'unknown'
}

/**
 * The permission's real shape (`Permission.Request`: `{id, sessionID, action,
 * resources[], source: {type:'tool', id}, …}`) → OperationKind. `action` is the
 * rule verb (`bash`, `edit`, `read`, `webfetch`…); `source.id` names the TOOL
 * that asked ('bash', 'edit', 'webfetch'). Both signals map, action first —
 * the tool id disambiguates action vocabularies the recordings have not shown.
 */
function operationKindOf(request: AnyRecord): OperationKind {
  const action = str(request.action).toLowerCase()
  if (action === 'bash' || action === 'shell' || action === 'command' || action === 'exec') return 'shell'
  if (action === 'edit' || action === 'write' || action === 'file_edit') return 'edit'
  if (action === 'webfetch' || action === 'websearch' || action === 'fetch') return 'network'
  const source = (request.source ?? {}) as AnyRecord
  const tool = str(source.id).toLowerCase()
  if (tool === 'bash' || tool === 'shell') return 'shell'
  if (tool === 'edit' || tool === 'write') return 'edit'
  if (tool === 'webfetch' || tool === 'websearch' || tool === 'fetch') return 'network'
  return 'other'
}

/** Google-style `details[]` (inside the stringified `response.body`, under `error.details`) → RetryInfo delay and QuotaFailure quotaId. */
function retryFacts(err: AnyRecord): { retryDelay: string | undefined; quotaId: string | undefined } {
  let retryDelay: string | undefined
  let quotaId: string | undefined
  const body = responseBody(err)
  // Google nests everything under `error`; flat payloads stay supported.
  const nested = (body?.error ?? {}) as AnyRecord
  const source =
    typeof nested.details === 'object' && nested.details !== null
      ? { ...(body as AnyRecord), ...(nested as AnyRecord) }
      : ((body ?? err) as AnyRecord)
  const details = Array.isArray(source.details) ? source.details : []
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
  return { retryDelay: retryDelay ?? (str(source.retryDelay) || undefined), quotaId }
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

/**
 * The real 2.2.5 usage tokens `{input, output, reasoning, cache: {read, write}}`
 * → the contracts' usage body. Missing readings stay undefined (unknown, never
 * 0 — CONTRACTS §0); a `tokens` object with no reading at all yields no event.
 */
function usageBodiesOf(payload: AnyRecord): EngineEventBody[] {
  const tokens = (payload.tokens ?? {}) as AnyRecord
  const cache = (tokens.cache ?? {}) as AnyRecord
  const input = num(tokens.input)
  const output = num(tokens.output)
  const cacheRead = num(cache.read)
  const cacheWrite = num(cache.write)
  const cost = num(payload.cost)
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    cost === undefined
  ) {
    return [] // no reading yet: unknown stays unknown, never 0 (CONTRACTS §0)
  }
  return [
    {
      type: 'usage',
      input_tokens: input ?? 0,
      output_tokens: output ?? 0,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      cost_usd: cost,
    },
  ]
}

/** `provider.auth`-style errors → rate_limit (when quota) + error bodies. */
function errorBodiesOf(err: AnyRecord, now: string): EngineEventBody[] {
  const events: EngineEventBody[] = []
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
        type: str(err.type) || null,
        status: num(err.status) ?? null,
        quotaId: quotaId ?? null,
        retryDelay: retryDelay ?? null,
      },
    })
  }
  events.push({
    type: 'error',
    class: klass,
    detail: str(err.message) || str(err.type) || 'opencode reported an error',
    raw: err as Json,
  })
  return events
}

function mapOpenCodeEvent(
  name: string,
  data: AnyRecord,
  now: string,
  toolCalls: Map<string, { name?: string; input?: unknown }>,
): EngineEventBody[] {
  if (name === 'session.created') {
    const sessionId = str(data.sessionID)
    if (sessionId) {
      const model = (data.model ?? {}) as AnyRecord
      const modelId = str(model.id)
      const providerId = str(model.providerID)
      return [
        {
          type: 'session_started',
          session_id: sessionId,
          engine: 'opencode',
          engine_version: str(data.version) || 'unknown',
          model: modelId ? (providerId ? `${providerId}/${modelId}` : modelId) : undefined,
        },
      ]
    }
    return []
  }

  if (name === 'session.text.ended') {
    return [
      {
        type: 'message',
        role: 'assistant',
        text: str(data.text),
      },
    ]
  }

  if (name === 'session.usage.updated' || name === 'session.step.ended') {
    return usageBodiesOf(data)
  }

  // Tool lifecycle (real 2.2.5 shapes): input.started carries the call id and
  // tool NAME; tool.called the parsed input {command,…}; tool.success/failed the
  // outcome (content + metadata.exit). One tool_call per call, emitted on
  // completion — the calls map carries name/input across the three events.
  if (name === 'session.tool.input.started') {
    const id = str(data.id)
    if (id !== '') toolCalls.set(id, { ...toolCalls.get(id), name: str(data.name) })
    return []
  }
  if (name === 'session.tool.called') {
    const id = str(data.id)
    if (id !== '') toolCalls.set(id, { ...toolCalls.get(id), input: data.input })
    return []
  }
  if (name === 'session.tool.success' || name === 'session.tool.failed') {
    const id = str(data.id)
    if (!id) return []
    const call = toolCalls.get(id)
    toolCalls.delete(id)
    return [
      {
        type: 'tool_call',
        tool: call?.name ?? 'unknown',
        input: ((call?.input ?? null) as Json) ?? null,
        output: ((data.content ?? null) as Json) ?? null,
        ok: name === 'session.tool.success',
      },
    ]
  }

  if (name === 'permission.asked' || name === 'permission.updated') {
    // `permission.asked` carries the Permission.Request; `permission.updated` is
    // the echo of the reply we sent (once/always→allow, reject→deny).
    const requestId = str(data.id) || str(data.requestID)
    if (name === 'permission.updated') {
      const native = str(data.decision) || str(data.status)
      if (!requestId || !native) return []
      return [
        {
          type: 'permission_result',
          request_id: requestId,
          decision: native === 'reject' ? 'deny' : 'allow',
        },
      ]
    }
    if (!requestId) return []
    const resources = Array.isArray(data.resources) ? data.resources.map(String) : []
    const metadata = (data.metadata ?? {}) as AnyRecord
    const kind = operationKindOf(data)
    const command = Array.isArray(metadata.command) ? metadata.command.map(String) : undefined
    return [
      {
        type: 'permission_request',
        request_id: requestId,
        operation: {
          kind,
          summary:
            str(data.message) ||
            str(metadata.summary) ||
            (command ? command.join(' ') : '') ||
            `${str(data.action) || 'permission'} ${resources.join(' ')}`.trim() ||
            'permission request',
          command,
          // An edit's resource is its target, and it may be relative to the session's directory.
          paths: kind === 'edit' ? resources : resources.filter((r) => r.startsWith('/')),
          hosts: undefined,
          tool: str(metadata.tool) || undefined,
        },
        evidence: {
          raw: data as Json,
          worktree: '/unknown',
        },
      },
    ]
  }

  if (name === 'session.step.failed' || name === 'session.execution.failed') {
    const err = (data.error ?? {}) as AnyRecord
    return Object.keys(err).length > 0 ? errorBodiesOf(err, now) : []
  }

  if (name === 'error' || data.error !== undefined) {
    const err = (data.error ?? data) as AnyRecord
    return errorBodiesOf(err, now)
  }

  return [] // server.*, *.updated, session.inbox.*, session.reasoning.* … stay raw
}

/** Incremental form the adapter uses: push raw SSE lines, get completed bodies back. */
export type OpenCodeEventParser = {
  push(line: string): EngineEventBody[]
  /** Emits the held turn-end exit, if any: the adapter calls this when its SSE stream ends. */
  flush(): EngineEventBody[]
}

export function createOpenCodeEventParser(now: string = new Date().toISOString()): OpenCodeEventParser {
  let pendingName: string | undefined
  let sawError = false
  const toolCalls = new Map<string, { name?: string; input?: unknown }>()
  // The real server keeps talking AFTER the execution verdict (a final
  // cumulative session.usage.updated, session.renamed …), while CONTRACTS §1
  // makes exit the attempt's last event. The verdict is therefore HELD and
  // flushed at stream end — or pre-emptively when the next turn's prompt
  // arrives (session.inbox.enqueued), whichever comes first.
  let pendingExit: EngineEventBody | undefined
  return {
    push(line: string): EngineEventBody[] {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith(':')) return [] // heartbeats/SSE comments
      if (trimmed.startsWith('event:')) {
        pendingName = trimmed.slice('event:'.length).trim()
        return []
      }
      if (!trimmed.startsWith('data:')) return []
      let parsed: AnyRecord
      try {
        parsed = JSON.parse(trimmed.slice('data:'.length).trim()) as AnyRecord
      } catch {
        return [] // a torn line is skipped; the journal owns durability
      }
      // Real 2.2.5: `{id, created, type, location, data}` — name top-level,
      // payload nested under `data`. Tolerate a flat payload (no envelope).
      const name = pendingName ?? str(parsed.type)
      pendingName = undefined
      if (!name) return []
      const payload =
        parsed.data !== undefined && typeof parsed.data === 'object' && parsed.data !== null
          ? (parsed.data as AnyRecord)
          : parsed
      if (pendingExit !== undefined && name === 'session.inbox.enqueued') {
        // a new turn starts: the previous turn's exit goes out first
        const held = pendingExit
        pendingExit = undefined
        const bodies = mapOpenCodeEvent(name, payload, now, toolCalls)
        return [held, ...bodies]
      }
      const bodies = mapOpenCodeEvent(name, payload, now, toolCalls)
      if (bodies.some((body) => body.type === 'error')) sawError = true
      if (name === 'session.execution.succeeded') {
        pendingExit = {
          type: 'exit',
          code: sawError ? 1 : 0,
          terminal_reason: (sawError ? 'api_error' : 'completed') as TerminalReason,
        }
        return bodies
      }
      if (name === 'session.execution.failed') {
        pendingExit = { type: 'exit', code: 1, terminal_reason: 'api_error' as TerminalReason }
        return bodies
      }
      return bodies
    },
    flush(): EngineEventBody[] {
      const held = pendingExit
      pendingExit = undefined
      return held === undefined ? [] : [held]
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
  events.push(...parser.flush())
  return events
}
