/**
 * Mandates, plan §10: the work item's authority to run — origin message, scope,
 * policy version, budget, expiry. Only three operations change a mandate: admission
 * creates it, the user's stop withdraws it, failed revalidation revokes it
 * (`expire`). A withdrawn or expired mandate never resumes silently; `revalidate`
 * runs before every resume and says why it refused.
 *
 * A policy hash change never cancels live work (§27 "Cancelling live work on a
 * policy change" — rejected): `revalidate` reports `policy_changed` and nothing
 * more. The caller delivers a note and lets running attempts finish; the item
 * continues only once a mandate revalidates clean (a fresh admission under the new
 * policy). All functions here are pure: they return new values and never mutate
 * their input.
 *
 * Timestamps are ISO-8601 strings compared lexicographically (same zone-normalised
 * format), so `now > expiresAt` is a valid expiry test and equality — the expiry
 * instant itself — is still valid.
 */

export type Mandate = {
  id: string
  originMessageId: string
  scope: string
  policyHash: string
  budgetTurns: number
  expiresAt: string | null
  status: 'active' | 'withdrawn' | 'expired'
}

export function createMandate(input: Omit<Mandate, 'id' | 'status'> & { id: string }): Mandate {
  return { ...input, status: 'active' }
}

/** The user's stop (§12.5): the mandate is withdrawn and never resumes. Idempotent. */
export function withdraw(m: Mandate, at: string): { mandate: Mandate; events: string[] } {
  if (m.status === 'withdrawn') return { mandate: m, events: [] }
  return { mandate: { ...m, status: 'withdrawn' }, events: [`mandate ${m.id} withdrawn at ${at}`] }
}

/** Failed revalidation revokes (§10). Idempotent. The caller keeps the events. */
export function expire(m: Mandate, at: string): { mandate: Mandate; events: string[] } {
  if (m.status === 'expired') return { mandate: m, events: [] }
  return { mandate: { ...m, status: 'expired' }, events: [`mandate ${m.id} expired at ${at}`] }
}

/**
 * Run before every resume. `withdrawn` outranks everything (a stop is final even
 * past expiry); then expiry by ISO compare (valid through the expiry instant); then
 * the policy hash. `policy_changed` revokes nothing by itself — the caller delivers
 * a note instead of cancelling live work (§27).
 */
export function revalidate(
  m: Mandate,
  now: string,
  policyHash: string,
): { ok: true } | { ok: false; reason: 'withdrawn' | 'expired' | 'policy_changed' } {
  if (m.status === 'withdrawn') return { ok: false, reason: 'withdrawn' }
  if (m.status === 'expired' || (m.expiresAt !== null && now > m.expiresAt)) {
    return { ok: false, reason: 'expired' }
  }
  if (policyHash !== m.policyHash) return { ok: false, reason: 'policy_changed' }
  return { ok: true }
}
