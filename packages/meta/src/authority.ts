/**
 * Who may run work (spec §10, §12.5, §13 invariant 4, decisions #20 and #21). Reads are pure
 * over a document; the writers run inside the caller's transaction, so a command and its event
 * commit together, and they work with no meta agent, because the owner must be able to stop
 * work with no meta slot configured.
 *
 * - **A stop is final.** Work leaves through the machine and its mandate is withdrawn in one
 *   write; nothing but a new admission follows.
 * - **A hold is the durable `doc.hold`.** Only the owner's lift command sets `liftedAt`.
 * - **Legacy rows** recorded only `{originMessageId}`, so their status derives from the work
 *   state and they skip the policy comparison: they recorded no hash to compare.
 * - **Pause** is one `settings/processing` doc; a restart reads it back.
 */
import type { Json, Store, StoreDoc } from '@mec/contracts'
import type { Mandate, WorkItemState } from '@mec/domain'
import {
  ATTEMPT_MACHINE,
  canTransition,
  revalidate,
  transition,
  WORK_ITEM_MACHINE,
  WORK_ITEM_TERMINAL,
  withdraw,
} from '@mec/domain'
import { isReadOnlyWork, repoOf } from './admission'

/** The hash a row with no recorded policy carries; it only ever compares equal to itself. */
const LEGACY_POLICY_HASH = ''

const PROCESSING_ID = 'settings/processing'

export type LaunchDropReason =
  | 'work_missing'
  | 'work_terminal'
  | 'mandate_withdrawn'
  | 'mandate_expired'
  | 'policy_changed'
  | 'repo_mismatch'
  | 'attempt_not_queued'

/** `no_runner`, or what a real launch reports: the attempt's stated reason, already redacted. */
export type LaunchFailureReason = string

/** What the launch gate decides: `defer` keeps the row, `drop` lets it drain unlaunched. */
export type LaunchAuthority =
  | { verdict: 'run' }
  | { verdict: 'defer'; reason: 'held' }
  | { verdict: 'drop'; reason: LaunchDropReason }

export type HoldOutcome = 'held' | 'missing' | 'terminal' | 'read_only'
export type StopOutcome = 'stopped' | 'missing' | 'done'
export type LiftOutcome =
  | { status: 'lifted'; launches: string[] }
  | { status: 'free' }
  | { status: 'missing' }
  | { status: 'refused'; error: string }

export type Processing = { paused: boolean; pausedAt?: string }

/** The work's mandate, whole even on a legacy row. A stopped item's is always withdrawn. */
export function mandateOf(doc: StoreDoc): Mandate {
  const stored = (doc.mandate ?? {}) as Partial<Mandate>
  return {
    id: stored.id ?? `mandate_${String(doc.id)}`,
    originMessageId:
      stored.originMessageId ?? (typeof doc.originMessageId === 'string' ? doc.originMessageId : ''),
    scope: stored.scope ?? '',
    policyHash: stored.policyHash ?? LEGACY_POLICY_HASH,
    budgetTurns: stored.budgetTurns ?? 0,
    expiresAt: stored.expiresAt ?? null,
    status: String(doc.state) === 'stopped' ? 'withdrawn' : (stored.status ?? 'active'),
  }
}

export function isHeld(doc: StoreDoc): boolean {
  const hold = doc.hold as { liftedAt?: string } | null | undefined
  return hold !== undefined && hold !== null && hold.liftedAt === undefined
}

export function isTerminal(doc: StoreDoc): boolean {
  return WORK_ITEM_TERMINAL.includes(String(doc.state) as WorkItemState)
}

/** §10's check before every resume; a legacy row has no hash to compare. */
export function revalidateWork(
  doc: StoreDoc,
  now: string,
  policyHash: string,
): ReturnType<typeof revalidate> {
  const mandate = mandateOf(doc)
  const hash = mandate.policyHash === LEGACY_POLICY_HASH ? LEGACY_POLICY_HASH : policyHash
  return revalidate(mandate, now, hash)
}

/**
 * The launch gate (§13, §20). A row may be late: `#replay` re-enqueues launch keys and a drained
 * row is deleted, so the attempt must still be queued. A policy change alone does not outrank a
 * hold: held work waits, and the lift reports the change.
 */
export function launchAuthority(
  store: Store,
  payload: Json,
  now: string,
  policyHash: string,
): LaunchAuthority {
  const { work_item_id: workItemId, attempt_id: attemptId, task_id: taskId } = launchFields(payload)
  const drop = (reason: LaunchDropReason): LaunchAuthority => ({ verdict: 'drop', reason })
  const work = store.workItems.get(workItemId)
  if (work === undefined) return drop('work_missing')
  if (isTerminal(work)) return drop('work_terminal')
  if (store.attempts.get(attemptId)?.state !== 'queued') return drop('attempt_not_queued')
  const repoId = repoOf(work)
  const pinned = (work.pin as { repoId?: string } | undefined)?.repoId
  if (repoId === undefined || pinned !== repoId || repoOf(store.tasks.get(taskId)) !== repoId) {
    return drop('repo_mismatch')
  }
  const authority = revalidateWork(work, now, policyHash)
  if (!authority.ok && authority.reason !== 'policy_changed') return drop(`mandate_${authority.reason}`)
  if (isHeld(work)) return { verdict: 'defer', reason: 'held' }
  return authority.ok ? { verdict: 'run' } : drop('policy_changed')
}

/**
 * Records a dropped launch. The mandates module lets work continue after a policy change only
 * once it revalidates clean, so that reason also blocks the work.
 */
export function refuseLaunch(store: Store, payload: Json, reason: LaunchDropReason, at: string): void {
  const { work_item_id: workItemId, attempt_id: attemptId } = launchFields(payload)
  appendEvent(store, `work:${workItemId}`, 'launch_refused', { workItemId, attemptId, reason, at }, at)
  if (reason === 'policy_changed') blockWork(store, workItemId, reason, at)
}

/**
 * A launch that cannot run says so (§17, decision #26): its attempt ends `failed` and its work
 * blocks with the reason. A second call changes nothing, because the queue retries the row.
 */
export function failLaunch(store: Store, payload: Json, reason: LaunchFailureReason, at: string): void {
  const { work_item_id: workItemId, attempt_id: attemptId } = launchFields(payload)
  const attempt = store.attempts.get(attemptId)
  if (attempt !== undefined && canTransition(ATTEMPT_MACHINE, String(attempt.state), 'attempt_failed')) {
    store.attempts.save({
      ...attempt,
      state: transition(ATTEMPT_MACHINE, String(attempt.state), 'attempt_failed'),
      terminal_reason: reason,
      updatedAt: at,
    })
    appendEvent(store, `attempt:${attemptId}`, 'attempt.failed', { attemptId, reason, at }, at)
  }
  blockWork(store, workItemId, reason, at)
}

/** Why this launch's attempt failed, when it did: the queue's retry of the row must keep failing. */
export function launchFailure(store: Store, payload: Json): string | undefined {
  const attempt = store.attempts.get(launchFields(payload).attempt_id)
  return attempt?.state === 'failed' ? String(attempt.terminal_reason) : undefined
}

/** The machine refuses a second block, so blocked work keeps its first reason. */
export function blockWork(store: Store, workItemId: string, reason: string, at: string): void {
  const work = store.workItems.get(workItemId)
  if (work === undefined || !canTransition(WORK_ITEM_MACHINE, String(work.state), 'block')) return
  store.workItems.save({
    ...work,
    state: transition(WORK_ITEM_MACHINE, String(work.state), 'block'),
    blockedReason: reason,
    updatedAt: at,
  })
  appendEvent(store, `work:${workItemId}`, 'work_blocked', { workItemId, reason, at }, at)
}

/** Records a hold; a second hold on held work keeps the first. Legacy rows take no hold (#36). */
export function holdWorkItem(
  store: Store,
  workItemId: string,
  input: { reason: string; sourceMessageId?: string; at: string },
): HoldOutcome {
  const doc = store.workItems.get(workItemId)
  if (doc === undefined) return 'missing'
  if (isTerminal(doc)) return 'terminal'
  if (isReadOnlyWork(doc, store.tasks.list({ workItemId }))) return 'read_only'
  if (isHeld(doc)) return 'held'
  const { reason, sourceMessageId, at } = input
  const hold = { reason, at, ...(sourceMessageId !== undefined && { sourceMessageId }) }
  store.workItems.save({ ...doc, hold, updatedAt: at })
  appendEvent(store, `work:${workItemId}`, 'work_held', { workItemId, ...hold }, at)
  return 'held'
}

/** Marks the hold lifted, keeping it as the record. The caller has revalidated. */
export function liftHoldRecord(store: Store, doc: StoreDoc, at: string): void {
  const workItemId = String(doc.id)
  store.workItems.save({ ...doc, hold: { ...(doc.hold as object), liftedAt: at }, updatedAt: at })
  appendEvent(store, `work:${workItemId}`, 'hold_lifted', { workItemId, at }, at)
}

/**
 * The one way work stops: the machine moves it, the mandate is withdrawn in the same write,
 * queued attempts are interrupted at once and running ones are asked to. Stopping stopped work
 * writes nothing.
 */
export function stopWorkItem(
  store: Store,
  workItemId: string,
  input: { reason: string; messageId?: string; at: string },
): StopOutcome {
  const doc = store.workItems.get(workItemId)
  if (doc === undefined) return 'missing'
  const state = String(doc.state)
  if (state === 'stopped') return 'stopped'
  if (!canTransition(WORK_ITEM_MACHINE, state, 'stop')) return 'done'
  const { reason, messageId, at } = input
  const { mandate, events } = withdraw(mandateOf(doc), at)
  store.workItems.save({
    ...doc,
    state: transition(WORK_ITEM_MACHINE, state, 'stop'),
    mandate: mandate as unknown as Json,
    updatedAt: at,
  })
  appendEvent(
    store,
    `work:${workItemId}`,
    'work_stopped',
    { workItemId, ...(messageId !== undefined && { messageId }), reason, mandate: events, at },
    at,
  )
  interruptAttempts(store, workItemId, at)
  return 'stopped'
}

/** The kill is the runner's; here the request is recorded for it to act on (§8.1). */
function interruptAttempts(store: Store, workItemId: string, at: string): void {
  for (const attempt of store.attempts.list({ workItemId })) {
    const attemptId = String(attempt.id)
    const state = String(attempt.state)
    if (state === 'queued') {
      const interrupted = transition(ATTEMPT_MACHINE, state, 'interrupt_confirmed')
      store.attempts.save({ ...attempt, state: interrupted, updatedAt: at })
      appendEvent(store, `attempt:${attemptId}`, 'attempt.interrupted', { attemptId, at }, at)
    } else if (state === 'running' || state === 'work_complete') {
      // `work_complete` may be running the repo's checks, which a stop ends as well.
      appendEvent(store, `attempt:${attemptId}`, 'attempt.interrupt_requested', { attemptId, at }, at)
    }
  }
}

export function processingOf(store: Store): Processing {
  const doc = store.engines.get(PROCESSING_ID)
  if (doc?.paused !== true) return { paused: false }
  return { paused: true, ...(typeof doc.pausedAt === 'string' && { pausedAt: doc.pausedAt }) }
}

export function saveProcessing(store: Store, processing: Processing, at: string): void {
  store.engines.save({ id: PROCESSING_ID, ...processing, updatedAt: at })
}

function launchFields(payload: Json): { work_item_id: string; attempt_id: string; task_id: string } {
  const fields = (payload ?? {}) as Record<string, unknown>
  const text = (name: string): string => (typeof fields[name] === 'string' ? (fields[name] as string) : '')
  return {
    work_item_id: text('work_item_id'),
    attempt_id: text('attempt_id'),
    task_id: text('task_id'),
  }
}

function appendEvent(store: Store, stream: string, type: string, body: Json, at: string): void {
  const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
  store.events.append(stream, { stream, seq, at, type, body })
}
