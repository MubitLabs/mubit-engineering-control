/**
 * The inspection wire shape, copied from the M3.1 handoff ("The wire shape"). Types only:
 * test/inspection-contract.test.ts holds them to a real server once the routes exist.
 */

export type Page<T> = { items: T[]; nextCursor: string | null; observedAt: string }

/** false means not recorded yet, which is different from none. */
export type Coverage = {
  reports: boolean
  checks: boolean
  diff: boolean
  activity: boolean
  usage: boolean
  delivery: boolean
}

export type Stage = { key: string; label: string; waitingOn: 'person' | 'system' | 'none' }

export type WorkRow = {
  id: string
  title: string | null
  repoId: string | null
  repoLabel: string | null
  readOnly: boolean
  state: string
  stage: Stage
  reason: string | null
  nextAction: string | null
  taskCounts: { total: number; byStatus: Record<string, number> }
  lastActivityAt: string | null
  updatedAt: string
  /** A turn that ended with no plan and nothing asked. Null on anything else. */
  turnOutcome: 'answered' | 'no-answer' | null
}

export type TaskRow = {
  id: string
  localKey: string | null
  title: string
  role: string | null
  status: string
  dependsOn: string[]
  /** Ids left out of `dependsOn`. */
  dependsOnTruncated: number
  planRevision: number | null
  attemptCount: number
}

export type DeliveryView = {
  stage: 'none' | 'local-complete' | 'awaiting-push' | 'awaiting-pr' | 'pr-open' | 'pr-ready' | 'merged'
  branch: string | null
  headSha: string | null
  prNumber: number | null
  prUrl: string | null
  /** `owner/name`, which a merge card binds. Null until a push resolved it. */
  repo: string | null
  /** What the last read of GitHub saw. Null when nothing has read it. */
  ci: 'passing' | 'none-required' | 'running' | 'failing' | 'unreadable' | null
  ciReadAt: string | null
  /** While required checks wait on GitHub: since when, and whether none has started yet. Absent otherwise. */
  ciSince?: string
  ciQueued?: boolean
  /** The pull request's head on GitHub when MEC did not adopt it, short. Absent otherwise. */
  movedTo?: string
  /** Why delivery stopped, in a sentence. Null when nothing failed. */
  failure: string | null
  /** The open merge card: the question is already asked. */
  mergeCardId: string | null
}

export type WorkDetail = WorkRow & {
  originMessageId: string | null
  goal: string | null
  /** What an answered question's turn reported. */
  answer: string | null
  hold: { since: string; reason: string | null } | null
  planRevision: number | null
  tasks: TaskRow[]
  /** Tasks left out of `tasks`. */
  tasksTruncated: number
  /** Who holds each task, read from its attempts. Never inferred from dependencies. */
  delegation: DelegationRow[]
  delivery: DeliveryView
  /** What the owner may ask for again, and why it stopped. */
  retry: { kind: 'integration' | 'push' | 'pr' | 'repair' | 'update'; reason: string } | null
  coverage: Coverage
  cursors: Record<string, number>
  /** Attempt streams left out of `cursors`. */
  cursorsTruncated: number
}

export type AttemptView = {
  id: string
  generation: number
  state: string
  role: string | null
  requested: { tier: string | null; model: string | null }
  actual: { model: string | null; engine: string | null; slotLabel: string | null } | null
  baseSha: string | null
  headSha: string | null
  processOutcome: string | 'unknown'
  lastActivityAt: string | null
  /** Why this connection: the scheduler's own words. */
  placement: string | null
}

/** Who a task went to and why. `latest` is null until placement picks a connection. */
export type DelegationRow = {
  taskId: string
  title: string
  role: string | null
  status: string
  requested: { tier: string | null; model: string | null }
  attempts: number
  latest: AttemptView | null
  /** Why a task with nothing running has not started. */
  waiting: string | null
  /** The newest thing the latest attempt recorded. A step shows here once it has finished. */
  activity: { summary: string; at: string } | null
}

/** GET /api/inspect/meta, one row per repository. */
export type MetaActivity = {
  repoId: string
  state: string
  line: string
  workItemId: string | null
  /** A planner turn is running now. */
  running: boolean
  /** When a running turn began, else the last recorded event. */
  at: string | null
}

export type MetaConnection = {
  slotLabel: string | null
  engine: string | null
  /** What the last turn really started on. */
  model: string | null
  modelAt: string | null
}

export type MetaAnswer = {
  observedAt: string
  connection: MetaConnection | null
  repositories: MetaActivity[]
}

/** One page item of `GET /api/inspect/attempts/:id/activity`. A `tool_call` has finished. */
export type ActivityItem = {
  seq: number
  type: string
  at: string
  summary: string
  detail: string | null
}

/** One answer from `GET /api/inspect/artifacts`. Binary files never send their contents. */
export type ArtifactPage =
  | { kind: 'text'; ref: string; text: string; size: number; nextCursor: string | null }
  | { kind: 'binary'; ref: string; size: number }

export type CheckView = {
  name: string
  state: 'passed' | 'failed' | 'not-run'
  headSha: string | null
  detail: string | null
  artifactRef: string | null
}

export type TaskDetail = TaskRow & {
  workItemId: string
  repoId: string | null
  objective: string
  attempts: AttemptView[]
  /** Older attempts left out of `attempts`. */
  attemptsTruncated: number
  /** Only for the exact head named; never inherited from another scope. */
  checks: { headSha: string | null; results: CheckView[]; truncated: number }
  diff: {
    headSha: string | null
    summary: string | null
    files: { path: string; added: number; removed: number; binary?: true }[]
    truncated: number
  }
  usage: { reportedUsd: number | null; missingAttempts: number; mode: 'api' | 'subscription' | 'unknown' }
  coverage: Coverage
}

export type QuestionItem = {
  kind: 'question'
  id: string
  repoId: string | null
  repoLabel: string | null
  workItemId: string | null
  question: string
  options: string[]
  status: 'open' | 'answered' | 'expired'
  askedAt: string | null
  answer: string | null
}

export type CardItem = {
  kind: 'card'
  id: string
  repoId: string | null
  repoLabel: string | null
  workItemId: string | null
  cls: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'stale'
  expiresAt: string
  detailPath: string
}

/** §18.2: work in a `person` stage with no question or card of its own to answer. */
export type WorkNeedItem = {
  kind: 'work'
  id: string
  repoId: string | null
  repoLabel: string | null
  workItemId: string
  title: string
  stageKey: string
  stageLabel: string
  reason: string | null
  nextAction: string | null
  status: 'open'
  since: string
  readOnly: boolean
}

/** A repository whose work waits for the owner: one row, however many items it holds back. */
export type AgreementItem = {
  kind: 'agreement'
  id: string
  repoId: string | null
  repoLabel: string | null
  workItemId: string | null
  status: 'open'
  waiting: number
}

export type NeedItem = QuestionItem | CardItem | WorkNeedItem | AgreementItem

/** GET /api/inspect/snapshot: one consistent read of the counts and the event cursors. */
export type Snapshot = {
  observedAt: string
  repositories: { id: string; label: string | null; needsCount: number }[]
  /** Repositories left out of `repositories`. */
  repositoriesTruncated: number
  needsCount: number
  cursors: Record<string, number>
}

export type SearchHit = {
  kind: 'message' | 'work' | 'task' | 'attempt' | 'reference'
  id: string
  title: string
  repoLabel: string | null
  workItemId: string | null
}

/**
 * GET /api/inbox/:id/detail, the card evidence the release route already serves. Not part of
 * M3.1's shape: a copy, because next/* cannot import api.ts.
 */
export type CardEvidence = {
  /** The honest placeholder for a card the server serves no evidence for: nothing to approve on. */
  absent?: true
  what: string
  verb: string | null
  why: string
  facts: { label: string; value: string; mono: boolean }[]
  operation: string
  requestedBy: string
  consequences: { approve: string; deny: string }
  checks: { name: string; state: 'passed' | 'failed' | 'running' | 'none'; note: string | null }[]
  diff: { summary: string; files: { path: string; added: number; removed: number }[] }
}

/** One line of GET /api/chat/messages, the fields the conversation shows. */
export type ChatLine = {
  id: string
  text: string
  createdAt: string
  workItemId: string | null
  /** Stored messages have no kind yet: null is the person's own message, unless it is a wake's. */
  kind: string | null
  /** The meta agent's acknowledgement, stored on the message it answers. */
  ackText?: string
  /** The key a send carried, so the page can tell its own message from an echo. */
  idempotencyKey?: string
  /** The server redacted this message: it looked like a key. */
  secretGuard?: true
  /** Said while processing was paused. It is not a receipt: the turn has not run. */
  pausedAck?: string
}
