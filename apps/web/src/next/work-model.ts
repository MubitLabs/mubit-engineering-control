import type { TaskProgress, TaskRowProps } from './Conversation'
import type { ApprovalProps, DecisionStatus, QuestionProps } from './Decision'
import { timeLabel } from './format'
import type { ArtifactLinkView, Fact, InspectorChecks, InspectorScope } from './Inspector'
import type {
  ActivityItem,
  AgreementItem,
  ArtifactPage,
  AttemptView,
  CardEvidence,
  CardItem,
  ChatLine,
  DelegationRow,
  DeliveryView,
  MetaAnswer,
  NeedItem,
  Page,
  QuestionItem,
  SearchHit,
  TaskDetail,
  WorkDetail,
  WorkNeedItem,
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

/** What a page may call current: nothing on it has failed since it was last read. */
export const readsCurrent = (reads: readonly Read<unknown>[]): boolean =>
  reads.every((read) => read.status !== 'failed')

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

/**
 * With one repository and nothing unassigned, All and that repository are the same list, and the
 * sidebar already names it. A second repository or Unassigned history is a real choice.
 */
export const repoScopeApplies = (options: readonly RepoFilterOption[]): boolean => options.length > 2

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

/**
 * What the row beside Hold and Stop can do. Each kind is a command the live layer runs: a new one
 * is a new member here and one more entry in `workActions`.
 */
export type WorkAction =
  | { kind: 'retry' | 'hold' | 'lift' | 'stop'; label: string; workItemId: string; repoId: string }
  | {
      kind: 'merge'
      label: string
      workItemId: string
      repoId: string
      repo: string
      prNumber: number
    }

/** The item's own id and repository, whatever the filter says. A filter only changes the wording. */
const whereLabel = (row: WorkRow, filter: RepoFilter | null): string =>
  filter?.kind === 'all' ? ` in ${row.repoLabel ?? row.repoId}` : ''

/** A delivery's retry asks you again; it never says the thing itself will happen. */
const RETRY_LABELS: Record<NonNullable<WorkDetail['retry']>['kind'], string> = {
  integration: 'Retry integration',
  push: 'Ask to push again',
  pr: 'Ask to open the pull request again',
  // One fresh repair attempt on blocked work: the owner asks, MEC runs it once.
  repair: 'Try again',
}

/** §14: only a ready pull request, only asked once, and never on work the owner holds. */
function mergeAction(
  row: WorkRow,
  repoId: string,
  held: boolean,
  delivery: DeliveryView | undefined,
  where: string,
): WorkAction[] {
  if (delivery === undefined || delivery.stage !== 'pr-ready' || held) return []
  const { repo, prNumber, mergeCardId } = delivery
  if (repo === null || prNumber === null || mergeCardId !== null) return []
  const label = `Merge pull request #${prNumber}${where}`
  return [{ kind: 'merge', label, workItemId: row.id, repoId, repo, prNumber }]
}

export function workActions(
  row: WorkRow,
  filter: RepoFilter,
  hold: WorkDetail['hold'],
  retry: WorkDetail['retry'] = null,
  delivery?: DeliveryView,
): readonly WorkAction[] {
  const { repoId } = row
  if (repoId === null || row.readOnly || ended(row)) return []
  const where = whereLabel(row, filter)
  const held = hold !== null || stageGroup(row) === 'held'
  return [
    ...(retry === null || held
      ? []
      : [
          {
            kind: 'retry' as const,
            label: `${RETRY_LABELS[retry.kind]}${where}`,
            workItemId: row.id,
            repoId,
          },
        ]),
    ...mergeAction(row, repoId, held, delivery, where),
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
  if (detail.delivery.failure !== null) return `Delivery failed: ${detail.delivery.failure}`
  if (!detail.coverage.delivery) return 'Delivery is not recorded yet'
  const { stage, prNumber } = detail.delivery
  const label = DELIVERY_LABELS[stage]
  const line = prNumber !== null ? `${label}, pull request #${prNumber}` : label
  // A blocked item already shows its reason; a declined card leaves the work in its working group.
  return detail.retry === null || detail.retry.kind === 'integration' || detail.retry.kind === 'repair'
    ? line
    : `${line}. ${detail.retry.reason}`
}

const CI_WORDS: Record<NonNullable<DeliveryView['ci']>, string> = {
  passing: 'GitHub reports the required checks passed.',
  'none-required':
    'GitHub reports no required checks, so only local checks ran. A merge card stays held until you decide for this repository.',
  running: 'GitHub’s required checks are still running.',
  failing: 'A required check failed on GitHub.',
  unreadable: 'GitHub’s checks could not be read.',
}

/** What GitHub said and when. Nothing here reads a state in: no reading is no reading. */
function ciLine({ ci, ciReadAt, prNumber }: DeliveryView): string | null {
  if (ci === null) return prNumber === null ? null : 'GitHub’s checks have not been read yet.'
  return ciReadAt === null ? CI_WORDS[ci] : `${CI_WORDS[ci]} Read ${timeLabel(ciReadAt)}.`
}

export interface DeliverySection {
  label: string
  ci: string | null
  failure: string | null
  /** Set while a merge card is open. */
  waiting: string | null
  /** Only a web address: a stored value never becomes a link by being stored. */
  prUrl: string | null
  prLabel: string | null
}

function deliverySection(detail: WorkDetail): DeliverySection {
  const { delivery } = detail
  const { prNumber, prUrl } = delivery
  const link = prUrl?.startsWith('https://') ? prUrl : null
  return {
    label: deliveryLabel(detail),
    ci: ciLine(delivery),
    failure: delivery.failure,
    waiting:
      delivery.mergeCardId === null
        ? null
        : 'The merge card is waiting in Needs you. Nothing merges until you approve it.',
    prUrl: link,
    prLabel: link === null || prNumber === null ? null : `Open pull request #${prNumber}`,
  }
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

/** Who holds one task, shown without opening it. */
export interface DelegationView {
  taskId: string
  title: string
  stateLabel: string
  /** Role, connection, engine, the tier asked for and the model that ran, in a sentence. */
  who: string
  why: string
  attempts: string
  activity: string | null
}

function assignment(row: DelegationRow): string {
  const actual = row.latest?.actual ?? null
  const role = row.role ?? 'No role recorded'
  const engine = actual?.engine ? ` (${actual.engine})` : ''
  const where = actual?.slotLabel ? `${role} on ${actual.slotLabel}${engine}` : `${role}, no connection yet`
  const asked = row.requested.tier ?? row.requested.model
  const ran = actual?.model ? `ran ${actual.model}` : row.latest === null ? null : 'model not recorded yet'
  return [where, asked === null ? null : `asked for ${asked}`, ran].filter((part) => part !== null).join(', ')
}

/** The server words the wait; a blocked task says Blocked, and an "until" reads as a sentence. */
function waitingWhy(row: DelegationRow): string {
  const { waiting } = row
  if (waiting === null || waiting === '') return 'No reason recorded'
  if (row.status === 'blocked') return `Blocked: ${waiting}`
  return waiting.startsWith('until ') ? `Waiting ${waiting}` : `Waiting: ${waiting}`
}

function delegationView(row: DelegationRow): DelegationView {
  const { latest } = row
  return {
    taskId: row.taskId,
    title: row.title,
    stateLabel: taskLabel(row.status).label,
    who: assignment(row),
    why: latest?.placement ? `Why here: ${latest.placement}` : waitingWhy(row),
    attempts:
      latest === null
        ? 'Not started'
        : `${row.attempts} ${row.attempts === 1 ? 'attempt' : 'attempts'}, latest ${latest.state}`,
    activity: row.activity && `Last step: ${row.activity.summary}, ${timeLabel(row.activity.at)}`,
  }
}

export type TurnOutcomeView = { kind: 'answered'; text: string } | { kind: 'no-answer'; text: string }

const NO_ANSWER = 'The meta agent stopped without answering.'

function turnOutcome(detail: WorkDetail): TurnOutcomeView | null {
  if (detail.turnOutcome === null) return null
  return detail.turnOutcome === 'answered'
    ? { kind: 'answered', text: detail.answer ?? NOT_RECORDED }
    : { kind: 'no-answer', text: `${NO_ANSWER} Ask again in Conversation.` }
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
  /** Read only from `delegation`: every task, whoever holds it. */
  delegation: readonly DelegationView[]
  /** Set on a request that never was delivery work. Nothing else here applies to it. */
  outcome: TurnOutcomeView | null
  delivery: DeliverySection
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
      // Delivery is about tasks. With none it cannot apply, so it says nothing.
      footnote: count === 0 ? '' : deliveryLabel(detail),
    },
    dependencies: detail.tasks
      .filter((task) => task.dependsOn.length > 0)
      .map((task) => ({
        task: task.title,
        on: task.dependsOn.map((id) => titles.get(id) ?? id),
        ...(task.dependsOnTruncated > 0 && { more: task.dependsOnTruncated }),
      })),
    delegation: detail.delegation.map(delegationView),
    outcome: turnOutcome(detail),
    delivery: deliverySection(detail),
    actions: workActions(detail, filter ?? { kind: 'all' }, detail.hold, detail.retry, detail.delivery),
    discuss: discussAction(detail, filter),
  }
}

// ── Inspector ────────────────────────────────────────────────────────────────────────────

/** Evidence on a commit exists only once the task has stopped moving. */
const FINISHED_TASKS = new Set(['awaiting_review', 'accepted', 'integrated'])

const short = (sha: string) => sha.slice(0, 7)
const COMMIT_ID = /^[0-9a-f]{7,64}$/

export function latestAttempt(attempts: readonly AttemptView[]): AttemptView | null {
  return attempts.reduce<AttemptView | null>(
    (latest, attempt) => (latest === null || attempt.generation >= latest.generation ? attempt : latest),
    null,
  )
}

/** What the Activity tab has read of one attempt. `tail` is the cursor of the last page read. */
export interface ActivityPages {
  items: readonly ActivityItem[]
  tail: string | null
  nextCursor: string | null
}

export type ArtifactPages = ArtifactPage

export interface OpenArtifact {
  attemptId: string
  ref: string
  read: Read<ArtifactPages>
}

/** The reads behind a task's Activity tab and artifacts, and what the page does with them. */
export interface TaskEvidence {
  attemptId: string | null
  activity: Read<ActivityPages>
  artifact: OpenArtifact | null
  onAttempt: (id: string) => void
  onMore: () => void
  onRetry: () => void
  onArtifact: (attemptId: string, ref: string) => void
  onArtifactMore: () => void
  onArtifactRetry: () => void
}

const ACTIVITY_NOTE =
  'What this attempt recorded, oldest first. A line appears once a step has finished, so this does not show what is running now.'

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const staleNote = (message: string, readAt: string | null): string =>
  `${message} What is shown may be out of date.${readAt ? ` Last read ${timeLabel(readAt)}.` : ''}`

function artifactPanel(read: Read<ArtifactPages>, evidence: TaskEvidence): ArtifactLinkView['panel'] {
  if (read.status === 'loading') return { note: 'Reading this file', text: null }
  const { data } = read
  const retry = { label: 'Retry', onClick: evidence.onArtifactRetry }
  if (data === null) {
    return { note: read.status === 'failed' ? read.message : NOT_RECORDED, text: null, action: retry }
  }
  if (data.kind === 'binary') {
    return { note: `Binary file, ${sizeLabel(data.size)}. Its contents are not shown.`, text: null }
  }
  if (read.status === 'failed') {
    return { note: staleNote(read.message, read.readAt), text: data.text, action: retry }
  }
  return {
    note: `${sizeLabel(data.size)}. Read ${timeLabel(read.readAt)}.`,
    text: data.text,
    ...(data.nextCursor !== null && {
      action: { label: 'Show more', onClick: evidence.onArtifactMore },
    }),
  }
}

function artifactLink(
  attemptId: string,
  ref: string,
  label: string,
  evidence: TaskEvidence,
): ArtifactLinkView {
  const { artifact } = evidence
  const open = artifact?.attemptId === attemptId && artifact.ref === ref ? artifact : null
  return {
    label,
    open: open !== null,
    onToggle: () => evidence.onArtifact(attemptId, ref),
    panel: open === null ? null : artifactPanel(open.read, evidence),
  }
}

/** Only a report names artifacts. The server cuts a long detail, and a cut one names none. */
function reportArtifacts(item: ActivityItem): { kind: string; ref: string }[] {
  if (item.type !== 'report' || item.detail === null) return []
  let body: unknown
  try {
    body = JSON.parse(item.detail)
  } catch {
    return []
  }
  const artifacts = (body as { report?: { artifacts?: unknown } } | null)?.report?.artifacts
  if (!Array.isArray(artifacts)) return []
  return artifacts.flatMap((entry: { kind?: unknown; ref?: unknown } | null) =>
    typeof entry?.kind === 'string' && typeof entry.ref === 'string'
      ? [{ kind: entry.kind, ref: entry.ref }]
      : [],
  )
}

/** A line says what the record says. A `tool_call` is a finished call and earns no state here. */
function activityEntry(item: ActivityItem, attemptId: string, evidence: TaskEvidence) {
  return {
    key: String(item.seq),
    when: timeLabel(item.at),
    text: item.summary,
    detail: item.detail === item.summary ? null : item.detail,
    artifacts: reportArtifacts(item).map(({ kind, ref }) =>
      artifactLink(attemptId, ref, `${kind}: ${ref}`, evidence),
    ),
  }
}

function taskActivity(detail: TaskDetail, evidence?: TaskEvidence): InspectorScope['activity'] {
  if (!detail.coverage.activity) return { note: NOT_RECORDED, entries: [] }
  if (evidence === undefined || evidence.attemptId === null) {
    return {
      note: `Attempts recorded for this task${leftOut(detail.attemptsTruncated, 'older attempts')}.`,
      entries: detail.attempts.map((entry) => ({
        when: entry.lastActivityAt ? timeLabel(entry.lastActivityAt) : NOT_RECORDED,
        text: `Attempt ${entry.generation}: ${entry.state}`,
      })),
    }
  }
  const { attemptId, activity: read } = evidence
  const chooser =
    detail.attempts.length > 1
      ? {
          attempts: detail.attempts.map((entry) => ({
            id: entry.id,
            label: `Attempt ${entry.generation}: ${entry.state}`,
            selected: entry.id === attemptId,
            onSelect: () => evidence.onAttempt(entry.id),
          })),
        }
      : {}
  if (read.status === 'loading') {
    return { note: 'Reading this attempt’s activity', entries: [], ...chooser }
  }
  const { data } = read
  const entries = (data?.items ?? []).map((item) => activityEntry(item, attemptId, evidence))
  if (read.status === 'failed') {
    return {
      note: data === null ? read.message : staleNote(read.message, read.readAt),
      entries,
      retry: { label: 'Retry', onClick: evidence.onRetry },
      ...chooser,
    }
  }
  const nextCursor = data?.nextCursor ?? null
  return {
    note:
      entries.length > 0 || nextCursor !== null ? ACTIVITY_NOTE : 'Nothing recorded for this attempt yet.',
    entries,
    ...(nextCursor !== null && { more: { label: 'Show more', onClick: evidence.onMore } }),
    ...chooser,
  }
}

/** The attempt's stream at the delivery's cursor. Cut from the cursors, it stays on the 10 s read. */
export function attemptSubscription(
  attemptId: string | null,
  cursors: Readonly<Record<string, number>>,
): { stream: string; after: number } | null {
  if (attemptId === null) return null
  const stream = `attempt:${attemptId}`
  const after = cursors[stream]
  return after === undefined ? null : { stream, after }
}

function taskChecks(detail: TaskDetail, head: string | null, evidence?: TaskEvidence): InspectorChecks {
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
  const owner = latestAttempt(detail.attempts.filter((entry) => entry.headSha === head))
  return {
    state: failed ? 'failed' : 'passed',
    heading: failed ? 'Checks failed on this commit' : 'Checks passed on this commit',
    detail: `Results for ${short(head)} only${leftOut(detail.checks.truncated, 'more results')}.`,
    results: decided.map((result) => ({
      label: result.name,
      detail: result.detail ?? '',
      passed: result.state === 'passed',
      ...(evidence !== undefined &&
        owner !== null &&
        result.artifactRef !== null && {
          artifact: artifactLink(owner.id, result.artifactRef, result.artifactRef, evidence),
        }),
    })),
  }
}

const fileLines = (file: TaskDetail['diff']['files'][number]) => ({
  path: file.path,
  lines: [file.binary === true ? 'Binary file' : `+${file.added} -${file.removed}`],
})

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

export function taskScope(detail: TaskDetail, workTitle: string, evidence?: TaskEvidence): InspectorScope {
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
    checks: taskChecks(detail, head, evidence),
    activity: taskActivity(detail, evidence),
    diff: detail.coverage.diff
      ? {
          summary: `${detail.diff.summary ?? NOT_RECORDED}${leftOut(detail.diff.truncated, 'more files')}`,
          files: detail.diff.files.map(fileLines),
        }
      : {
          summary:
            head === null
              ? NOT_RECORDED
              : `Commit ${short(head)} is on record, but its file changes could not be read.`,
          files: [],
        },
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
  evidence?: TaskEvidence,
): InspectorScope | null {
  if (read.status === 'loading') return pendingScope(taskId, workTitle, 'Reading this task')
  const { data } = read
  if (data === null) return pendingScope(taskId, workTitle, read.status === 'failed' ? read.message : '')
  if (data.id !== taskId || data.workItemId !== workId) return null
  const scope = taskScope(data, workTitle, evidence)
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

function needAge(item: NeedItem): string {
  if (item.kind === 'agreement') return ''
  if (item.kind === 'question') return item.askedAt ?? ''
  return item.kind === 'work' ? item.since : item.expiresAt
}

/**
 * A card can carry a repository's label and no id, and a label cannot be matched to a registered
 * repository. An open one stays under every filter, labelled as itself, because nothing waiting
 * on a person may be hidden. A settled one follows the filter, so it never reads as another's.
 */
function needInFilter(item: NeedItem, filter: RepoFilter): boolean {
  return inFilter(item, filter) || (isOpen(item) && item.repoId === null && item.repoLabel !== null)
}

/** One list, one filter: the sidebar count and the page are the same array. */
export function needsList(
  read: Read<Page<NeedItem>>,
  rows: readonly WorkRow[],
  filter: RepoFilter,
): NeedsList {
  const items = (readData(read)?.items ?? []).filter((item) => needInFilter(item, filter))
  const byId = new Map(rows.map((row) => [row.id, row]))
  const downstream = (item: NeedItem) => tasksWaiting(byId.get(item.workItemId ?? ''))
  const waiting = items
    .filter(isOpen)
    .sort((a, b) => downstream(b) - downstream(a) || needAge(a).localeCompare(needAge(b)))
  const settled = items.filter((item) => !isOpen(item))
  const partial = readData(read)?.nextCursor != null
  // Work with no repository is listed, and cannot be cleared here, so it asks nothing of the count.
  const counted = waiting.filter((item) => item.kind !== 'work' || !item.readOnly).length
  return { count: read.status === 'ready' && !partial ? counted : null, waiting, settled, partial }
}

export const needsCount = (list: NeedsList): number | null => list.count

const CARD_LABELS: Record<string, string> = {
  push: 'Push approval',
  pr_create: 'Pull request approval',
  pr_merge: 'Merge approval',
  slot_switch: 'Switch approval',
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
  /** A settled card whose evidence did not arrive. An open one has its own way back. */
  retryEvidence: boolean
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
  /** The commit the card is bound to, on its face: the full id stays in the inspector. */
  const head = evidence?.facts.find((fact) => fact.label === 'Head')?.value ?? ''
  const commit = COMMIT_ID.test(head) ? head : null
  return {
    id: item.id,
    label: cardLabel(item.cls),
    title: evidence?.what ?? cardLabel(item.cls),
    summary:
      evidence?.why ??
      (served === null
        ? 'The evidence for this card has not loaded.'
        : 'The workbench holds no evidence for this card.'),
    evidence: [
      { label: 'Repository', value: repository },
      ...(evidence?.facts.filter((f) => !f.mono) ?? []),
      ...(commit === null ? [] : [{ label: 'Commit', value: short(commit), mono: true }]),
    ].filter((fact, index, all) => all.findIndex((other) => other.label === fact.label) === index),
    status: cardStatus(item, outcome),
    approveLabel: 'Approve',
    confirmLabel: `Confirm: ${verb} in ${repository}`,
    denyLabel: 'Deny',
    denyConfirmLabel: `Confirm: deny in ${repository}`,
    consequences: evidence
      ? [
          { heading: 'On approve', body: evidence.consequences.approve },
          { heading: 'On deny', body: evidence.consequences.deny },
        ]
      : [],
    canApprove: evidence !== null,
    actionable: !unassigned(item),
    hold: outcome !== null && !outcome.closes && item.status === 'pending' ? outcome.toast : null,
    retryEvidence: served === null && item.status !== 'pending',
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

/** Blocked work, or a review waiting: there is no answer to give here, only the work to open. */
export interface WorkNeedView {
  id: string
  title: string
  body: string
  repository: string
  workItemId: string
  actionable: boolean
}

/** Why, then what next. `.` closes both, and a served sentence does not end up with two. */
function sentences(...parts: readonly (string | null)[]): string {
  return parts
    .flatMap((part) => (part === null ? [] : [part.replace(/\.$/, '')]))
    .map((part) => `${part}.`)
    .join(' ')
}

const whyAndNext = (reason: string | null, next: string | null): string =>
  reason === null && next === null
    ? 'No reason was recorded.'
    : sentences(reason, next === null ? null : `Next: ${next}`)

function workNeedProps(item: WorkNeedItem): WorkNeedView {
  return {
    id: item.id,
    title: `${item.title}: ${item.stageLabel}`,
    body: whyAndNext(item.reason, item.nextAction),
    repository: repositoryOf(item),
    workItemId: item.workItemId,
    actionable: !item.readOnly,
  }
}

export interface AgreementView {
  id: string
  title: string
  body: string
}

/** Nothing to approve here: the words of the agreement belong to Settings, with the owner reading them. */
function agreementProps(item: AgreementItem): AgreementView {
  const items = item.waiting === 1 ? '1 item' : `${item.waiting} items`
  return {
    id: item.id,
    title: `Waiting for your agreement: ${repositoryOf(item)}`,
    body: `${items} cannot start until you agree that this repository may run on this machine.`,
  }
}

export type NeedCard =
  | { kind: 'question'; view: QuestionView }
  | { kind: 'card'; view: ApprovalView }
  | { kind: 'work'; view: WorkNeedView }
  | { kind: 'agreement'; view: AgreementView }

/** A question is one record wherever it shows (§12.6, §18.2): both places read this same view. */
export function needCard(
  item: NeedItem,
  evidence: (id: string) => CardEvidence | null,
  cardOutcome: (id: string) => ApprovalOutcome | null,
  answerOutcome: (id: string) => AnswerOutcome | null,
): NeedCard {
  if (item.kind === 'work') return { kind: 'work', view: workNeedProps(item) }
  if (item.kind === 'agreement') return { kind: 'agreement', view: agreementProps(item) }
  return item.kind === 'question'
    ? { kind: 'question', view: questionProps(item, answerOutcome(item.id)) }
    : { kind: 'card', view: approvalProps(item, evidence(item.id), cardOutcome(item.id)) }
}

/** Open questions, and any this page answered, so an answer never just removes the card. */
export function threadQuestions(
  items: readonly NeedItem[],
  repoId: string | null,
  answerOutcome: (id: string) => AnswerOutcome | null,
): readonly QuestionView[] {
  return items.flatMap((item) => {
    if (item.kind !== 'question' || item.repoId !== repoId) return []
    const outcome = answerOutcome(item.id)
    const view = questionProps(item, outcome)
    return view.status.state === 'open' || outcome !== null ? [view] : []
  })
}

// ── Conversation ─────────────────────────────────────────────────────────────────────────

export type ConversationEntry = { id: string; kind: 'user' | 'agent' | 'note'; text: string }

/** One open delivery in the conversation: what it is and where it stands. */
export interface OpenWorkView {
  id: string
  title: string
  stageLabel: string
  tone: StatusTone
  reason: string | null
}

/** The live line. Only what the server read says; a send is the one thing the page knows first. */
export interface MetaStatusView {
  headline: string
  connection: string
  when: string
  tone: StatusTone
  /** Worth reading again soon: something is moving. */
  active: boolean
}

function connectionLabel(connection: MetaAnswer['connection']): string {
  if (connection === null) return 'No meta connection chosen'
  const engine = connection.engine ? ` (${connection.engine})` : ''
  const slot = `${connection.slotLabel ?? 'Unnamed connection'}${engine}`
  return connection.model ? `${connection.model} on ${slot}` : `${slot}, model not recorded yet`
}

export function metaStatus(
  read: Read<MetaAnswer>,
  repoId: string | null,
  sending: boolean,
): MetaStatusView | null {
  const data = readData(read)
  const row = data?.repositories.find((entry) => entry.repoId === repoId)
  const connection = data === null ? '' : connectionLabel(data.connection)
  if (sending && row?.running !== true) {
    return { headline: 'Sending your request', connection, when: 'Just now', tone: 'neutral', active: true }
  }
  if (repoId === null || (data !== null && row === undefined)) return null
  if (read.status === 'failed') {
    return {
      headline: 'Could not read what the meta agent is doing',
      connection,
      when: read.readAt ? `Last read ${timeLabel(read.readAt)}` : 'Not read yet',
      tone: 'bad',
      active: false,
    }
  }
  if (row === undefined) return null
  const label = row.running ? 'Started' : 'Last event'
  return {
    headline: row.line,
    connection,
    when: row.at === null ? 'No events yet' : `${label} ${timeLabel(row.at)}`,
    tone: row.state === 'waiting_you' || row.state === 'blocked' ? 'attention' : 'neutral',
    active: row.running || row.state === 'queued',
  }
}

/** The stored message is the one to show: an echo of it would say everything twice. */
export const sentAlready = (lines: readonly ChatLine[], key: string): boolean =>
  lines.some((line) => line.idempotencyKey === key)

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
  /** Open deliveries besides the one the plan shows. */
  open: readonly OpenWorkView[]
  /** Work in this repository that stopped on a blocker. A quiet plan card is no way to learn it. */
  blocked: readonly { id: string; title: string; body: string }[]
}

/** §12.7: an acknowledgement can name work by id, and an id is not for the owner to read. */
function withTitles(text: string, work: readonly WorkRow[]): string {
  return work.reduce((line, row) => (row.title === null ? line : line.replaceAll(row.id, row.title)), text)
}

/** A turn no person started (§6): the id is the server's own, and no text a person sends can make it. */
const isWake = (line: ChatLine): boolean => line.id.startsWith('msg_wake_')

/**
 * Acknowledgement, plan and quiet progress. A stored message has no kind and is the person's; any
 * other unknown kind is a trace, and traces stay out (§18.1). A wake also has no kind, and its row
 * only holds the planner's reply: its text is why the turn ran, so only the reply shows.
 */
export function conversationView(input: {
  row: WorkRow | null
  detail: WorkDetail | null
  messages: readonly ChatLine[]
  work?: readonly WorkRow[]
  /** The stable heading: a request's title reads wrongly the moment a newer one arrives. */
  repository?: string | null
  /** Open deliveries to list. */
  open?: readonly WorkRow[]
  /** Processing is paused now. A message's held acknowledgement is only true while it is. */
  paused?: boolean
}): ConversationViewModel {
  const work = input.work ?? []
  const delivery = input.detail ? deliveryDetail(input.detail, null) : null
  const said = (line: ChatLine): ConversationEntry[] => {
    const { ackText } = line
    const text = ackText ?? (input.paused === true ? line.pausedAck : undefined)
    const ack =
      text === undefined
        ? []
        : [{ id: `${line.id}:ack`, kind: 'agent' as const, text: withTitles(text, work) }]
    const owner = work.find((row) => row.id === line.workItemId)
    const lost =
      ackText !== undefined && owner?.turnOutcome === 'no-answer'
        ? [
            {
              id: `${line.id}:lost`,
              kind: 'note' as const,
              text: `${NO_ANSWER} Ask again.${owner.lastActivityAt ? ` Last event ${timeLabel(owner.lastActivityAt)}.` : ''}`,
            },
          ]
        : []
    return [...ack, ...lost]
  }
  const entries = input.messages.flatMap((line): ConversationEntry[] => {
    const ack = said(line)
    if (isWake(line)) return ack
    const kind = line.kind === null ? 'user' : ENTRY_KINDS[line.kind]
    if (kind === undefined) return []
    const text = kind === 'user' ? line.text : withTitles(line.text, work)
    return [
      { id: line.id, kind, text },
      ...ack,
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
  const assigned = new Map(input.detail?.delegation.map((row) => [row.taskId, assignment(row)]))
  return {
    title: input.repository ?? 'Conversation',
    entries,
    plan:
      delivery === null
        ? null
        : {
            ...delivery.plan,
            tasks: delivery.plan.tasks.map((task) => ({
              ...task,
              detail: assigned.get(task.id) ?? task.detail,
            })),
          },
    discuss: delivery?.discuss ?? null,
    open: (input.open ?? []).map((row) => {
      const view = workRowView(row)
      return {
        id: view.id,
        title: view.title,
        stageLabel: view.stageLabel,
        tone: view.tone,
        reason: view.reason,
      }
    }),
    blocked: work
      .filter(
        (row) => input.row !== null && row.repoId === input.row.repoId && row.stage.key === 'person/blocked',
      )
      .map((row) => ({
        id: row.id,
        title: `${row.title ?? 'Untitled request'} is ${row.stage.label.toLowerCase()}`,
        body: whyAndNext(row.reason, row.nextAction),
      })),
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
