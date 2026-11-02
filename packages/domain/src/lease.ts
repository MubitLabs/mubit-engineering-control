import { err, ok, type Result } from './machine'

/**
 * Durable leases, PDF §11. A lease gives one runner the right to act for one attempt generation.
 * Expiry alone does not prove the old process is dead; it only stops authoritative writes until
 * the runner reconciles.
 */

export const LEASE_DEFAULTS = {
  heartbeatMs: 10_000,
  ttlMs: 60_000,
} as const

export interface Lease {
  attemptId: string
  runnerId: string
  generation: number
  expiresAt: Date
}

export interface RunnerClaim {
  runnerId: string
  generation: number
}

/**
 * 'telemetry' events are journalled even after expiry so evidence is not lost.
 * 'authoritative' actions (results, task state, pushes, integration requests) need a live lease.
 */
export type FencePurpose = 'telemetry' | 'authoritative'

export type FenceError = 'wrong_runner' | 'stale_generation' | 'future_generation' | 'lease_expired'

export function fence(
  lease: Lease,
  claim: RunnerClaim,
  now: Date,
  purpose: FencePurpose,
): Result<true, FenceError> {
  if (claim.runnerId !== lease.runnerId) return err('wrong_runner')
  if (claim.generation < lease.generation) return err('stale_generation')
  if (claim.generation > lease.generation) return err('future_generation')
  if (purpose === 'authoritative' && isExpired(lease, now)) return err('lease_expired')
  return ok(true)
}

export function isExpired(lease: Lease, now: Date): boolean {
  return now.getTime() >= lease.expiresAt.getTime()
}

export function renew(lease: Lease, now: Date, ttlMs: number = LEASE_DEFAULTS.ttlMs): Lease {
  return { ...lease, expiresAt: new Date(now.getTime() + ttlMs) }
}

/** A resumed or re-dispatched attempt gets a new generation; older generations are fenced. */
export function nextGeneration(lease: Lease, now: Date, ttlMs: number = LEASE_DEFAULTS.ttlMs): Lease {
  return { ...lease, generation: lease.generation + 1, expiresAt: new Date(now.getTime() + ttlMs) }
}

export type SequenceCheck = { kind: 'next' } | { kind: 'gap'; missing: number } | { kind: 'out_of_order' }

/**
 * Runner events carry an increasing local sequence per attempt. Duplicates are caught earlier by
 * (runner, eventId); a new event with an old sequence is a protocol violation, a jump is a gap.
 */
export function checkSequence(lastSequence: number | null, sequence: number): SequenceCheck {
  const last = lastSequence ?? -1
  if (sequence <= last) return { kind: 'out_of_order' }
  if (sequence > last + 1) return { kind: 'gap', missing: sequence - last - 1 }
  return { kind: 'next' }
}
