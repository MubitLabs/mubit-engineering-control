/**
 * Per-attempt outcome records, plan §19 (Observability-lite): the durable event log is the
 * authority, and this projection turns one attempt's `EngineEvent` stream into the record a
 * scorecard reads — turns, duration, reported tokens and cost, terminal result, permission
 * traffic, quota parks and errors.
 *
 * Projection choices (each follows §19's rule that missing data is *unknown, not zero*):
 * - The stream is filtered to `attemptId` first: the log holds many attempts and this
 *   projection never borrows another attempt's facts.
 * - `turns` counts `usage` events — contracts send one per completed turn — and falls back to
 *   assistant `message` events only when the adapter surfaced no usage at all
 *   (`usage_mode: 'none'`); both count exactly the turns the engine finished.
 * - `durationMs` spans the first envelope `at` to the last. It is `'unknown'` when there are
 *   fewer than two events or the span is zero: an immediate crash, where the runtime's own
 *   `exit` (contracts §1 crash rule) lands in the same tick as `session_started`, leaves no
 *   elapsed time to report — a guess stays out of the record.
 * - Tokens and cost come from the LAST `usage` event: the contracts' cumulative `usage_mode`
 *   (§4 of the adapter contract) makes it the freshest running total. Absent readings are
 *   `'unknown'`, never 0; an engine that really reported 0 keeps its 0.
 * - `result` is the `exit` event's `terminal_reason`; with no `exit` (a stream that died before
 *   the runtime synthesised one) it is `'unknown'`.
 * - `quotaParks` counts `rate_limit` events with status `rejected` — plan §5.9's park signal.
 * - `slotId` and `role` stay undefined: the event stream carries neither, and the caller
 *   decorates the record from the attempt row (which slot ran it, in which role).
 * - `coverage` records what the adapter actually surfaced (§19): `lifecycle` needs both
 *   `session_started` and `exit`; `usage` and `rateLimit` need at least one event of that kind.
 */
import type { EngineEvent } from '@mec/contracts'

export type AttemptOutcome = {
  attemptId: string
  slotId?: string
  engine?: string
  role?: string
  turns: number
  durationMs: number | 'unknown'
  inputTokens: number | 'unknown'
  outputTokens: number | 'unknown'
  costUsd: number | 'unknown'
  result: 'completed' | 'max_turns' | 'budget' | 'api_error' | 'aborted' | 'killed' | 'crashed' | 'unknown'
  permissionRequests: number
  quotaParks: number
  errors: number
  coverage: { lifecycle: boolean; usage: boolean; rateLimit: boolean }
}

type SessionStartedEvent = Extract<EngineEvent, { type: 'session_started' }>
type UsageEvent = Extract<EngineEvent, { type: 'usage' }>
type RateLimitEvent = Extract<EngineEvent, { type: 'rate_limit' }>
type ExitEvent = Extract<EngineEvent, { type: 'exit' }>

function durationOf(events: readonly EngineEvent[]): number | 'unknown' {
  if (events.length < 2) return 'unknown'
  const first = events[0]
  const last = events.at(-1)
  if (first === undefined || last === undefined) return 'unknown'
  const start = Date.parse(first.at)
  const end = Date.parse(last.at)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'unknown'
  return end - start > 0 ? end - start : 'unknown'
}

export function projectAttempt(attemptId: string, events: readonly EngineEvent[]): AttemptOutcome {
  const own = events.filter((event) => event.attempt_id === attemptId)
  const started = own.find((event): event is SessionStartedEvent => event.type === 'session_started')
  const usage = own.filter((event): event is UsageEvent => event.type === 'usage')
  const rateLimits = own.filter((event): event is RateLimitEvent => event.type === 'rate_limit')
  const exit = own.find((event): event is ExitEvent => event.type === 'exit')
  const lastUsage = usage.at(-1)
  const turns =
    usage.length > 0
      ? usage.length
      : own.filter((event) => event.type === 'message' && event.role === 'assistant').length

  return {
    attemptId,
    engine: started?.engine,
    turns,
    durationMs: durationOf(own),
    inputTokens: lastUsage?.input_tokens ?? 'unknown',
    outputTokens: lastUsage?.output_tokens ?? 'unknown',
    costUsd: lastUsage?.cost_usd ?? 'unknown',
    result: exit?.terminal_reason ?? 'unknown',
    permissionRequests: own.filter((event) => event.type === 'permission_request').length,
    quotaParks: rateLimits.filter((event) => event.status === 'rejected').length,
    errors: own.filter((event) => event.type === 'error').length,
    coverage: {
      lifecycle: started !== undefined && exit !== undefined,
      usage: usage.length > 0,
      rateLimit: rateLimits.length > 0,
    },
  }
}
