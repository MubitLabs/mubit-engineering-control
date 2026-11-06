import type { ReportKind } from '@mec/contracts'

/**
 * Plan §6 turn model: the meta agent runs in event-driven turns — woken with a reason,
 * decides, stops. Inputs come in two classes:
 *
 * - **Wakes** start a turn: a user message (always), a specialist report `ready`,
 *   `blocked`, `failed` or `dropped`, a structured question, a confirmation resolved
 *   by someone else, work parked with no automatic resolution, an integration conflict
 *   that needs a plan change, a slot degraded that affects a live plan, a timer the
 *   meta agent asked for.
 * - **Notes** are appended to the next turn and never wake: `progress` and `waiting`
 *   reports, attempt starts, work parked with an automatic resolution, slot health
 *   changes without live-plan impact, settings or prompts saved, confirmations the
 *   meta agent itself initiated (it never receives a notice of its own action).
 *
 * `ignore` drops the event entirely: a timer the meta agent did not ask for, and any
 * kind this classifier does not know (default) — new event kinds fail quiet, not loud.
 */
export type CandidateEvent =
  | { kind: 'user_message'; message: { id: string; referencesWorkItem?: string } }
  | { kind: 'report'; workItemId: string; reportKind: ReportKind }
  | { kind: 'question'; workItemId: string }
  | { kind: 'confirmation_resolved'; confirmationId: string; selfInitiated: boolean }
  | { kind: 'work_parked'; workItemId: string; autoResolvable: boolean }
  | { kind: 'integration_conflict'; workItemId: string }
  | { kind: 'slot_degraded'; affectsLivePlan: boolean }
  | { kind: 'timer'; metaAgentAskedFor: boolean }
  | { kind: 'settings_saved' }
  | { kind: 'prompt_saved' }
  | { kind: 'attempt_started'; by: 'self' | 'other' }

/** Plan §10/§6: only these report kinds reach the meta agent as wakes; `progress` and `waiting` are notes. */
const WAKE_REPORT_KINDS = new Set<ReportKind>(['ready', 'blocked', 'failed', 'dropped'])

/**
 * §12.7: speak when the user must act or can use a result. A wake for one of these reasons, whose
 * turn plans nothing and asks nothing, has nothing to say: the report goes on the record, and a
 * specialist's question is already its own card (§12.6). `dropped` ends with no message (§10).
 */
const NARRATION_WAKES: ReadonlySet<string> = new Set([
  'report ready',
  'report dropped',
  'specialist question',
])

/** §12.7: these say a person must act, which is news once per block. */
const BLOCK_WAKES: ReadonlySet<string> = new Set(['report blocked', 'report failed', 'work parked'])

/**
 * Whether a wake's turn, having planned and asked nothing, has nothing new for the person. A wake
 * a person caused is always answered. `toldBlock` is the block the chat last spoke about; an
 * unknown reason speaks, because a lost word is worse than a spare one.
 */
export function wakeHasNoNews(
  reason: string,
  work: { state?: unknown; blockedReason?: unknown; toldBlock?: unknown },
): boolean {
  if (NARRATION_WAKES.has(reason)) return true
  return BLOCK_WAKES.has(reason) && work.state === 'blocked' && work.toldBlock === work.blockedReason
}

export function classifyWake(e: CandidateEvent): 'wake' | 'note' | 'ignore' {
  switch (e.kind) {
    case 'user_message':
      // A user message always wakes — chat is the primary source (§12).
      return 'wake'
    case 'report':
      return WAKE_REPORT_KINDS.has(e.reportKind) ? 'wake' : 'note'
    case 'question':
      return 'wake'
    case 'confirmation_resolved':
      // The meta agent never receives a notice of its own action (§6).
      return e.selfInitiated ? 'note' : 'wake'
    case 'work_parked':
      return e.autoResolvable ? 'note' : 'wake'
    case 'integration_conflict':
      return 'wake'
    case 'slot_degraded':
      return e.affectsLivePlan ? 'wake' : 'note'
    case 'timer':
      return e.metaAgentAskedFor ? 'wake' : 'ignore'
    case 'attempt_started':
      return 'note'
    case 'settings_saved':
      return 'note'
    case 'prompt_saved':
      return 'note'
    default:
      return 'ignore'
  }
}
