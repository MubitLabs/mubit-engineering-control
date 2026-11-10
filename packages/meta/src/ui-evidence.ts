/**
 * UI evidence from the store (spec §14, §15): what the scheduler's acceptance reads, what a stage
 * and the planner's context say, and the owner's retry of a capture that could not be taken.
 *
 * - **The record is `ui-evidence/<attempt>`**, written only by MEC's capture service. Its `state`
 *   is `taking`, `taken`, `could_not` or `requested` (a retry asked for), and `before` / `after`
 *   each bind the commit they show. An engine has no tool that writes it.
 * - **The attempt is the one that did the work.** A reviewer reads and changes nothing, so a task
 *   whose latest attempt is a review is judged on the captures of the work attempt with its head.
 * - **The flag is read at every judgement.** It is not part of the profile a work item is pinned
 *   to, so turning it on or off invalidates nothing in flight (§14, `repo_profile_changed`).
 */
import type { Json, Store, StoreDoc } from '@mec/contracts'
import {
  type ScreenshotWait,
  UI_EVIDENCE_FAILED,
  UI_EVIDENCE_WAITING,
  type UiEvidenceInput,
  type UiShot,
  type UiSide,
  uiEvidenceSetting,
  uiEvidenceVerdict,
  userVisible,
} from '@mec/domain'
import { isHeld, isTerminal, mandateOf } from './authority'
import { taskAcceptance } from './scheduler'

export const UI_EVIDENCE_PREFIX = 'ui-evidence/'
export const evidenceDocId = (attemptId: string): string => `${UI_EVIDENCE_PREFIX}${attemptId}`

const kindOf = (attempt: StoreDoc): unknown => (attempt.continuation as { kind?: unknown } | undefined)?.kind

const attemptOrder = (doc: StoreDoc): number => Number(/^att_(\d+)$/.exec(String(doc.id))?.[1] ?? 0)
const newest = (docs: readonly StoreDoc[]): StoreDoc | undefined =>
  [...docs]
    .sort(
      (a, b) =>
        String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
        attemptOrder(a) - attemptOrder(b),
    )
    .at(-1)

/** The attempt whose commits the captures must show: the latest, or under a review the work it read. */
export function evidenceAttempt(attempts: readonly StoreDoc[], latest: StoreDoc): StoreDoc {
  if (kindOf(latest) !== 'review') return latest
  const work = attempts.filter((doc) => kindOf(doc) !== 'review' && doc.head_sha === latest.head_sha)
  return newest(work) ?? latest
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

function sideOf(raw: unknown): UiSide | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const side = raw as { sha?: unknown; status?: unknown; reason?: unknown; shots?: unknown }
  if (typeof side.sha !== 'string') return undefined
  if (side.status === 'could_not') {
    return { sha: side.sha, status: 'could_not', reason: String(side.reason ?? 'no reason recorded') }
  }
  if (side.status !== 'captured' || !Array.isArray(side.shots)) return undefined
  return { sha: side.sha, status: 'captured', shots: side.shots as UiShot[] }
}

/** The captures a record holds. A retry asked for holds none: they are being taken again. */
export function capturesOf(doc: StoreDoc | undefined): UiEvidenceInput['captures'] {
  if (doc === undefined || doc.state === 'requested') return {}
  const before = sideOf(doc.before)
  const after = sideOf(doc.after)
  return { ...(before !== undefined && { before }), ...(after !== undefined && { after }) }
}

/**
 * The acceptance input for a task, or undefined where its repository does not require UI evidence:
 * then acceptance decides exactly as it always has.
 */
export function uiEvidenceInput(
  store: Store,
  task: StoreDoc,
  attempts: readonly StoreDoc[],
  latest: StoreDoc,
): UiEvidenceInput | undefined {
  const setting = uiEvidenceSetting(store.engines.get(String(task.repoId))?.uiEvidence)
  if (!setting.required) return undefined
  const work = evidenceAttempt(attempts, latest)
  return {
    userVisible: userVisible(strings(work.changed_paths), setting.patterns),
    ...(typeof work.base_sha === 'string' && { base: work.base_sha }),
    captures: capturesOf(store.engines.get(evidenceDocId(String(work.id)))),
  }
}

/** A task acceptance holds back for its screenshots, with the attempt whose commits they show. */
export type ScreenshotDue = {
  task: StoreDoc
  attempt: StoreDoc
  state: 'waiting' | 'could_not'
  side?: 'before' | 'after'
  reason?: string
}

/** Every task of a work item the scheduler's acceptance holds back for UI evidence. */
export function screenshotsDue(store: Store, workItemId: string): ScreenshotDue[] {
  return store.tasks.list({ workItemId }).flatMap((task): ScreenshotDue[] => {
    const decided = taskAcceptance(store, task)
    if (decided?.verdict !== 'pending') return []
    const waiting = decided.reason === UI_EVIDENCE_WAITING
    if (!waiting && !decided.reason.startsWith(`${UI_EVIDENCE_FAILED}:`)) return []
    const attempts = store.attempts.list({ taskId: task.id })
    const latest = newest(attempts) as StoreDoc
    const attempt = evidenceAttempt(attempts, latest)
    if (waiting) return [{ task, attempt, state: 'waiting' }]
    const input = uiEvidenceInput(store, task, attempts, latest) as UiEvidenceInput
    const verdict = uiEvidenceVerdict(input, String(attempt.head_sha))
    if (verdict.status !== 'could_not') return []
    return [{ task, attempt, state: 'could_not', side: verdict.side, reason: verdict.reason }]
  })
}

/**
 * The stage's fact for a work item (§10): a capture that could not be taken first, since a person
 * must look; otherwise waiting while any task waits. Undefined where nothing waits on captures.
 */
export function screenshotWait(store: Store, work: StoreDoc): ScreenshotWait | undefined {
  if (typeof work.repoId !== 'string') return undefined
  if (!uiEvidenceSetting(store.engines.get(work.repoId)?.uiEvidence).required) return undefined
  const due = screenshotsDue(store, String(work.id))
  const failed = due.find((entry) => entry.state === 'could_not')
  if (failed !== undefined) return { state: 'could_not', side: failed.side ?? 'after' }
  return due.length > 0 ? { state: 'waiting' } : undefined
}

/** The owner's retry of a capture that could not be taken: its words, or undefined when none is offered. */
export function screenshotsOffer(store: Store, work: StoreDoc): { reason: string } | undefined {
  if (isTerminal(work) || isHeld(work) || mandateOf(work).status === 'withdrawn') return undefined
  if (screenshotWait(store, work)?.state !== 'could_not') return undefined
  const failed = screenshotsDue(store, String(work.id)).find((entry) => entry.state === 'could_not')
  if (failed === undefined) return undefined
  return {
    reason: `Couldn't take the ${failed.side ?? 'after'} screenshot: ${failed.reason ?? 'no reason recorded'}`,
  }
}

/**
 * Takes them again: each record that could not be taken goes back to `requested`, with nothing in
 * it, so no earlier capture can stand for the new one. Inside the caller's transaction.
 */
export function retakeScreenshots(store: Store, workItemId: string, at: string): number {
  const due = screenshotsDue(store, workItemId).filter((entry) => entry.state === 'could_not')
  for (const { attempt, task } of due) {
    const id = evidenceDocId(String(attempt.id))
    const known = store.engines.get(id)
    store.engines.save({
      id,
      attemptId: String(attempt.id),
      taskId: String(task.id),
      workItemId,
      repoId: (known?.repoId ?? task.repoId ?? null) as Json,
      state: 'requested',
      requestedAt: at,
      updatedAt: at,
    })
  }
  return due.length
}
