/**
 * Task acceptance, spec §10, §15 and decision #32: local checks on the exact head decide, not an
 * engine exit and not what the attempt says about itself. Pure over a snapshot. Every verdict
 * binds its SHA, so a head that moved has no verdict, and a stale green is never reused.
 *
 * `failed` (ran, non-zero) is the code's fault and goes to a repair. `error` (could not start,
 * timed out) says nothing about the code, so no repair can answer it and a person must look.
 *
 * UI evidence (§15) applies only where a repository requires it. Repository docs have no such
 * field yet, so it is not required here.
 */

/** Stands for "no checks are registered". It names no command, so it can never pass by itself. */
export const NO_CHECKS_MARKER = 'manual-review'

export type CheckVerdict = {
  name: string
  status: 'passed' | 'failed' | 'error'
  /** The commit this ran on. */
  sha: string
  logTail?: string
}

/** A reviewer's finding, bound to the commit it read (§15). */
export type BoundFinding = { text: string; sha: string }

export type AcceptanceInput = {
  attemptState: string
  /** The attempt's head as MEC read it, never as the attempt claimed it. */
  head?: string
  /** The attempt's last report: a `ready` says which head it speaks for. */
  report?: { kind: string; headSha?: string }
  required: readonly string[]
  verdicts: readonly CheckVerdict[]
  findings: readonly BoundFinding[]
  policy: { sensitive: boolean; reviewedSha?: string }
}

export type RepairReason = 'checks_failed' | 'finding' | 'report_head'

export type Acceptance =
  | { verdict: 'accepted'; head: string }
  /** Sensitive work with no accepted review on this head yet (#13). */
  | { verdict: 'review'; head: string }
  | {
      verdict: 'repair'
      reason: RepairReason
      head: string
      failing: { name: string; logTail: string }[]
      findings: string[]
    }
  /** A person must act; `reason` says on what. */
  | { verdict: 'blocked'; reason: string }
  /** Nothing to decide yet. */
  | { verdict: 'pending'; reason: string }

const NO_VERDICT_YET = new Set(['queued', 'running', 'stalled', 'quota_wait', 'auth_required'])

const named = (names: readonly string[]): string => names.join(', ')

export function acceptance(input: AcceptanceInput): Acceptance {
  const { attemptState, head, policy, report } = input
  const required = input.required.filter((name) => name !== NO_CHECKS_MARKER)
  if (NO_VERDICT_YET.has(attemptState)) return { verdict: 'pending', reason: `attempt is ${attemptState}` }
  if (required.length === 0) {
    return { verdict: 'blocked', reason: 'no checks are registered, so nothing can accept this work' }
  }
  if (attemptState !== 'succeeded' && attemptState !== 'checks_failed') {
    return { verdict: 'pending', reason: `attempt is ${attemptState}` }
  }
  if (head === undefined) return { verdict: 'pending', reason: 'the attempt has no head' }

  const onHead = input.verdicts.filter((verdict) => verdict.sha === head)
  const statusOf = (name: string) => onHead.find((verdict) => verdict.name === name)
  const errored = required.filter((name) => statusOf(name)?.status === 'error')
  if (errored.length > 0) {
    return { verdict: 'blocked', reason: `could not run ${named(errored)} on ${head}` }
  }
  const failing = required.flatMap((name) => {
    const verdict = statusOf(name)
    return verdict?.status === 'failed' ? [{ name, logTail: verdict.logTail ?? '' }] : []
  })
  if (failing.length > 0) {
    return { verdict: 'repair', reason: 'checks_failed', head, failing, findings: [] }
  }
  const missing = required.filter((name) => statusOf(name)?.status !== 'passed')
  if (missing.length > 0) {
    return { verdict: 'blocked', reason: `no verdict for ${named(missing)} on ${head}` }
  }

  if (report?.kind === 'ready' && report.headSha !== head) {
    return { verdict: 'repair', reason: 'report_head', head, failing: [], findings: [] }
  }
  const findings = input.findings.filter((finding) => finding.sha === head).map((finding) => finding.text)
  if (findings.length > 0) return { verdict: 'repair', reason: 'finding', head, failing: [], findings }
  if (policy.sensitive && policy.reviewedSha !== head) return { verdict: 'review', head }
  return { verdict: 'accepted', head }
}
