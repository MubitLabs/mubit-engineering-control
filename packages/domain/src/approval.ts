import { err, ok, type Result } from './machine'
import type { ApprovalEvent, ApprovalKind, ApprovalState } from './states'

/**
 * Approval integrity, PDF §13. The database performs the compare-and-set; this module decides
 * whether a given answer is admissible and which state it produces.
 */

export interface ApprovalView {
  kind: ApprovalKind
  status: ApprovalState
  allowedDeciderIds: readonly string[]
  expiresAt: Date | null
  /** Hash of the exact input the approval is bound to: command, plan revision text, or SHA. */
  bindingHash: string
}

export type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'reject'; reason?: string }
  | { kind: 'answer'; answer: string }

export type ResolveError =
  | { code: 'not_pending'; status: ApprovalState }
  | { code: 'expired' }
  | { code: 'not_authorised' }
  | { code: 'stale_binding' }
  | { code: 'invalid_decision'; message: string }

const DECISIONS_BY_KIND: Record<ApprovalKind, ApprovalDecision['kind'][]> = {
  plan: ['approve', 'reject'],
  tool: ['approve', 'reject'],
  question: ['answer', 'reject'],
  result: ['approve', 'reject'],
  merge: ['approve', 'reject'],
}

const EVENT_FOR_DECISION: Record<ApprovalDecision['kind'], ApprovalEvent> = {
  approve: 'approve',
  reject: 'reject',
  answer: 'answer',
}

export function decisionEvent(decision: ApprovalDecision): ApprovalEvent {
  return EVENT_FOR_DECISION[decision.kind]
}

export function resolvedState(decision: ApprovalDecision): ApprovalState {
  return decision.kind === 'approve' ? 'approved' : decision.kind === 'reject' ? 'rejected' : 'answered'
}

/**
 * An expired request is never treated as consent, a changed input makes the approval stale, and
 * only a listed decider may answer.
 */
export function checkResolution(
  approval: ApprovalView,
  input: { deciderId: string; decision: ApprovalDecision; now: Date; currentBindingHash: string },
): Result<ApprovalState, ResolveError> {
  if (approval.status !== 'pending') return err({ code: 'not_pending', status: approval.status })
  if (approval.expiresAt !== null && input.now.getTime() >= approval.expiresAt.getTime()) {
    return err({ code: 'expired' })
  }
  if (!approval.allowedDeciderIds.includes(input.deciderId)) return err({ code: 'not_authorised' })
  if (approval.bindingHash !== input.currentBindingHash) return err({ code: 'stale_binding' })
  if (!DECISIONS_BY_KIND[approval.kind].includes(input.decision.kind)) {
    return err({
      code: 'invalid_decision',
      message: `A ${approval.kind} approval accepts ${DECISIONS_BY_KIND[approval.kind].join(' or ')}`,
    })
  }
  if (input.decision.kind === 'answer' && input.decision.answer.trim() === '') {
    return err({ code: 'invalid_decision', message: 'An answer cannot be empty' })
  }
  return ok(resolvedState(input.decision))
}
