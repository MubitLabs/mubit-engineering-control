/**
 * The parking classifier (plan §5.9; the §26 "Quota park" row's runtime half).
 *
 * An attempt's normalised events are all the evidence parking needs: the adapters already
 * classify provider failures (`error` events) and surface quota windows (`rate_limit`
 * events), so this scan turns one attempt's stream into the slot state the scheduler
 * should hold next:
 * - an `error` of class quota / auth / provider_down parks in the matching state;
 * - a `rate_limit` with status `rejected` parks as `quota_wait`, the reason naming the
 *   window that was exhausted (`allowed` and `warning` never park — the engine is still
 *   working within those windows).
 *
 * Ordering is last-writer-wins over the parking signals in stream order: interleaved
 * progress (messages, tool calls, usage) is not a signal, and neither are `engine_bug`,
 * `repo_failure` or `unknown` errors — those are attempt-local, not slot health, so they
 * never mask an earlier quota/auth/provider signal. A stream with no parking signal at
 * all leaves the slot alone: `{ park: false }`.
 */
import type { EngineEvent, ErrorClass } from '@mec/contracts'

export type ParkDecision =
  | { park: false }
  | {
      park: true
      state: 'quota_wait' | 'auth_required' | 'provider_down'
      reason: string
      /** The reset the engine reported, when it reported one. */
      resetsAt?: string
    }

/** The parkable error classes; the attempt-local classes map to nothing and are skipped. */
const ERROR_PARK_STATE: Readonly<
  Record<ErrorClass, 'quota_wait' | 'auth_required' | 'provider_down' | undefined>
> = {
  quota: 'quota_wait',
  auth: 'auth_required',
  provider_down: 'provider_down',
  engine_bug: undefined,
  repo_failure: undefined,
  unknown: undefined,
}

export function parkFromEvents(events: readonly EngineEvent[]): ParkDecision {
  let decision: ParkDecision = { park: false }
  for (const event of events) {
    if (event.type === 'error') {
      const state = ERROR_PARK_STATE[event.class]
      if (state !== undefined) {
        decision = { park: true, state, reason: `${event.class} error: ${event.detail}` }
      }
    } else if (event.type === 'rate_limit' && event.status === 'rejected') {
      const resets =
        typeof event.resets_at === 'string' && event.resets_at !== 'unknown'
          ? ` (resets at ${event.resets_at})`
          : ''
      decision = {
        park: true,
        state: 'quota_wait',
        reason: `rate_limit rejected in window ${event.window}${resets}`,
        ...(resets !== '' && { resetsAt: String(event.resets_at) }),
      }
    }
  }
  return decision
}

/** What §10 says of a mandate before a resume; the same shape `revalidate` answers with. */
export type MandateCheck = { ok: true } | { ok: false; reason: 'expired' | 'withdrawn' | 'policy_changed' }

export type ResumeVerdict =
  | { verdict: 'run' }
  | { verdict: 'defer'; reason: 'held' | 'blocked' | 'host_run_unagreed' }
  | { verdict: 'drop'; reason: 'mandate_expired' | 'mandate_withdrawn' | 'policy_changed' }

/**
 * §5.10, §10, §13.4, in the launch gate's order: a dead mandate ends the resume, a hold keeps it
 * waiting, and a policy change alone does not outrank a hold. Nothing here lifts one. Blocked work
 * and a repository the owner has not agreed to wait the same way.
 */
export function resumeVerdict(input: {
  held: boolean
  mandate: MandateCheck
  blocked?: boolean
  agreed?: boolean
}): ResumeVerdict {
  const { held, mandate, blocked = false, agreed = true } = input
  if (!mandate.ok && mandate.reason !== 'policy_changed') {
    return { verdict: 'drop', reason: `mandate_${mandate.reason}` }
  }
  if (held) return { verdict: 'defer', reason: 'held' }
  if (blocked) return { verdict: 'defer', reason: 'blocked' }
  if (!agreed) return { verdict: 'defer', reason: 'host_run_unagreed' }
  return mandate.ok ? { verdict: 'run' } : { verdict: 'drop', reason: 'policy_changed' }
}

/**
 * §5.10: a reported reset makes parked work eligible once a probe confirms health; an unknown one
 * waits for the next healthy probe. `resuming` is the row already on its way: it resumes once.
 */
export function parkReady(input: {
  resetsAt?: string
  slotHealthy: boolean
  resuming: boolean
  now: string
}): boolean {
  const { resetsAt, slotHealthy, resuming, now } = input
  if (resuming || !slotHealthy) return false
  return resetsAt === undefined || resetsAt === 'unknown' || resetsAt <= now
}
