/**
 * Lifecycle state machines, plan §10 (ported from v1's states.ts/machine.ts).
 *
 * Each machine is an explicit transition table: a readonly array of { from, event, to } rows.
 * Anything not in the table is rejected — adding a state never silently permits a transition.
 * A state says where something is; why it waits is a blocker, recorded separately (blockers.ts).
 */

export type Transition<S extends string = string, E extends string = string> = {
  readonly from: S
  readonly event: E
  readonly to: S
}

export type TransitionTable<S extends string = string, E extends string = string> = readonly Transition<
  S,
  E
>[]

export function canTransition(table: TransitionTable, from: string, event: string): boolean {
  return table.some((row) => row.from === from && row.event === event)
}

export function transition(table: TransitionTable, from: string, event: string): string {
  const row = table.find((t) => t.from === from && t.event === event)
  if (row === undefined) {
    throw new Error(`Invalid transition: cannot apply '${event}' in state '${from}'`)
  }
  return row.to
}

// ── Work item ───────────────────────────────────────────────────────────────────────────────
// proposed → admitted → planning → executing → reviewing → integrating → done (plan §10).
// `blocked` carries a reason (a person must act); blocking forgets the stage on purpose, so
// resuming names the stage explicitly and the machine stays a pure table. `stopped` is the
// user's stop: nothing resumes it without a new admission (§12), hence terminal.
export const WORK_ITEM_STATES = [
  'proposed',
  'admitted',
  'planning',
  'executing',
  'reviewing',
  'integrating',
  'done',
  'blocked',
  'stopped',
] as const
export type WorkItemState = (typeof WORK_ITEM_STATES)[number]

export const WORK_ITEM_EVENTS = [
  'admit',
  'planning_started',
  'execution_started',
  'review_started',
  'integration_started',
  'work_done',
  'block',
  'resume_planning',
  'resume_executing',
  'resume_reviewing',
  'resume_integrating',
  'stop',
] as const
export type WorkItemEvent = (typeof WORK_ITEM_EVENTS)[number]

export const WORK_ITEM_TERMINAL: readonly WorkItemState[] = ['done', 'stopped']

export const WORK_ITEM_MACHINE: TransitionTable<WorkItemState, WorkItemEvent> = [
  { from: 'proposed', event: 'admit', to: 'admitted' },
  { from: 'proposed', event: 'stop', to: 'stopped' },
  { from: 'admitted', event: 'planning_started', to: 'planning' },
  { from: 'admitted', event: 'stop', to: 'stopped' },
  { from: 'planning', event: 'execution_started', to: 'executing' },
  { from: 'planning', event: 'block', to: 'blocked' },
  { from: 'planning', event: 'stop', to: 'stopped' },
  { from: 'executing', event: 'review_started', to: 'reviewing' },
  { from: 'executing', event: 'block', to: 'blocked' },
  { from: 'executing', event: 'stop', to: 'stopped' },
  { from: 'reviewing', event: 'integration_started', to: 'integrating' },
  { from: 'reviewing', event: 'block', to: 'blocked' },
  { from: 'reviewing', event: 'stop', to: 'stopped' },
  { from: 'integrating', event: 'work_done', to: 'done' },
  { from: 'integrating', event: 'block', to: 'blocked' },
  { from: 'integrating', event: 'stop', to: 'stopped' },
  { from: 'blocked', event: 'resume_planning', to: 'planning' },
  { from: 'blocked', event: 'resume_executing', to: 'executing' },
  { from: 'blocked', event: 'resume_reviewing', to: 'reviewing' },
  { from: 'blocked', event: 'resume_integrating', to: 'integrating' },
  { from: 'blocked', event: 'stop', to: 'stopped' },
]

// ── Task ────────────────────────────────────────────────────────────────────────────────────
// ready → active → awaiting_review → accepted → integrated (plan §10). `blocked` records
// dependency/capacity/confirmation waits; `cancel` is the only exit besides the progression.
// `work_complete` is attempt-level: here the attempt stopped and review may begin. A failed
// attempt returns the task to ready for another bounded try (maxAttempts, repair caps in §11);
// an accepted task that hits a merge conflict goes back to ready for mid-merge repair (§14).
export const TASK_STATES = [
  'ready',
  'active',
  'awaiting_review',
  'accepted',
  'integrated',
  'cancelled',
  'blocked',
] as const
export type TaskState = (typeof TASK_STATES)[number]

export const TASK_EVENTS = [
  'attempt_started',
  'work_complete',
  'attempt_failed',
  'review_accepted',
  'review_sent_back',
  'integrated',
  'integration_conflict',
  'block',
  'unblock',
  'cancel',
] as const
export type TaskEvent = (typeof TASK_EVENTS)[number]

export const TASK_TERMINAL: readonly TaskState[] = ['integrated', 'cancelled']

export const TASK_MACHINE: TransitionTable<TaskState, TaskEvent> = [
  { from: 'ready', event: 'attempt_started', to: 'active' },
  { from: 'ready', event: 'block', to: 'blocked' },
  { from: 'ready', event: 'cancel', to: 'cancelled' },
  { from: 'active', event: 'work_complete', to: 'awaiting_review' },
  { from: 'active', event: 'attempt_failed', to: 'ready' },
  { from: 'active', event: 'block', to: 'blocked' },
  { from: 'active', event: 'cancel', to: 'cancelled' },
  { from: 'awaiting_review', event: 'review_accepted', to: 'accepted' },
  { from: 'awaiting_review', event: 'review_sent_back', to: 'ready' },
  { from: 'awaiting_review', event: 'block', to: 'blocked' },
  { from: 'awaiting_review', event: 'cancel', to: 'cancelled' },
  { from: 'accepted', event: 'integrated', to: 'integrated' },
  { from: 'accepted', event: 'integration_conflict', to: 'ready' },
  { from: 'accepted', event: 'block', to: 'blocked' },
  { from: 'accepted', event: 'cancel', to: 'cancelled' },
  { from: 'blocked', event: 'unblock', to: 'ready' },
  { from: 'blocked', event: 'cancel', to: 'cancelled' },
]

// ── Attempt ─────────────────────────────────────────────────────────────────────────────────
// queued → running → work_complete → succeeded / checks_failed (plan §10). `work_complete`
// only means the agent stopped; checks decide the outcome. Parked states preserve the
// workspace and release the slot, then resume in place (§11). A stalled attempt (process
// died, journal silent) is reconciled before any replacement starts; reconciliation either
// finds it alive (back to running) or dead (interrupted, from which it resumes).
export const ATTEMPT_STATES = [
  'queued',
  'running',
  'work_complete',
  'succeeded',
  'checks_failed',
  'quota_wait',
  'auth_required',
  'provider_down',
  'interrupted',
  'stalled',
] as const
export type AttemptState = (typeof ATTEMPT_STATES)[number]

export const ATTEMPT_EVENTS = [
  'agent_started',
  'agent_finished',
  'checks_passed',
  'checks_failed',
  'quota_exhausted',
  'auth_expired',
  'provider_unreachable',
  'interrupt_confirmed',
  'stall_detected',
  'resume',
  'reconciled_running',
  'reconciled_stopped',
] as const
export type AttemptEvent = (typeof ATTEMPT_EVENTS)[number]

export const ATTEMPT_TERMINAL: readonly AttemptState[] = ['succeeded', 'checks_failed']

export const ATTEMPT_MACHINE: TransitionTable<AttemptState, AttemptEvent> = [
  { from: 'queued', event: 'agent_started', to: 'running' },
  { from: 'queued', event: 'interrupt_confirmed', to: 'interrupted' },
  { from: 'running', event: 'agent_finished', to: 'work_complete' },
  { from: 'running', event: 'quota_exhausted', to: 'quota_wait' },
  { from: 'running', event: 'auth_expired', to: 'auth_required' },
  { from: 'running', event: 'provider_unreachable', to: 'provider_down' },
  { from: 'running', event: 'interrupt_confirmed', to: 'interrupted' },
  { from: 'running', event: 'stall_detected', to: 'stalled' },
  { from: 'work_complete', event: 'checks_passed', to: 'succeeded' },
  { from: 'work_complete', event: 'checks_failed', to: 'checks_failed' },
  { from: 'quota_wait', event: 'resume', to: 'running' },
  { from: 'auth_required', event: 'resume', to: 'running' },
  { from: 'provider_down', event: 'resume', to: 'running' },
  { from: 'interrupted', event: 'resume', to: 'running' },
  { from: 'stalled', event: 'reconciled_running', to: 'running' },
  { from: 'stalled', event: 'reconciled_stopped', to: 'interrupted' },
]

/** Attempt states that may own a live process and occupy scheduler capacity (§11). */
export const ACTIVE_ATTEMPT_STATES: readonly AttemptState[] = ['running', 'work_complete', 'stalled']

/** Parked states: the workspace is preserved but the slot is released (§11). */
export const PARKED_ATTEMPT_STATES: readonly AttemptState[] = [
  'quota_wait',
  'auth_required',
  'provider_down',
  'interrupted',
]

// ── Confirmation ────────────────────────────────────────────────────────────────────────────
// pending → approved / denied, with expiry and staleness (plan §13). Resolution is
// compare-and-set (the first answer wins), expiry is never consent, and changed input makes
// the earlier decision stale — hence `invalidate`. All four resolutions are terminal.
export const CONFIRMATION_STATES = ['pending', 'approved', 'denied', 'expired', 'stale'] as const
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number]

export const CONFIRMATION_EVENTS = ['approve', 'deny', 'expire', 'invalidate'] as const
export type ConfirmationEvent = (typeof CONFIRMATION_EVENTS)[number]

export const CONFIRMATION_TERMINAL: readonly ConfirmationState[] = ['approved', 'denied', 'expired', 'stale']

export const CONFIRMATION_MACHINE: TransitionTable<ConfirmationState, ConfirmationEvent> = [
  { from: 'pending', event: 'approve', to: 'approved' },
  { from: 'pending', event: 'deny', to: 'denied' },
  { from: 'pending', event: 'expire', to: 'expired' },
  { from: 'pending', event: 'invalidate', to: 'stale' },
]
