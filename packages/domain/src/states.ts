import { defineMachine } from './machine'

/**
 * Lifecycle state machines from PDF §11. Each object has a "normal progression" plus side states.
 * Blockers (why something is not progressing) are recorded separately, see blockers.ts.
 */

// ── Delivery ────────────────────────────────────────────────────────────────────────────────
export const DELIVERY_STATES = [
  'planning',
  'approved',
  'executing',
  'integrating',
  'awaiting_merge',
  'merged',
  'cancelled',
] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

export const DELIVERY_EVENTS = [
  'plan_approved',
  'work_started',
  'plan_revised',
  'integration_started',
  'integration_reopened',
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'cancel',
] as const
export type DeliveryEvent = (typeof DELIVERY_EVENTS)[number]

export const deliveryMachine = defineMachine<DeliveryState, DeliveryEvent>({
  name: 'delivery',
  states: DELIVERY_STATES,
  events: DELIVERY_EVENTS,
  terminal: ['merged', 'cancelled'],
  table: {
    planning: { plan_approved: 'approved', cancel: 'cancelled' },
    approved: { work_started: 'executing', plan_revised: 'planning', cancel: 'cancelled' },
    executing: { integration_started: 'integrating', plan_revised: 'planning', cancel: 'cancelled' },
    integrating: { pr_opened: 'awaiting_merge', integration_reopened: 'executing', cancel: 'cancelled' },
    awaiting_merge: { pr_merged: 'merged', pr_closed: 'integrating', cancel: 'cancelled' },
    merged: {},
    cancelled: {},
  },
})

// ── Plan revision ───────────────────────────────────────────────────────────────────────────
// An approved revision is immutable; edits create a new revision that supersedes it.
export const PLAN_REVISION_STATES = ['draft', 'proposed', 'approved', 'rejected', 'superseded'] as const
export type PlanRevisionState = (typeof PLAN_REVISION_STATES)[number]

export const PLAN_REVISION_EVENTS = ['submit', 'edit', 'approve', 'reject', 'supersede'] as const
export type PlanRevisionEvent = (typeof PLAN_REVISION_EVENTS)[number]

export const planRevisionMachine = defineMachine<PlanRevisionState, PlanRevisionEvent>({
  name: 'plan_revision',
  states: PLAN_REVISION_STATES,
  events: PLAN_REVISION_EVENTS,
  terminal: ['rejected', 'superseded'],
  table: {
    draft: { edit: 'draft', submit: 'proposed', supersede: 'superseded' },
    proposed: { edit: 'draft', approve: 'approved', reject: 'rejected', supersede: 'superseded' },
    approved: { supersede: 'superseded' },
    rejected: {},
    superseded: {},
  },
})

// ── Task ────────────────────────────────────────────────────────────────────────────────────
export const TASK_STATES = [
  'proposed',
  'approved',
  'ready',
  'active',
  'awaiting_review',
  'accepted',
  'integrated',
  'failed',
  'cancelled',
] as const
export type TaskState = (typeof TASK_STATES)[number]

export const TASK_EVENTS = [
  'plan_approved',
  'dependencies_satisfied',
  'dependencies_reopened',
  'attempt_started',
  'attempt_succeeded',
  'attempt_failed_retryable',
  'attempt_failed_final',
  'review_accepted',
  'review_sent_back',
  'integrated',
  'integration_conflict',
  'retry',
  'cancel',
] as const
export type TaskEvent = (typeof TASK_EVENTS)[number]

export const taskMachine = defineMachine<TaskState, TaskEvent>({
  name: 'task',
  states: TASK_STATES,
  events: TASK_EVENTS,
  terminal: ['integrated', 'cancelled'],
  table: {
    proposed: { plan_approved: 'approved', cancel: 'cancelled' },
    approved: { dependencies_satisfied: 'ready', cancel: 'cancelled' },
    ready: { attempt_started: 'active', dependencies_reopened: 'approved', cancel: 'cancelled' },
    active: {
      attempt_succeeded: 'awaiting_review',
      attempt_failed_retryable: 'ready',
      attempt_failed_final: 'failed',
      cancel: 'cancelled',
    },
    awaiting_review: { review_accepted: 'accepted', review_sent_back: 'ready', cancel: 'cancelled' },
    // A merge conflict sends the task back for a bounded repair attempt on the integration SHA.
    accepted: { integrated: 'integrated', integration_conflict: 'ready', cancel: 'cancelled' },
    integrated: {},
    failed: { retry: 'ready', cancel: 'cancelled' },
    cancelled: {},
  },
})

// ── Attempt ─────────────────────────────────────────────────────────────────────────────────
// work_complete means the agent stopped; only checks + review can make the task accepted (§11).
export const ATTEMPT_STATES = [
  'queued',
  'leased',
  'preparing',
  'running',
  'awaiting_input',
  'work_complete',
  'checking',
  'succeeded',
  'checks_failed',
  'interrupted',
  'quota_wait',
  'auth_required',
  'stalled',
  'failed',
  'cancelled',
] as const
export type AttemptState = (typeof ATTEMPT_STATES)[number]

export const ATTEMPT_EVENTS = [
  'lease_granted',
  'runner_accepted',
  'agent_started',
  'input_requested',
  'input_resolved',
  'agent_finished',
  'checks_started',
  'checks_passed',
  'checks_failed',
  'interrupt_confirmed',
  'quota_exhausted',
  'auth_expired',
  'resume',
  'lease_expired',
  'runner_reconciled_running',
  'runner_reconciled_stopped',
  'error',
  'cancel',
] as const
export type AttemptEvent = (typeof ATTEMPT_EVENTS)[number]

const RUNNING_SIDE_EXITS = {
  interrupt_confirmed: 'interrupted',
  quota_exhausted: 'quota_wait',
  auth_expired: 'auth_required',
  lease_expired: 'stalled',
  error: 'failed',
  cancel: 'cancelled',
} as const

export const attemptMachine = defineMachine<AttemptState, AttemptEvent>({
  name: 'attempt',
  states: ATTEMPT_STATES,
  events: ATTEMPT_EVENTS,
  terminal: ['succeeded', 'checks_failed', 'failed', 'cancelled'],
  table: {
    queued: { lease_granted: 'leased', cancel: 'cancelled' },
    leased: { runner_accepted: 'preparing', lease_expired: 'stalled', error: 'failed', cancel: 'cancelled' },
    preparing: { agent_started: 'running', ...RUNNING_SIDE_EXITS },
    running: { input_requested: 'awaiting_input', agent_finished: 'work_complete', ...RUNNING_SIDE_EXITS },
    awaiting_input: { input_resolved: 'running', ...RUNNING_SIDE_EXITS },
    work_complete: {
      checks_started: 'checking',
      lease_expired: 'stalled',
      error: 'failed',
      cancel: 'cancelled',
    },
    checking: {
      checks_passed: 'succeeded',
      checks_failed: 'checks_failed',
      lease_expired: 'stalled',
      error: 'failed',
      cancel: 'cancelled',
    },
    // Paused states preserve the workspace and resume under a new lease generation.
    interrupted: { resume: 'leased', cancel: 'cancelled' },
    quota_wait: { resume: 'leased', cancel: 'cancelled' },
    auth_required: { resume: 'leased', cancel: 'cancelled' },
    // Lease expiry alone does not prove the process is dead; reconcile before any replacement.
    stalled: {
      runner_reconciled_running: 'running',
      runner_reconciled_stopped: 'interrupted',
      cancel: 'cancelled',
    },
    succeeded: {},
    checks_failed: {},
    failed: {},
    cancelled: {},
  },
})

/** States in which an attempt occupies a scheduler slot and may own a live process. */
export const ACTIVE_ATTEMPT_STATES: readonly AttemptState[] = [
  'leased',
  'preparing',
  'running',
  'awaiting_input',
  'work_complete',
  'checking',
  'stalled',
]

/** States that keep the workspace for a later resume but release capacity. */
export const PARKED_ATTEMPT_STATES: readonly AttemptState[] = ['interrupted', 'quota_wait', 'auth_required']

// ── Approval ────────────────────────────────────────────────────────────────────────────────
export const APPROVAL_KINDS = ['plan', 'tool', 'question', 'result', 'merge'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'answered', 'expired', 'stale'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export const APPROVAL_EVENTS = ['approve', 'reject', 'answer', 'expire', 'invalidate'] as const
export type ApprovalEvent = (typeof APPROVAL_EVENTS)[number]

export const approvalMachine = defineMachine<ApprovalState, ApprovalEvent>({
  name: 'approval',
  states: APPROVAL_STATES,
  events: APPROVAL_EVENTS,
  terminal: ['approved', 'rejected', 'answered', 'expired', 'stale'],
  table: {
    pending: {
      approve: 'approved',
      reject: 'rejected',
      answer: 'answered',
      expire: 'expired',
      invalidate: 'stale',
    },
    approved: {},
    rejected: {},
    answered: {},
    expired: {},
    stale: {},
  },
})
