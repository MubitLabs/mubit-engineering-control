/**
 * Bounded repair and review, spec §11 and §15. What a finished attempt's task does next when it is
 * not accepted: another attempt in the same worktree with exact evidence, or one reviewer, up to
 * the cap, and then a block that says what remains. A task never loops. The counts come from the
 * attempts on record and from `round` in reports, so a later attempt continues them, and one
 * counter covers a task and the repair tasks opened for it (decision #36).
 */
import type { StoreDoc } from '@mec/contracts'
import type { Acceptance, Caps } from '@mec/domain'

/** What a queued attempt continues. Stored on the task until a pass places it, then on the attempt. */
export type Continuation = {
  /** `handoff` is a slot switch (§5.10): the task's own role, on a slot it did not start on. */
  kind: 'repair' | 'review' | 'handoff'
  role: string
  /** Exact evidence for the brief: failing check, log tail, SHA, or the finding. */
  evidence: string
  /** Review round this attempt is, counted across attempts. */
  round: number
  worktree?: string
  branch?: string
  /** `owner`: the owner's Try again asked for this attempt, past the automatic cap. */
  origin?: 'owner'
}

export type RepairLedger = { repairs: number; rounds: number }

const kindOf = (attempt: StoreDoc): unknown => (attempt.continuation as { kind?: unknown } | undefined)?.kind

export function repairLedger(attempts: readonly StoreDoc[], reports: readonly StoreDoc[]): RepairLedger {
  const reported = reports.map((doc) => {
    const count = (doc.report as { round?: { count?: unknown } } | undefined)?.round?.count
    return typeof count === 'number' ? count : 0
  })
  return {
    repairs: attempts.filter((attempt) => kindOf(attempt) === 'repair').length,
    rounds: Math.max(0, attempts.filter((attempt) => kindOf(attempt) === 'review').length, ...reported),
  }
}

/** Keeps what a repair needs and no more of a log. */
const TAIL_CHARS = 2000

/** A verdict on a task's head, or evidence the integration controller already wrote. */
type RepairVerdict =
  | Extract<Acceptance, { verdict: 'repair' }>
  | { verdict: 'repair'; reason: 'integration'; evidence: string }

/** The evidence a repair starts from. The log tails were redacted before they were stored. */
export function repairEvidence(decided: RepairVerdict, claimedHead?: string): string {
  if (decided.reason === 'integration') return decided.evidence
  const { head, reason } = decided
  if (reason === 'report_head') {
    return `Your ready report named ${claimedHead ?? 'no commit'}, but the head is ${head}.`
  }
  if (reason === 'no_change') {
    return [
      `The attempt ended on ${head}, its base, with no change and no ready report, so the task is not done.`,
      'Make the change the objective asks for. If nothing needs changing, report ready on this head and',
      'say why; if you cannot proceed, report blocked with what a person must do.',
    ].join(' ')
  }
  if (reason === 'owned_paths') {
    const outside = decided.outside ?? []
    return [
      `The commit ${head} changes files outside this task's owned paths: ${outside.join(', ')}.`,
      'Another task may own them. Undo those changes and keep to the owned paths.',
    ].join(' ')
  }
  const failed = decided.failing.map(
    (check) => `Check ${check.name} failed on ${head}:\n${check.logTail.slice(-TAIL_CHARS)}`,
  )
  const found = decided.findings.map((finding) => `Finding on ${head}: ${finding}`)
  return [...failed, ...found].join('\n\n')
}

/** The next repair, or the block that ends them with what remains. */
export function nextRepair(
  decided: RepairVerdict,
  ledger: RepairLedger,
  caps: Caps,
  target: { worktree?: string; branch?: string; claimedHead?: string },
): { block: string } | { next: Continuation } {
  const evidence = repairEvidence(decided, target.claimedHead)
  if (ledger.repairs >= caps.repairAttemptsPerTask) {
    const cap = caps.repairAttemptsPerTask
    return { block: `repairs used up (${ledger.repairs} of ${cap}). What remains:\n${evidence}` }
  }
  return {
    next: {
      kind: 'repair',
      role: 'repair_agent',
      evidence,
      round: ledger.rounds,
      ...(target.worktree !== undefined && { worktree: target.worktree }),
      ...(target.branch !== undefined && { branch: target.branch }),
    },
  }
}

/** The next reviewer, or the block when the rounds are spent (§15). */
export function nextReview(
  head: string,
  ledger: RepairLedger,
  caps: Caps,
  target: { worktree?: string; branch?: string },
): { block: string } | { next: Continuation } {
  if (ledger.rounds >= caps.reviewRoundsPerTask) {
    const cap = caps.reviewRoundsPerTask
    return { block: `review rounds used up (${ledger.rounds} of ${cap}) with no accepted review of ${head}` }
  }
  return {
    next: {
      kind: 'review',
      role: 'code_reviewer',
      evidence: `Review the commit ${head}. Bind every finding to it.`,
      round: ledger.rounds + 1,
      ...(target.worktree !== undefined && { worktree: target.worktree }),
      ...(target.branch !== undefined && { branch: target.branch }),
    },
  }
}
