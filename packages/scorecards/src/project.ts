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
 * - Tokens and cost are one mode-aware total (`totalOf`): cumulative mode reads the running
 *   counter, delta mode sums. A replayed event (same generation and seq) counts once. Absent
 *   readings are `'unknown'`, never 0; an engine that really reported 0 keeps its 0.
 *   `spendCoverage` says whether the figure is a total or a known subtotal: a usage event with
 *   no cost, or a cumulative counter that restarted, leaves a floor and not a total.
 * - Process, validation and delivery are three facts: `result` is how the process ended,
 *   `validation` what the checks said on the exact head, and `delivery` whether a tested PR
 *   exists. A clean exit alone proves neither of the other two.
 * - `result` is the `exit` event's `terminal_reason`; with no `exit` (a stream that died before
 *   the runtime synthesised one) it is `'unknown'`.
 * - `quotaParks` counts `rate_limit` events with status `rejected` — plan §5.9's park signal.
 * - `slotId` and `role` stay undefined: the event stream carries neither, and the caller
 *   decorates the record from the attempt row (which slot ran it, in which role).
 * - `coverage` records what the adapter actually surfaced (§19): `lifecycle` needs both
 *   `session_started` and `exit`; `usage` and `rateLimit` need at least one event of that kind.
 * - The tier-era fields (§5.5) come from an optional `AttemptContext`: the stream holds what
 *   the engine said, while the tier asked for, the model the runtime launched, the task and
 *   repository the attempt belongs to, and the adapter's `usage_mode` live on the attempt row.
 *   `utilisationDelta` reads last − before on one window — a lone reading never fakes a 0,
 *   and a mid-attempt reset keeps its real negative.
 */
import type { EngineEvent, UsageMode } from '@mec/contracts'
import type { LaunchModel, ModelTier } from './tiers'

export type SpendCoverage = 'total' | 'subtotal' | 'unknown'
export type Validation = 'passed' | 'failed' | 'unknown'
export type DeliveryOutcome = 'delivered' | 'not-delivered' | 'unknown'

/** One check result as `check/<attempt>/<name>` stores it. */
export type CheckRecord = { name: string; status: string; sha: string }

export type AttemptOutcome = {
  attemptId: string
  slotId?: string
  engine?: string
  role?: string
  turns: number
  durationMs: number | 'unknown'
  inputTokens: number | 'unknown'
  outputTokens: number | 'unknown'
  /** The same figure as `spend`: there is one calculation. */
  costUsd: number | 'unknown'
  /** How the process ended. `completed` says nothing about checks or delivery. */
  result: 'completed' | 'max_turns' | 'budget' | 'api_error' | 'aborted' | 'killed' | 'crashed' | 'unknown'
  permissionRequests: number
  quotaParks: number
  errors: number
  coverage: { lifecycle: boolean; usage: boolean; rateLimit: boolean }
  /** The tier the brief asked for (§5.5); undefined = an explicit-model or pre-tier ask. */
  tier?: ModelTier
  /** What the runtime actually launched (contracts-v0.1 `LaunchSpec.model`); null when nothing did. */
  resolvedModel: LaunchModel | null
  /** e.g. `'strong→balanced (provider has no strong)'` (§3 rule 1); null when the tier held. */
  tierDegraded: string | null
  /** Total spend over the attempt from usage events, as the adapter's `usage_mode` adds up. */
  spend: number | 'unknown'
  /** `subtotal`: spend is known to be missing from `spend`, so it is a floor and never a total. */
  spendCoverage: SpendCoverage
  /** What the checks said on the exact head; a check from another head does not count. */
  validation: Validation
  /** `delivered` needs validation passed and a ready or merged PR; a clean exit never is. */
  delivery: DeliveryOutcome
  /** Last − before utilisation on one window; null without a genuine pair of readings. */
  utilisationDelta: number | null
  repository?: string
  taskId?: string
  /** Findings the attempt's report carried, when it was a review that reported. */
  reviewFindings?: number
}

/**
 * Tier-era facts the event stream does not carry (plan §5.5; the contracts-v0.1 change adding
 * them to the brief and launch spec is in flight). Every field is optional, so the pre-tier
 * two-argument call keeps working unchanged — its rows read the tier fields as unknown.
 */
export type AttemptContext = {
  tier?: ModelTier
  resolvedModel?: LaunchModel | null
  tierDegraded?: string | null
  /** The adapter's `Capabilities.usage_mode`; defaults to `'cumulative'` (the contracts' primary). */
  usageMode?: UsageMode
  repository?: string
  taskId?: string
  reviewFindings?: number
  /** The head the attempt ended on; checks speak only for this exact commit. */
  head?: string
  checks?: readonly CheckRecord[]
  /** The stage of the work item's `delivery/<work>` record. */
  deliveryStage?: string
}

/** A PR that is ready for review or merged: the default delivery (the handoffs' goal). */
const DELIVERED_STAGES: readonly string[] = ['ready', 'merged']

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

/**
 * One total from a run of readings (CONTRACTS §4). Cumulative mode reports a running counter, so
 * the freshest reading is the total; delta mode reports per-turn figures, so the total is the sum.
 * No reading at all stays `'unknown'`, never 0; a reported 0 stays 0.
 */
function totalOf(readings: readonly number[], mode: UsageMode): number | 'unknown' {
  if (mode === 'none' || readings.length === 0) return 'unknown'
  if (mode === 'delta') return readings.reduce((sum, value) => sum + value, 0)
  return readings.at(-1) ?? 'unknown'
}

/** A cumulative counter that fell has restarted: what it had reached is not in the last reading. */
const restarted = (readings: readonly number[]): boolean =>
  readings.some((value, index) => index > 0 && value < (readings[index - 1] ?? 0))

function spendOf(
  usage: readonly UsageEvent[],
  mode: UsageMode,
): { spend: number | 'unknown'; spendCoverage: SpendCoverage } {
  const costs = usage
    .map((event) => event.cost_usd)
    .filter((cost): cost is number => typeof cost === 'number')
  const spend = totalOf(costs, mode)
  if (spend === 'unknown') return { spend, spendCoverage: 'unknown' }
  const partial = costs.length < usage.length || (mode === 'cumulative' && restarted(costs))
  return { spend, spendCoverage: partial ? 'subtotal' : 'total' }
}

/** A replay delivers the same event twice; generation and seq name it. */
function uniqueEvents(events: readonly EngineEvent[]): EngineEvent[] {
  const seen = new Set<string>()
  return events.filter((event) => {
    const key = `${event.generation}:${event.seq}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Only checks on the exact head speak; `error` (a timeout, a spawn failure) is not a pass. */
function validationOf(context: AttemptContext): Validation {
  const onHead = (context.checks ?? []).filter((check) => check.sha === context.head)
  if (context.head === undefined || onHead.length === 0) return 'unknown'
  return onHead.every((check) => check.status === 'passed') ? 'passed' : 'failed'
}

function deliveryOf(validation: Validation, stage: string | undefined): DeliveryOutcome {
  if (validation === 'failed') return 'not-delivered'
  if (validation === 'unknown' || stage === undefined) return 'unknown'
  return DELIVERED_STAGES.includes(stage) ? 'delivered' : 'not-delivered'
}

/**
 * How far the attempt moved one window's utilisation: last − before on the first window (in
 * stream order) that reported a genuine pair of readings. A lone reading never fakes a 0, and
 * a window that reset mid-attempt keeps its real negative (§5.5).
 */
function utilisationDeltaOf(rateLimits: readonly RateLimitEvent[]): number | null {
  const readings = new Map<string, number[]>()
  for (const event of rateLimits) {
    if (typeof event.utilization !== 'number') continue
    const seen = readings.get(event.window)
    if (seen === undefined) readings.set(event.window, [event.utilization])
    else seen.push(event.utilization)
  }
  for (const seen of readings.values()) {
    const before = seen[0]
    const last = seen.at(-1)
    if (before !== undefined && last !== undefined && seen.length >= 2) return last - before
  }
  return null
}

export function projectAttempt(
  attemptId: string,
  events: readonly EngineEvent[],
  context: AttemptContext = {},
): AttemptOutcome {
  const own = uniqueEvents(events.filter((event) => event.attempt_id === attemptId))
  const started = own.find((event): event is SessionStartedEvent => event.type === 'session_started')
  const usage = own.filter((event): event is UsageEvent => event.type === 'usage')
  const rateLimits = own.filter((event): event is RateLimitEvent => event.type === 'rate_limit')
  const exit = own.find((event): event is ExitEvent => event.type === 'exit')
  const usageMode = context.usageMode ?? 'cumulative'
  const tokens = (field: 'input_tokens' | 'output_tokens'): number | 'unknown' =>
    totalOf(
      usage.map((event) => event[field]),
      usageMode === 'none' ? 'cumulative' : usageMode,
    )
  const { spend, spendCoverage } = spendOf(usage, usageMode)
  const validation = validationOf(context)
  const turns =
    usage.length > 0
      ? usage.length
      : own.filter((event) => event.type === 'message' && event.role === 'assistant').length

  return {
    attemptId,
    engine: started?.engine,
    turns,
    durationMs: durationOf(own),
    inputTokens: tokens('input_tokens'),
    outputTokens: tokens('output_tokens'),
    costUsd: spend,
    result: exit?.terminal_reason ?? 'unknown',
    permissionRequests: own.filter((event) => event.type === 'permission_request').length,
    quotaParks: rateLimits.filter((event) => event.status === 'rejected').length,
    errors: own.filter((event) => event.type === 'error').length,
    coverage: {
      lifecycle: started !== undefined && exit !== undefined,
      usage: usage.length > 0,
      rateLimit: rateLimits.length > 0,
    },
    tier: context.tier,
    resolvedModel:
      context.resolvedModel !== undefined
        ? context.resolvedModel
        : started?.model !== undefined
          ? { id: started.model }
          : null,
    tierDegraded: context.tierDegraded ?? null,
    spend,
    spendCoverage,
    validation,
    delivery: deliveryOf(validation, context.deliveryStage),
    utilisationDelta: utilisationDeltaOf(rateLimits),
    repository: context.repository,
    taskId: context.taskId,
    reviewFindings: context.reviewFindings,
  }
}
