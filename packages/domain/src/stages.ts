/**
 * Stage projection, plan §10: an open work item has exactly one stage, computed from facts and
 * never stored. A first-match table in the spec's order: the three person stages first (a
 * decision, a login, a review, a blocked or failed report), then held, then waiting for quota,
 * queued, idle, and Working for everything else. A `person` stage means the item cannot continue
 * without the user. Labels say whom the item waits for and what it needs.
 *
 * Every fact is optional where the system may not have recorded it yet (a report, a quota park, a
 * login failure): an absent fact cannot match its row, so the item falls through to the next one
 * and never to a person stage by guesswork. An ended item has an outcome instead of a stage
 * (§18.3): merged, closed, stopped by you, dropped.
 */

export type WorkItemView = {
  state: string
  openQuestions: number
  awaitingConfirmation: boolean
  holdStatus: 'held' | 'free'
  /** A slot the plan needs is `auth_expired` (sign in) or `key_rejected` (replace the key). */
  loginNeeded?: 'sign-in' | 'replace-key'
  /** The latest report's kind (§10 closed vocabulary); absent when none is recorded. */
  latestReport?: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
  /** A user message reached the item after the latest report. */
  userMessageSinceReport?: boolean
  /** Every runnable attempt is parked in `quota_wait`; the reset time when it is known. */
  quotaWait?: { resetAt?: string }
  /** Tasks are ready and no slot capacity is free. */
  queued?: boolean
  /** The pull request is confirmed merged (never assumed). */
  merged?: boolean
}

export type Stage = {
  key: string
  label: string
  waitingOn: 'person' | 'system' | 'none'
}

export type StageRow = {
  key: string
  waitingOn: Stage['waitingOn']
  match: (w: WorkItemView) => boolean
  label: (w: WorkItemView) => string
}

const reportUnanswered = (w: WorkItemView, kind: 'blocked' | 'failed'): boolean =>
  w.latestReport === kind && w.userMessageSinceReport !== true

const hhmm = (iso: string | undefined): string | undefined => {
  if (iso === undefined) return undefined
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export const STAGE_TABLE: readonly StageRow[] = [
  {
    key: 'person/decision',
    waitingOn: 'person',
    match: (w) => w.openQuestions > 0,
    label: () => 'Needs your answer',
  },
  {
    key: 'person/decision',
    waitingOn: 'person',
    match: (w) => w.awaitingConfirmation,
    label: () => 'Needs your approval',
  },
  {
    key: 'person/login',
    waitingOn: 'person',
    match: (w) => w.loginNeeded === 'sign-in',
    label: () => 'Sign in again',
  },
  {
    key: 'person/login',
    waitingOn: 'person',
    match: (w) => w.loginNeeded === 'replace-key',
    label: () => 'Replace key',
  },
  {
    key: 'person/review',
    waitingOn: 'person',
    match: (w) => w.latestReport === 'ready',
    label: () => 'Ready for review',
  },
  {
    key: 'person/blocked',
    waitingOn: 'person',
    match: (w) => reportUnanswered(w, 'blocked'),
    label: () => 'Blocked',
  },
  {
    key: 'person/blocked',
    waitingOn: 'person',
    match: (w) => reportUnanswered(w, 'failed'),
    label: () => 'Failed',
  },
  {
    // The work item's own parked state (§10 States table): a person must act.
    key: 'person/blocked',
    waitingOn: 'person',
    match: (w) => w.state === 'blocked',
    label: () => 'Blocked',
  },
  {
    key: 'held',
    waitingOn: 'person',
    match: (w) => w.holdStatus === 'held',
    label: () => 'Held by you',
  },
  {
    key: 'waiting/quota',
    waitingOn: 'system',
    match: (w) => w.quotaWait !== undefined,
    label: (w) => {
      const reset = hhmm(w.quotaWait?.resetAt)
      return reset === undefined
        ? 'Waiting for quota (reset time unknown)'
        : `Waiting for quota (resets ${reset})`
    },
  },
  {
    key: 'working/queued',
    waitingOn: 'system',
    match: (w) => w.queued === true,
    label: () => 'Queued',
  },
  {
    key: 'idle',
    waitingOn: 'none',
    match: (w) => w.latestReport === 'waiting',
    label: () => 'Waiting for a trigger',
  },
  {
    key: 'working',
    waitingOn: 'none',
    match: () => true,
    label: () => 'Working',
  },
]

const ENDED: Readonly<Record<string, { key: string; label: string }>> = {
  stopped: { key: 'ended/stopped', label: 'Stopped by you' },
  dropped: { key: 'ended/dropped', label: 'Dropped' },
  closed: { key: 'ended/closed', label: 'Closed' },
}

/** An ended item has an outcome, not a stage; null while the item is open. */
function endedStage(w: WorkItemView): Stage | null {
  const fixed = ENDED[w.state]
  if (fixed !== undefined) return { ...fixed, waitingOn: 'none' }
  if (w.state === 'done') {
    return w.merged === true
      ? { key: 'ended/merged', label: 'Merged', waitingOn: 'none' }
      : { key: 'ended/done', label: 'Done', waitingOn: 'none' }
  }
  return null
}

export function stageOf(w: WorkItemView): Stage {
  const ended = endedStage(w)
  if (ended !== null) return ended
  const row = STAGE_TABLE.find((candidate) => candidate.match(w)) as StageRow
  return { key: row.key, label: row.label(w), waitingOn: row.waitingOn }
}
