import { z } from 'zod'
import { Decision, Evidence, Operation } from './bridge'
import { AttemptId, EngineId, Generation, IsoTime, Json } from './common'
import { Unknown } from './internal'
import { Report } from './report'
import { matchesSecret } from './secrets'

/*
 * The normalised, engine-agnostic stream every adapter emits and the FakeEngine replays (CONTRACTS §1).
 * Mapping notes from Stream B's recordings of Claude Code 2.1.317 (docs/engines.md):
 * - One `rate_limit_event` carries several `unifiedWindows`; the adapter emits one `rate_limit` per window.
 * - `resetsAt` arrives in unix seconds; the adapter converts it with `toISOString()`.
 * - `raw` carries the engine event's top-level fields, so on the `seven_day` event `raw.rateLimitType`
 *   names the binding window (`five_hour`), not that event's own window.
 * - `system/commands_changed` is not normalised; the raw stream and the journal keep it.
 * - `role: 'user'` appears only for streamed two-way input. A static `-p` prompt is not echoed, and
 *   user-type events carrying `tool_result` blocks complete a `tool_call` instead.
 * - `exit.terminal_reason` comes from the engine's `terminal_reason`, never `result.subtype` (which says
 *   `success` on an auth failure). With no `result` (a crash), the runtime emits `exit` itself:
 *   `{ code: 128 + signal, terminal_reason: 'crashed' }`.
 */

export const Window = z.enum([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'weekly',
  'per_minute',
  'per_day',
  'overage',
  'unknown',
])

export const ErrorClass = z.enum(['quota', 'auth', 'provider_down', 'engine_bug', 'repo_failure', 'unknown'])

export const TerminalReason = z.enum([
  'completed',
  'max_turns',
  'budget',
  'api_error',
  'aborted',
  'killed',
  'crashed',
])

/** Claude's `allowed_warning` maps to `warning`. */
export const RateLimitStatus = z.enum(['allowed', 'warning', 'rejected'])

export const MessageRole = z.enum(['assistant', 'user', 'system'])

const Count = z.int().min(0)

const SessionStarted = z.strictObject({
  type: z.literal('session_started'),
  /** What resume needs. */
  session_id: z.string().min(1),
  engine: EngineId,
  engine_version: z.string().min(1),
  model: z.string().min(1).optional(),
})

const Message = z.strictObject({
  type: z.literal('message'),
  role: MessageRole,
  /** Already redacted. */
  text: z.string(),
  truncated: z.boolean().optional(),
})

/** One event per call, emitted when the call completes. */
const ToolCall = z.strictObject({
  type: z.literal('tool_call'),
  tool: z.string().min(1),
  input: Json,
  output: Json.optional(),
  ok: z.boolean().optional(),
  duration_ms: z.number().min(0).optional(),
})

const PermissionRequest = z.strictObject({
  type: z.literal('permission_request'),
  request_id: z.string().min(1),
  operation: Operation,
  evidence: Evidence,
})

/** Echo of what the engine was told. */
const PermissionResult = z.strictObject({
  type: z.literal('permission_result'),
  request_id: z.string().min(1),
  decision: Decision,
})

/** Cumulative or delta as the adapter's `Capabilities.usage_mode` says. */
const Usage = z.strictObject({
  type: z.literal('usage'),
  input_tokens: Count,
  output_tokens: Count,
  cache_read: Count.optional(),
  cache_write: Count.optional(),
  cost_usd: z.union([z.number().min(0), Unknown]).optional(),
})

const RateLimit = z.strictObject({
  type: z.literal('rate_limit'),
  window: Window,
  status: RateLimitStatus,
  utilization: z.number().min(0).max(1).optional(),
  resets_at: z.union([IsoTime, Unknown]).optional(),
  raw: Json.optional(),
})

const ReportEvent = z.strictObject({
  type: z.literal('report'),
  report: Report,
})

const ErrorEvent = z.strictObject({
  type: z.literal('error'),
  class: ErrorClass,
  detail: z.string(),
  raw: Json.optional(),
})

const Exit = z.strictObject({
  type: z.literal('exit'),
  code: z.int(),
  terminal_reason: TerminalReason,
})

/** The fixture form (`events.jsonl`): no `seq`, `at`, `attempt_id` or `generation`; the replayer assigns them. */
export const EngineEventBody = z.discriminatedUnion('type', [
  SessionStarted,
  Message,
  ToolCall,
  PermissionRequest,
  PermissionResult,
  Usage,
  RateLimit,
  ReportEvent,
  ErrorEvent,
  Exit,
])

/** `seq` is monotonic per attempt and assigned by the runtime. */
export const EventEnvelope = z.strictObject({
  seq: Count,
  at: IsoTime,
  attempt_id: AttemptId,
  generation: Generation,
})

export const EngineEvent = z.discriminatedUnion('type', [
  SessionStarted.extend(EventEnvelope.shape),
  Message.extend(EventEnvelope.shape),
  ToolCall.extend(EventEnvelope.shape),
  PermissionRequest.extend(EventEnvelope.shape),
  PermissionResult.extend(EventEnvelope.shape),
  Usage.extend(EventEnvelope.shape),
  RateLimit.extend(EventEnvelope.shape),
  ReportEvent.extend(EventEnvelope.shape),
  ErrorEvent.extend(EventEnvelope.shape),
  Exit.extend(EventEnvelope.shape),
])

export type Window = z.infer<typeof Window>
export type ErrorClass = z.infer<typeof ErrorClass>
export type TerminalReason = z.infer<typeof TerminalReason>
export type RateLimitStatus = z.infer<typeof RateLimitStatus>
export type MessageRole = z.infer<typeof MessageRole>
export type EngineEventBody = z.infer<typeof EngineEventBody>
export type EventEnvelope = z.infer<typeof EventEnvelope>
export type EngineEvent = z.infer<typeof EngineEvent>

export type StreamRule =
  | 'session_started_first'
  | 'single_session_started'
  | 'exit_last'
  | 'single_exit'
  | 'seq_increasing'
  | 'no_secret_in_message'

export type StreamViolation = { rule: StreamRule; index: number }

/**
 * The CONTRACTS §1 invariants. Accepts fixture bodies (no `seq`, so the order rule is skipped) or
 * enveloped events. Returns every violation; an empty array means the stream holds.
 */
export function checkEventStream(events: readonly (EngineEventBody & { seq?: number })[]): StreamViolation[] {
  const violations: StreamViolation[] = []
  const last = events.length - 1
  if (events[0]?.type !== 'session_started') violations.push({ rule: 'session_started_first', index: 0 })
  if (events[last]?.type !== 'exit') violations.push({ rule: 'exit_last', index: Math.max(last, 0) })
  let sessions = 0
  let exits = 0
  events.forEach((event, index) => {
    if (event.type === 'session_started' && ++sessions > 1) {
      violations.push({ rule: 'single_session_started', index })
    }
    if (event.type === 'exit' && ++exits > 1) violations.push({ rule: 'single_exit', index })
    const previous = events[index - 1]?.seq
    if (event.seq !== undefined && previous !== undefined && event.seq <= previous) {
      violations.push({ rule: 'seq_increasing', index })
    }
    if (event.type === 'message' && matchesSecret(event.text)) {
      violations.push({ rule: 'no_secret_in_message', index })
    }
  })
  return violations
}
