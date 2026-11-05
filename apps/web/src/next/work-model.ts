import type { TaskProgress, TaskRowProps } from './Conversation'
import type { ApprovalProps, DecisionStatus, QuestionProps } from './Decision'
import type { Fact, InspectorChecks, InspectorScope } from './Inspector'
import type {
  AttemptView,
  CardEvidence,
  CardItem,
  ChatLine,
  NeedItem,
  Page,
  QuestionItem,
  SearchHit,
  TaskDetail,
  WorkDetail,
  WorkRow,
} from './inspection-wire'
import type { StatusTone } from './primitives'

/**
 * Pure functions from wire types to component props, so vitest can hold every grouping, count and
 * scope rule. Nothing here reads a server: the live layer and the test harness both feed it
 * decoded payloads, and it never fills a gap with a guess.
 */

const NOT_RECORDED = 'Not recorded yet'

// ── Reads ────────────────────────────────────────────────────────────────────────────────

/** Loading ends in ready or failed. A failed read keeps what it last had, labelled stale. */
export type Read<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; readAt: string }
  | { status: 'failed'; message: string; data: T | null; readAt: string | null }

export interface SurfaceState {
  state: 'loading' | 'ready' | 'empty' | 'failed'
  message: string | null
  hasContent: boolean
  freshness: string | null
}

export const readData = <T>(read: Read<T>): T | null => (read.status === 'loading' ? null : read.data)

/** The same read over a derived value. What was kept stays kept. */
export function mapRead<T, U>(read: Read<T>, map: (data: T) => U): Read<U> {
  if (read.status === 'loading') return read
  if (read.status === 'ready') return { ...read, data: map(read.data) }
  return { ...read, data: read.data === null ? null : map(read.data) }
}

function timeLabel(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** One answer for every surface: ready, empty or failed, never a failure dressed as empty. */
export function readSurface<T>(read: Read<T>, isEmpty: (data: T) => boolean): SurfaceState {
  if (read.status === 'loading')
    return { state: 'loading', message: null, hasContent: false, freshness: null }
  if (read.status === 'ready') {
    const empty = isEmpty(read.data)
    return {
      state: empty ? 'empty' : 'ready',
      message: null,
      hasContent: !empty,
      freshness: `Last read ${timeLabel(read.readAt)}`,
    }
  }
  return {
    state: 'failed',
    message: read.message,
    hasContent: read.data !== null && !isEmpty(read.data),
    freshness: read.readAt === null ? null : `Stale. Last read ${timeLabel(read.readAt)}`,
  }
}

// ── Repository scope ─────────────────────────────────────────────────────────────────────

export type RepoFilter = { kind: 'all' } | { kind: 'repo'; repoId: string } | { kind: 'unassigned' }

export interface RepoFilterOption {
  value: string
  label: string
  filter: RepoFilter
}

const UNASSIGNED = 'Unassigned'

/** Legacy work has no repository, and nothing may guess one: it is shown and offers no action. */
function unassigned(item: { repoId: string | null; repoLabel: string | null }): boolean {
  return item.repoId === null && item.repoLabel === null
}

export function inFilter(
  item: { repoId: string | null; repoLabel: string | null },
  filter: RepoFilter,
): boolean {
  if (filter.kind === 'all') return true
  if (filter.kind === 'unassigned') return unassigned(item)
  return item.repoId === filter.repoId
}

/** The option that stands for a filter, for a `<select>`. */
export function filterValue(filter: RepoFilter): string {
  return filter.kind === 'repo' ? filter.repoId : filter.kind
}

export function repoFilterOptions(
  rows: readonly WorkRow[],
  items: readonly NeedItem[],
  registered: readonly { id: string; label: string }[] = [],
): readonly RepoFilterOption[] {
  const repositories = new Map(registered.map((repo) => [repo.id, repo.label]))
  const everything = [...rows, ...items]
  for (const item of everything) {
    if (item.repoId !== null) repositories.set(item.repoId, item.repoLabel ?? item.repoId)
  }
  const named = [...repositories]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([repoId, label]): RepoFilterOption => ({ value: repoId, label, filter: { kind: 'repo', repoId } }))
  return [
    { value: 'all', label: 'All repositories', filter: { kind: 'all' } },
    ...named,
    ...(everything.some(unassigned)
      ? [{ value: 'unassigned', label: UNASSIGNED, filter: { kind: 'unassigned' } } as const]
      : []),
  ]
}

/** A selection never outlives the list it was made from. */
export function selectionInScope(selected: string | null, visible: readonly string[]): string | null {
  return selected !== null && visible.includes(selected) ? selected : null
}

// ── Work list ────────────────────────────────────────────────────────────────────────────

export type StageGroupKey = 'open' | 'queued' | 'working' | 'waiting' | 'held' | 'ended'

/** §18.3's groups in its order. `open` is a person stage (§18.2), which the §10 table outranks a hold with. */
const STAGE_GROUPS: readonly { key: StageGroupKey; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'queued', label: 'Queued' },
  { key: 'working', label: 'Working' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'held', label: 'Held' },
  { key: 'ended', label: 'Ended' },
]

const ENDED_STATES = new Set(['done', 'stopped', 'dropped', 'closed', 'merged'])

function ended(row: WorkRow): boolean {
  return ENDED_STATES.has(row.state) || row.stage.key.startsWith('ended')
}

/**
 * From the served stage, never from a state alone: a blocked item is not always an approval and a
 * parked one is not always quota. An unknown key still lands by whom it waits on.
 */
export function stageGroup(row: WorkRow): StageGroupKey {
  const { key, waitingOn } = row.stage
  if (ended(row)) return 'ended'
  if (key.includes('held')) return 'held'
  if (waitingOn === 'person') return 'open'
  if (row.state === 'held') return 'held'
  if (key.includes('queued')) return 'queued'
  if (waitingOn === 'system' || key === 'idle' || key.includes('waiting')) return 'waiting'
  return 'working'
}

export interface WorkRowView {
  id: string
  title: string
  repository: string
  stageLabel: string
  tone: StatusTone
  reason: string | null
  nextStep: string | null
  outcome: string | null
}

export function workRowView(row: WorkRow): WorkRowView {
  const isEnded = ended(row)
  return {
    id: row.id,
    title: row.title ?? 'Untitled request',
    repository: row.repoLabel ?? UNASSIGNED,
    stageLabel: row.stage.label,
    tone: row.stage.waitingOn === 'person' && !isEnded ? 'attention' : 'neutral',
    reason: row.reason,
    nextStep: row.nextAction,
    outcome: isEnded ? row.stage.label : null,
  }
}

export interface WorkGroupView {
  key: StageGroupKey
  label: string
  count: number
  rows: readonly WorkRowView[]
}

/** Empty groups stay in the list so the order is fixed; the view skips them. Newest leads each. */
export function workGroups(rows: readonly WorkRow[], filter: RepoFilter): readonly WorkGroupView[] {
  const scoped = rows
    .filter((row) => inFilter(row, filter))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return STAGE_GROUPS.map(({ key, label }) => {
    const members = scoped.filter((row) => stageGroup(row) === key).map(workRowView)
    return { key, label, count: members.length, rows: members }
  })
}

export interface WorkAction {
  kind: 'hold' | 'lift' | 'stop'
  label: string
  workItemId: string
  repoId: string
}

/** The item's own id and repository, whatever the filter says. A filter only changes the wording. */
const whereLabel = (row: WorkRow, filter: RepoFilter | null): string =>
  filter?.kind === 'all' ? ` in ${row.repoLabel ?? row.repoId}` : ''

export function workActions(
  row: WorkRow,
  filter: RepoFilter,
  hold: WorkDetail['hold'],
): readonly WorkAction[] {
  const { repoId } = row
  if (repoId === null || row.readOnly || ended(row)) return []
  const where = whereLabel(row, filter)
  const held = hold !== null || stageGroup(row) === 'held'
  return [
    {
      kind: held ? 'lift' : 'hold',
      label: `${held ? 'Lift hold' : 'Hold'}${where}`,
      workItemId: row.id,
      repoId,
    },
    { kind: 'stop', label: `Stop${where}`, workItemId: row.id, repoId },
  ]
}

// ── Delivery ─────────────────────────────────────────────────────────────────────────────

const TASK_LABELS: Record<string, { label: string; progress: TaskProgress }> = {
  ready: { label: 'Ready', progress: 'waiting' },
  active: { label: 'In progress', progress: 'running' },
  awaiting_review: { label: 'Awaiting review', progress: 'running' },
  accepted: { label: 'Accepted', progress: 'done' },
  integrated: { label: 'Integrated', progress: 'done' },
  blocked: { label: 'Blocked', progress: 'blocked' },
  cancelled: { label: 'Cancelled', progress: 'failed' },
}

const taskLabel = (status: string) => TASK_LABELS[status] ?? { label: status, progress: 'waiting' as const }

const DELIVERY_LABELS: Record<WorkDetail['delivery']['stage'], string> = {
  none: 'Nothing has left this machine',
  'local-complete': 'Complete locally, nothing has left this machine',
  'awaiting-push': 'Waiting for your push approval',
  'awaiting-pr': 'Waiting for your pull request approval',
  'pr-open': 'Pull request open',
  'pr-ready': 'Pull request ready for review',
  merged: 'Merged',
}

function deliveryLabel(detail: WorkDetail): string {
  if (!detail.coverage.delivery) return 'Delivery is not recorded yet'
  const { stage, prNumber } = detail.delivery
  const label = DELIVERY_LABELS[stage]
  return prNumber !== null ? `${label}, pull request #${prNumber}` : label
}

/** Sets M1.3's intent on the item's own repository, never on the selected one. */
export interface DiscussAction {
  label: string
  workItemId: string
  repoId: string
}

function discussAction(row: WorkRow, filter: RepoFilter | null): DiscussAction | null {
  if (row.repoId === null || row.readOnly || ended(row)) return null
  return {
    label: `Discuss this work${whereLabel(row, filter)}`,
    workItemId: row.id,
    repoId: row.repoId,
  }
}

export interface DeliveryDetailView {
  plan: {
    title: string
    subtitle: string
    stateLabel: string
    stateTone: StatusTone
    tasks: readonly Omit<TaskRowProps, 'selected' | 'onOpen'>[]
    footnote: string
  }
  /** Read only from `dependsOn`. */
  dependencies: readonly { task: string; on: readonly string[]; more?: number }[]
  /** Read only from `delegation`. */
  delegation: readonly { parent: string; child: string }[]
  actions: readonly WorkAction[]
  discuss: DiscussAction | null
}

/** What a bounded answer left out. A cut list never reads as the whole list. */
const leftOut = (count: number, noun: string): string => (count > 0 ? `, ${count} ${noun} not shown` : '')

export function deliveryDetail(detail: WorkDetail, filter: RepoFilter | null): DeliveryDetailView {
  const titles = new Map(detail.tasks.map((task) => [task.id, task.title]))
  const count = detail.tasks.length
  const row = workRowView(detail)
  return {
    plan: {
      title: row.title,
      subtitle: `${count} ${count === 1 ? 'task' : 'tasks'} in ${row.repository}${leftOut(detail.tasksTruncated, 'more')}`,
      stateLabel: row.stageLabel,
      stateTone: row.tone,
      tasks: detail.tasks.map((task) => {
        const { label, progress } = taskLabel(task.status)
        return {
          id: task.id,
          title: task.title,
          detail: task.role ?? 'No role recorded',
          stateLabel: label,
          progress,
        }
      }),
      footnote: deliveryLabel(detail),
    },
    dependencies: detail.tasks
      .filter((task) => task.dependsOn.length > 0)
      .map((task) => ({
        task: task.title,
        on: task.dependsOn.map((id) => titles.get(id) ?? id),
        ...(task.dependsOnTruncated > 0 && { more: task.dependsOnTruncated }),
      })),
    delegation: detail.delegation.map((link) => ({
      parent: link.parentAttemptId,
      child: link.childAttemptId,
    })),
    actions: workActions(detail, filter ?? { kind: 'all' }, detail.hold),
    discuss: discussAction(detail, filter),
  }
}

// ── Inspector ────────────────────────────────────────────────────────────────────────────

/** Evidence on a commit exists only once the task has stopped moving. */
const FINISHED_TASKS = new Set(['awaiting_review', 'accepted', 'integrated'])

const short = (sha: string) => sha.slice(0, 7)

function latestAttempt(attempts: readonly AttemptView[]): AttemptView | null {
  return attempts.reduce<AttemptView | null>(
    (latest, attempt) => (latest === null || attempt.generation >= latest.generation ? attempt : latest),
    null,
  )
}

function taskChecks(detail: TaskDetail, head: string | null): InspectorChecks {
  if (!detail.coverage.checks) {
    return { state: 'unavailable', heading: NOT_RECORDED, detail: 'No check result is stored for this task.' }
  }
  const notRun = (body: string): InspectorChecks => ({
    state: 'not-run',
    heading: 'Not run yet',
    detail: body,
  })
  if (!FINISHED_TASKS.has(detail.status)) return notRun('This task is still in progress.')
  if (head === null || detail.checks.headSha !== head) return notRun('No checks ran on this task’s commit.')
  const results = detail.checks.results.filter((result) => result.headSha === head)
  const decided = results.filter((result) => result.state !== 'not-run')
  if (decided.length === 0) return notRun('No checks ran on this task’s commit.')
  const failed = decided.some((result) => result.state === 'failed')
  return {
    state: failed ? 'failed' : 'passed',
    heading: failed ? 'Checks failed on this commit' : 'Checks passed on this commit',
    detail: `Results for ${short(head)} only${leftOut(detail.checks.truncated, 'more results')}.`,
    results: decided.map((result) => ({
      label: result.name,
      detail: result.detail ?? '',
      passed: result.state === 'passed',
    })),
  }
}

function requestedLabel(attempt: AttemptView | null): string {
  if (attempt === null) return NOT_RECORDED
  const parts = [attempt.requested.tier, attempt.requested.model].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(', ') : NOT_RECORDED
}

function usageLabel(detail: TaskDetail): string {
  if (!detail.coverage.usage) return NOT_RECORDED
  const { reportedUsd, missingAttempts } = detail.usage
  if (reportedUsd === null) return 'No reading yet'
  const known = `$${reportedUsd.toFixed(2)} reported`
  return missingAttempts > 0 ? `${known}, ${missingAttempts} attempts unknown` : known
}

export function taskScope(detail: TaskDetail, workTitle: string): InspectorScope {
  const attempt = latestAttempt(detail.attempts)
  const head = attempt?.headSha ?? detail.diff.headSha
  const actual = attempt?.actual ?? null
  const facts: Fact[] = [
    { label: 'Role', value: detail.role ?? NOT_RECORDED },
    { label: 'State', value: taskLabel(detail.status).label },
    { label: 'Requested', value: requestedLabel(attempt) },
    { label: 'Actual model', value: actual?.model ?? NOT_RECORDED },
    { label: 'Engine', value: actual?.engine ?? NOT_RECORDED },
    { label: 'Connection', value: actual?.slotLabel ?? NOT_RECORDED },
    {
      label: 'Last activity',
      value: attempt?.lastActivityAt ? timeLabel(attempt.lastActivityAt) : NOT_RECORDED,
    },
    { label: 'Usage', value: usageLabel(detail) },
  ]
  const technical: Fact[] = [
    { label: 'Task', value: detail.id, mono: true },
    ...detail.attempts.map((entry) => ({
      label: `Attempt ${entry.generation}`,
      value: entry.id,
      mono: true,
    })),
    ...(head ? [{ label: 'Head', value: head, mono: true }] : []),
  ]
  return {
    id: `task:${detail.id}`,
    kind: 'task',
    context: workTitle,
    title: detail.title,
    overview: { sections: [{ heading: 'Objective', body: detail.objective }], facts },
    technical,
    checks: taskChecks(detail, head),
    activity: detail.coverage.activity
      ? {
          note: `Attempts recorded for this task${leftOut(detail.attemptsTruncated, 'older attempts')}.`,
          entries: detail.attempts.map((entry) => ({
            when: entry.lastActivityAt ? timeLabel(entry.lastActivityAt) : NOT_RECORDED,
            text: `Attempt ${entry.generation}: ${entry.state}`,
          })),
        }
      : { note: NOT_RECORDED, entries: [] },
    diff: detail.coverage.diff
      ? {
          summary: `${detail.diff.summary ?? NOT_RECORDED}${leftOut(detail.diff.truncated, 'more files')}`,
          files: detail.diff.files.map((file) => ({
            path: file.path,
            lines: [`+${file.added} -${file.removed}`],
          })),
        }
      : { summary: NOT_RECORDED, files: [] },
  }
}

/** Stands in while a task reads, or when it could not be read: same id, so the tabs stay put. */
export function pendingScope(taskId: string, workTitle: string, title: string): InspectorScope {
  return {
    id: `task:${taskId}`,
    kind: 'task',
    context: workTitle,
    title,
    overview: { sections: [], facts: [] },
    checks: { state: 'unavailable', heading: NOT_RECORDED, detail: title },
    activity: { note: title, entries: [] },
    diff: { summary: title, files: [] },
  }
}

/** Kept evidence stays on screen after a failed read, and says how old it is. */
export const staleScope = (scope: InspectorScope, freshness: string): InspectorScope => ({
  ...scope,
  context: `${scope.context}. ${freshness}`,
})

/** The task a selection shows: its own read, and never a task from another delivery. */
export function taskInspector(
  taskId: string,
  read: Read<TaskDetail>,
  workId: string,
  workTitle: string,
): InspectorScope | null {
  if (read.status === 'loading') return pendingScope(taskId, workTitle, 'Reading this task')
  const { data } = read
  if (data === null) return pendingScope(taskId, workTitle, read.status === 'failed' ? read.message : '')
  if (data.id !== taskId || data.workItemId !== workId) return null
  const scope = taskScope(data, workTitle)
  return read.status === 'failed' ? staleScope(scope, readSurface(read, () => false).freshness ?? '') : scope
}

function cardChecks(evidence: CardEvidence): InspectorChecks {
  if (evidence.checks.length === 0) {
    return { state: 'unavailable', heading: NOT_RECORDED, detail: 'This card serves no check results.' }
  }
  const results = evidence.checks.filter((row) => row.state === 'passed' || row.state === 'failed')
  const failed = results.some((row) => row.state === 'failed')
  const undecided = results.length < evidence.checks.length
  if (undecided && !failed) {
    return {
      state: 'not-run',
      heading: 'Not run yet',
      detail: 'At least one check on this card has not finished.',
    }
  }
  return {
    state: failed ? 'failed' : 'passed',
    heading: failed ? 'Checks failed on this card’s commit' : 'Checks passed on this card’s commit',
    detail: 'These are the card’s own results, for the commit it is bound to.',
    results: results.map((row) => ({
      label: row.name,
      detail: row.note ?? '',
      passed: row.state === 'passed',
    })),
  }
}

export function approvalScope(item: CardItem, evidence: CardEvidence): InspectorScope {
  return {
    id: `approval:${item.id}`,
    kind: 'approval',
    context: `${cardLabel(item.cls)}, ${repositoryOf(item)}`,
    title: evidence.what,
    overview: {
      sections: [
        { heading: 'Why this asks you', body: evidence.why },
        { heading: 'Requested by', body: evidence.requestedBy },
      ],
      facts: evidence.facts.filter((fact) => !fact.mono),
    },
    technical: [
      ...evidence.facts.filter((fact) => fact.mono),
      { label: 'Card', value: item.id, mono: true },
      { label: 'Operation', value: evidence.operation, mono: true },
    ],
    checks: cardChecks(evidence),
    activity: { note: NOT_RECORDED, entries: [] },
    diff: {
      summary: evidence.diff.summary,
      files: evidence.diff.files.map((file) => ({
        path: file.path,
        lines: [`+${file.added} -${file.removed}`],
      })),
    },
  }
}

// ── Needs you ────────────────────────────────────────────────────────────────────────────

export interface NeedsList {
  /** null while unknown: a failed read is never "nothing waiting", and a part list has no total. */
  count: number | null
  /** The server has more than was read. */
  partial: boolean
  waiting: readonly NeedItem[]
  settled: readonly NeedItem[]
}

const isOpen = (item: NeedItem) => item.status === 'open' || item.status === 'pending'

const repositoryOf = (item: NeedItem) => item.repoLabel ?? UNASSIGNED

const FINISHED_STATUSES = new Set(['accepted', 'integrated', 'cancelled'])

/** The tasks a person's answer could release: everything in the delivery not yet finished. */
function tasksWaiting(row: WorkRow | undefined): number {
  if (row === undefined) return 0
  return Object.entries(row.taskCounts.byStatus).reduce(
    (sum, [status, count]) => (FINISHED_STATUSES.has(status) ? sum : sum + count),
    0,
  )
}

const needAge = (item: NeedItem) => (item.kind === 'question' ? (item.askedAt ?? '') : item.expiresAt)

/** One list, one filter: the sidebar count and the page are the same array. */
export function needsList(
  read: Read<Page<NeedItem>>,
  rows: readonly WorkRow[],
  filter: RepoFilter,
): NeedsList {
  const items = (readData(read)?.items ?? []).filter((item) => inFilter(item, filter))
  const byId = new Map(rows.map((row) => [row.id, row]))
  const downstream = (item: NeedItem) => tasksWaiting(byId.get(item.workItemId ?? ''))
  const waiting = items
    .filter(isOpen)
    .sort((a, b) => downstream(b) - downstream(a) || needAge(a).localeCompare(needAge(b)))
  const settled = items.filter((item) => !isOpen(item))
  const partial = readData(read)?.nextCursor != null
  return { count: read.status === 'ready' && !partial ? waiting.length : null, waiting, settled, partial }
}

export const needsCount = (list: NeedsList): number | null => list.count

const CARD_LABELS: Record<string, string> = {
  push: 'Push approval',
  pr_create: 'Pull request approval',
  pr_merge: 'Merge approval',
}

const cardLabel = (cls: string) => CARD_LABELS[cls] ?? 'Approval'

/** The shape of describeApproval's answer. next/* cannot import it, so the caller passes it in. */
export interface ApprovalOutcome {
  closes: boolean
  note: string
  toast: string
}

/** describeApproval reads an approve click; a deny settles with nothing run. */
export const DENIED: ApprovalOutcome = { closes: true, note: 'Denied', toast: 'Nothing ran.' }

function cardStatus(item: CardItem, outcome: ApprovalOutcome | null): DecisionStatus {
  if (outcome?.closes) return { state: 'resolved', label: outcome.note, detail: outcome.toast }
  switch (item.status) {
    case 'pending':
      return { state: 'open', expires: `Expires at ${timeLabel(item.expiresAt)}` }
    case 'approved':
      return {
        state: 'resolved',
        label: 'Approved',
        detail: 'The answer is recorded. It says nothing about the result.',
      }
    case 'denied':
      return { state: 'resolved', label: 'Denied', detail: 'Nothing ran.' }
    case 'stale':
      return { state: 'expired', label: 'Stale', detail: 'The head moved. Nothing ran.' }
    case 'expired':
      return { state: 'expired', label: 'Expired', detail: 'Nothing ran.' }
  }
}

export type ApprovalView = Omit<ApprovalProps, 'onConfirm' | 'onDeny' | 'onInspect'> & {
  id: string
  canApprove: boolean
  actionable: boolean
  hold: string | null
}

/** A card the server serves no evidence for is the same as one whose evidence never arrived. */
export const usableEvidence = (evidence: CardEvidence | null): CardEvidence | null =>
  evidence === null || evidence.absent === true ? null : evidence

export function approvalProps(
  item: CardItem,
  served: CardEvidence | null,
  outcome: ApprovalOutcome | null,
): ApprovalView {
  const evidence = usableEvidence(served)
  const repository = repositoryOf(item)
  const verb = evidence?.verb ?? 'approve'
  return {
    id: item.id,
    label: cardLabel(item.cls),
    title: evidence?.what ?? cardLabel(item.cls),
    summary: evidence?.why ?? 'The evidence for this card has not loaded.',
    evidence: [
      { label: 'Repository', value: repository },
      ...(evidence?.facts.filter((f) => !f.mono) ?? []),
    ].filter((fact, index, all) => all.findIndex((other) => other.label === fact.label) === index),
    status: cardStatus(item, outcome),
    approveLabel: 'Approve',
    confirmLabel: `Confirm: ${verb} in ${repository}`,
    denyLabel: 'Deny',
    consequences: evidence
      ? [
          { heading: 'On approve', body: evidence.consequences.approve },
          { heading: 'On deny', body: evidence.consequences.deny },
        ]
      : [],
    canApprove: evidence !== null,
    actionable: !unassigned(item),
    hold: outcome !== null && !outcome.closes && item.status === 'pending' ? outcome.toast : null,
  }
}

export type AnswerOutcome =
  | { kind: 'answered'; answer: string }
  | { kind: 'already-answered' }
  | { kind: 'failed'; message: string }

function questionStatus(item: QuestionItem, outcome: AnswerOutcome | null): DecisionStatus {
  if (outcome?.kind === 'already-answered') {
    return {
      state: 'resolved',
      label: 'Already answered',
      detail: 'Someone answered this first. Yours was not sent.',
    }
  }
  if (outcome?.kind === 'answered') return { state: 'resolved', label: 'Answered', detail: outcome.answer }
  if (item.status === 'answered') {
    return { state: 'resolved', label: 'Answered', detail: item.answer ?? 'The answer is recorded.' }
  }
  if (item.status === 'expired')
    return { state: 'expired', label: 'Expired', detail: 'No answer was recorded.' }
  return { state: 'open', expires: item.askedAt ? `Asked at ${timeLabel(item.askedAt)}` : 'Waiting for you' }
}

export type QuestionView = Omit<QuestionProps, 'onAnswer' | 'onInspect'> & {
  id: string
  actionable: boolean
  /** The last answer did not land. The question stays open and nothing was recorded. */
  failure: string | null
}

export function questionProps(item: QuestionItem, outcome: AnswerOutcome | null): QuestionView {
  return {
    id: item.id,
    label: 'Question',
    title: item.question,
    summary: `Asked in ${repositoryOf(item)}.`,
    evidence: [{ label: 'Repository', value: repositoryOf(item) }],
    status: questionStatus(item, outcome),
    choices: item.options,
    freeTextLabel: 'Answer in your own words',
    actionable: !unassigned(item),
    failure: outcome?.kind === 'failed' && item.status === 'open' ? outcome.message : null,
  }
}

export type NeedCard = { kind: 'question'; view: QuestionView } | { kind: 'card'; view: ApprovalView }

/** A question is one record wherever it shows (§12.6, §18.2): both places read this same view. */
export function needCard(
  item: NeedItem,
  evidence: (id: string) => CardEvidence | null,
  cardOutcome: (id: string) => ApprovalOutcome | null,
  answerOutcome: (id: string) => AnswerOutcome | null,
): NeedCard {
  return item.kind === 'question'
    ? { kind: 'question', view: questionProps(item, answerOutcome(item.id)) }
    : { kind: 'card', view: approvalProps(item, evidence(item.id), cardOutcome(item.id)) }
}

// ── Conversation ─────────────────────────────────────────────────────────────────────────

export type ConversationEntry = { id: string; kind: 'user' | 'agent' | 'note'; text: string }

const ENTRY_KINDS: Record<string, ConversationEntry['kind']> = {
  user: 'user',
  agent: 'agent',
  status: 'note',
  notice: 'note',
}

export interface ConversationViewModel {
  title: string
  entries: readonly ConversationEntry[]
  plan: DeliveryDetailView['plan'] | null
  discuss: DiscussAction | null
}

/** §12.7: an acknowledgement can name work by id, and an id is not for the owner to read. */
function withTitles(text: string, work: readonly WorkRow[]): string {
  return work.reduce((line, row) => (row.title === null ? line : line.replaceAll(row.id, row.title)), text)
}

/**
 * Acknowledgement, plan and quiet progress. A stored message has no kind and is the person's; any
 * other unknown kind is a trace, and traces stay out (§18.1).
 */
export function conversationView(input: {
  row: WorkRow | null
  detail: WorkDetail | null
  messages: readonly ChatLine[]
  work?: readonly WorkRow[]
}): ConversationViewModel {
  const work = input.work ?? []
  const delivery = input.detail ? deliveryDetail(input.detail, null) : null
  const entries = input.messages.flatMap((line): ConversationEntry[] => {
    const kind = line.kind === null ? 'user' : ENTRY_KINDS[line.kind]
    if (kind === undefined) return []
    const text = kind === 'user' ? line.text : withTitles(line.text, work)
    return [
      { id: line.id, kind, text },
      ...(line.ackText === undefined
        ? []
        : [{ id: `${line.id}:ack`, kind: 'agent' as const, text: withTitles(line.ackText, work) }]),
      ...(line.secretGuard === true
        ? [
            {
              id: `${line.id}:guard`,
              kind: 'note' as const,
              text: 'This looked like a key, so it was redacted before storage.',
            },
          ]
        : []),
    ]
  })
  return {
    title: input.row ? workRowView(input.row).title : 'Conversation',
    entries,
    plan: delivery?.plan ?? null,
    discuss: delivery?.discuss ?? null,
  }
}

/** The task Inspect opens: the first one not finished, or the last when all are. */
export function focusTask(detail: WorkDetail): string | null {
  const open = detail.tasks.find((task) => !FINISHED_STATUSES.has(task.status))
  return (open ?? detail.tasks[detail.tasks.length - 1])?.id ?? null
}

// ── Search ───────────────────────────────────────────────────────────────────────────────

const HIT_KINDS: Record<SearchHit['kind'], string> = {
  message: 'Message',
  work: 'Delivery',
  task: 'Task',
  attempt: 'Attempt',
  reference: 'Reference',
}

export interface SearchRowView {
  key: string
  title: string
  detail: string
  hit: SearchHit
}

export function searchRows(hits: readonly SearchHit[]): readonly SearchRowView[] {
  return hits.map((hit) => ({
    key: `${hit.kind}:${hit.id}`,
    title: hit.title,
    detail: `${HIT_KINDS[hit.kind]} in ${hit.repoLabel ?? UNASSIGNED}`,
    hit,
  }))
}

export interface SearchTarget {
  route: 'chat' | 'work'
  workItemId: string | null
  taskId: string | null
}

/**
 * Where a result goes. It has no field for the composer: choosing one never changes a send target.
 * So a message in another repository opens its work, because reaching its thread would move the
 * composer to that repository. `activeRepository` is that repository's served label.
 */
export function searchTarget(hit: SearchHit, activeRepository?: string | null): SearchTarget {
  const here = activeRepository === undefined || hit.repoLabel === activeRepository
  return {
    route: hit.kind === 'message' && here ? 'chat' : 'work',
    workItemId: hit.workItemId,
    taskId: hit.kind === 'task' ? hit.id : null,
  }
}
