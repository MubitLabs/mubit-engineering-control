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
  /** The repository needs the owner's agreement before anything of this item can start. */
  hostRunUnagreed?: boolean
  /** Tasks are ready and no slot capacity is free. */
  queued?: boolean
  /** The pull request is confirmed merged (never assumed). */
  merged?: boolean
  /** The delivery is at `pr-ready`: a person has the pull request to review (§10). */
  deliveryReady?: boolean
  /** A push or pull request card was declined, or its step failed: nothing moves until you ask again. */
  deliveryStopped?: DeliveryStop
  /** An attempt is queued or running, or a task is ready or active: work is under way. */
  underWay?: boolean
  /** The pull request's head on GitHub is not the commit MEC pushed or adopted: its short id. */
  branchMoved?: string
  /** GitHub's required checks on the pull request have not finished. */
  checksWaiting?: ChecksWait
}

/** Required checks still waiting on GitHub: queued (none started) or running, and since when MEC saw it. */
export type ChecksWait = { queued: boolean; since?: string }

/** Where a delivery stopped short, and how. */
export type DeliveryStop = { step: 'push' | 'pr'; outcome: 'declined' | 'failed' }

/** What a stage reads beyond the work doc. Each caller gathers these from its own store reads. */
export type WorkFacts = {
  openQuestions: number
  awaitingConfirmation: boolean
  attempts: readonly Record<string, unknown>[]
  merged: boolean
  /** The delivery stage is `pr-ready`; absent where the caller reads no delivery. */
  deliveryReady?: boolean
  /** `plannerTurnEnded`: planning stopped with no plan, so nothing is running on this item. */
  turnEnded?: boolean
  /** This item waits for its repository's agreement; absent where the caller does not read it. */
  hostRunUnagreed?: boolean
  /** `deliveryStopped` of the item's delivery record; absent where the caller reads no delivery. */
  deliveryStopped?: DeliveryStop
  /** A task is `ready` or `active`; absent where the caller reads no tasks. */
  tasksOpen?: boolean
  /** `deliveryWaiting(record).branchMoved`; absent where the caller reads no delivery. */
  branchMoved?: string
  /** `deliveryWaiting(record).checksWaiting`; absent where the caller reads no delivery. */
  checksWaiting?: ChecksWait
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

/** `Waiting for GitHub checks (queued since 14:02)`: the stage's label, and the live line's words. */
export function checksWaitLabel(wait: ChecksWait): string {
  const since = hhmm(wait.since)
  if (since === undefined) return 'Waiting for GitHub checks'
  return `Waiting for GitHub checks (${wait.queued ? 'queued' : 'running'} since ${since})`
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
    match: (w) => w.latestReport === 'ready' || w.deliveryReady === true,
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
    // A declined card or a failed step: the delivery waits for you to ask again (walkthrough, 9 November
    // 2026). Work under way after it, a follow-up's fix, is not waiting on you: its head is a new
    // commit, and a new card asks about it (§13).
    key: 'person/blocked',
    waitingOn: 'person',
    match: (w) => w.deliveryStopped !== undefined && w.underWay !== true,
    label: (w) => {
      const stop = w.deliveryStopped as DeliveryStop
      return `${stop.step === 'pr' ? 'Pull request' : 'Push'} ${stop.outcome}`
    },
  },
  {
    // The branch changed on GitHub and MEC did not adopt it (owner, 9 November 2026): MEC will not
    // merge commits it did not check, so a person decides what happens next.
    key: 'person/branch-moved',
    waitingOn: 'person',
    match: (w) => w.branchMoved !== undefined,
    label: () => 'Branch changed on GitHub',
  },
  {
    key: 'person/agreement',
    waitingOn: 'person',
    match: (w) => w.hostRunUnagreed === true,
    label: () => 'Waiting for your agreement',
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
    // GitHub's required checks have not finished (owner, 9 November 2026): a saturated runner pool
    // reads as a wait on GitHub, with how long, never as Working.
    key: 'waiting/checks',
    waitingOn: 'system',
    match: (w) => w.checksWaiting !== undefined,
    label: (w) => checksWaitLabel(w.checksWaiting as ChecksWait),
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

/**
 * A delivery record (`delivery/<work item>`) that stopped short: its card was declined or its step
 * failed. The pull request's card id says the push was already behind it, as the retry reads it.
 */
export function deliveryStopped(record: Record<string, unknown> | undefined): DeliveryStop | undefined {
  const stage = record?.stage
  if (stage !== 'declined' && stage !== 'failed') return undefined
  return { step: typeof record?.prCardId === 'string' ? 'pr' : 'push', outcome: stage }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * What an open pull request (`delivery/<work item>` at `pr_open`) waits on outside MEC: a head that
 * moved on GitHub, or required checks that have not finished. A moved head comes first, since the
 * checks then speak for a commit MEC did not push.
 */
export function deliveryWaiting(
  record: Record<string, unknown> | undefined,
): Pick<WorkFacts, 'branchMoved' | 'checksWaiting'> {
  if (record?.stage !== 'pr_open') return {}
  const moved = text((record.headMoved as { sha?: unknown } | undefined)?.sha)
  if (moved !== undefined) return { branchMoved: moved.slice(0, 7) }
  if (record.ci !== 'ci_pending') return {}
  const since = text(record.ciSince)
  return { checksWaiting: { queued: record.ciQueued === true, ...(since !== undefined && { since }) } }
}

/**
 * §10's `waiting`: the turn ended with nothing pending. An ack-only turn leaves its item `planning`
 * for a reply, so this is what tells that from a turn still running: the item's latest message has
 * its receipt, it came from a planner turn (an attached follow-up can start another), and no answer
 * has landed since, because an answer's wake is a turn on its way.
 */
export function plannerTurnEnded(
  messages: readonly Record<string, unknown>[],
  questions: readonly Record<string, unknown>[],
): boolean {
  if (messages.length === 0 || messages.some((message) => text(message.ackText) === undefined)) return false
  const moved = (doc: Record<string, unknown>): string => text(doc.updatedAt) ?? text(doc.createdAt) ?? ''
  const latest = [...messages].sort((a, b) => moved(a).localeCompare(moved(b))).at(-1)
  if (latest?.routing !== 'new_work') return false
  const reached = moved(latest)
  return !questions.some((question) => (text(question.answeredAt) ?? '') > reached)
}

/**
 * The one view of a work doc, so chat and Work cannot disagree (§10). `loginNeeded`,
 * `userMessageSinceReport` and `queued` are not read yet, and `latestReport` only as far as
 * `plannerTurnEnded`: an absent fact cannot match its row, so the item is never a person stage by
 * guesswork.
 */
export function workViewOf(doc: Record<string, unknown>, facts: WorkFacts): WorkItemView {
  const hold = doc.hold as Record<string, unknown> | undefined | null
  const live = facts.attempts.filter((a) => ['queued', 'running', 'quota_wait'].includes(String(a.state)))
  const parked = live.length > 0 && live.every((a) => a.state === 'quota_wait')
  const resets = live
    .flatMap(
      (a) =>
        text((a.parked as { resets_at?: unknown })?.resets_at) ?? text(a.resetsAt) ?? text(a.resetAt) ?? [],
    )
    .sort()
  return {
    state: text(doc.state) ?? 'admitted',
    openQuestions: facts.openQuestions,
    awaitingConfirmation: facts.awaitingConfirmation,
    holdStatus:
      typeof hold === 'object' && hold !== null && text(hold.liftedAt) === undefined ? 'held' : 'free',
    ...(parked && { quotaWait: resets[0] === undefined ? {} : { resetAt: resets[0] } }),
    merged: facts.merged,
    ...(facts.deliveryReady === true && { deliveryReady: true }),
    ...(facts.turnEnded === true && text(doc.state) === 'planning' && { latestReport: 'waiting' as const }),
    ...(facts.hostRunUnagreed === true && { hostRunUnagreed: true }),
    ...(facts.deliveryStopped !== undefined && { deliveryStopped: facts.deliveryStopped }),
    ...((live.length > 0 || facts.tasksOpen === true) && { underWay: true }),
    ...(facts.branchMoved !== undefined && { branchMoved: facts.branchMoved }),
    ...(facts.checksWaiting !== undefined && { checksWaiting: facts.checksWaiting }),
  }
}
