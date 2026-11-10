/**
 * Task acceptance, spec §10, §15 and decision #32: local checks on the exact head decide, not an
 * engine exit and not what the attempt says about itself. Pure over a snapshot. Every verdict
 * binds its SHA, so a head that moved has no verdict, and a stale green is never reused.
 *
 * `failed` (ran, non-zero) is the code's fault and goes to a repair. `error` (could not start,
 * timed out) says nothing about the code, so no repair can answer it and a person must look.
 *
 * UI evidence (§15) applies only where a repository requires it: the caller passes `uiEvidence`
 * only then, so with the flag off this decides exactly as it did before. Where it applies, work
 * that would otherwise be accepted waits (`pending`) for before and after captures on the right
 * commits, and a capture that could not be taken keeps it pending with the reason, never accepted.
 *
 * Green checks on a head that never left its base say nothing about the task: the base was green
 * already. With no `ready` report saying nothing needed changing, and no brief allowing it, that is
 * no work done, and it goes to a repair (§10, §15). A commit that touches files outside the task's
 * owned paths is sent back the same way, naming them (§10: a task owns its paths).
 */
import { normalisePath } from './task-graph'
import {
  UI_EVIDENCE_FAILED,
  UI_EVIDENCE_WAITING,
  type UiEvidenceInput,
  uiEvidenceVerdict,
} from './ui-evidence'

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
  /** The commit the attempt started from; absent, no-change is not judged. */
  base?: string
  /** The brief says a no-change outcome is acceptable. */
  noChangeOk?: boolean
  /** The task's owned paths; empty or absent owns everything. */
  owned?: readonly string[]
  /** The files the attempt's commits changed against its base, as MEC read them. */
  changed?: readonly string[]
  /** Present only where the repository requires UI evidence (§14, §15). */
  uiEvidence?: UiEvidenceInput
}

export type RepairReason = 'checks_failed' | 'finding' | 'report_head' | 'no_change' | 'owned_paths'

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
      /** `owned_paths`: the changed files no owned path covers. */
      outside?: string[]
    }
  /** A person must act; `reason` says on what. */
  | { verdict: 'blocked'; reason: string }
  /** Nothing to decide yet. */
  | { verdict: 'pending'; reason: string }

const NO_VERDICT_YET = new Set(['queued', 'running', 'stalled', 'quota_wait', 'auth_required'])

const named = (names: readonly string[]): string => names.join(', ')

/** Is `file` one of `owned`, or under one of them? A root path owns everything. */
function ownedBy(file: string, owned: readonly string[]): boolean {
  const path = normalisePath(file)
  return owned.some((entry) => {
    const prefix = normalisePath(entry)
    return prefix === '' || path === prefix || path.startsWith(`${prefix}/`)
  })
}

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
  if (input.base === head && report?.kind !== 'ready' && input.noChangeOk !== true) {
    return { verdict: 'repair', reason: 'no_change', head, failing: [], findings: [] }
  }
  const owned = input.owned ?? []
  const outside = owned.length === 0 ? [] : (input.changed ?? []).filter((file) => !ownedBy(file, owned))
  if (outside.length > 0) {
    return { verdict: 'repair', reason: 'owned_paths', head, failing: [], findings: [], outside }
  }
  const findings = input.findings.filter((finding) => finding.sha === head).map((finding) => finding.text)
  if (findings.length > 0) return { verdict: 'repair', reason: 'finding', head, failing: [], findings }
  if (policy.sensitive && policy.reviewedSha !== head) return { verdict: 'review', head }
  if (input.uiEvidence !== undefined) {
    const shots = uiEvidenceVerdict(input.uiEvidence, head)
    if (shots.status === 'waiting') return { verdict: 'pending', reason: UI_EVIDENCE_WAITING }
    if (shots.status === 'could_not') {
      const reason = `${UI_EVIDENCE_FAILED}: Couldn't take the ${shots.side} screenshot: ${shots.reason}`
      return { verdict: 'pending', reason }
    }
  }
  return { verdict: 'accepted', head }
}
