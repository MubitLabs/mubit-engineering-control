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
}

export type WorkDetail = WorkRow & {
  originMessageId: string | null
  goal: string | null
  hold: { since: string; reason: string | null } | null
  planRevision: number | null
  tasks: TaskRow[]
  /** Tasks left out of `tasks`. */
  tasksTruncated: number
  /** Parent and child attempts. Empty until M2 records them; never inferred from dependencies. */
  delegation: { parentAttemptId: string; childAttemptId: string }[]
  delivery: DeliveryView
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
    files: { path: string; added: number; removed: number }[]
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

export type NeedItem = QuestionItem | CardItem

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
  /** The server redacted this message: it looked like a key. */
  secretGuard?: true
}
