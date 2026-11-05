/**
 * Canonical inspection, stage 1 (M3.1; plan §10, §17, §18, §22): read-only `GET /api/inspect/*`
 * routes that serve any repository's work, tasks, open decisions and search results through bounded
 * keyset pages. The wire shapes are the contract `31` builds against; this file is where records
 * become those shapes.
 *
 * Rules held here, each with a test:
 * - Nothing is invented. A record the system has not stored yet is `null`, `[]` or `coverage: false`,
 *   never zero. The stage is computed from facts (`stageOf`), never stored.
 * - A row with no `repoId` is Unassigned: `repoId: null`, `repoLabel: null`, `readOnly: true`. A
 *   repository is never inferred from a path, a title or a branch name.
 * - A card joins to work only through a stored `workItemId` or `mandateId`. Never by branch.
 * - Every string leaves through `redactText`, after any cut, so a cut cannot leave half a secret.
 * - A page is at most 100 rows and 1 MiB of JSON, and ends early with a valid cursor.
 */

import type { Json, Store, StoreDoc } from '@mec/contracts'
import { type Stage, stageOf, type WorkItemView } from '@mec/domain'
import { assertRepoAdmission } from '@mec/meta'
import { redact } from '@mec/slots'
import {
  CursorError,
  DEFAULT_PAGE_LIMIT,
  decodeCursor,
  encodeCursor,
  type InspectionReads,
  MAX_PAGE_BYTES,
  MAX_PAGE_LIMIT,
} from '@mec/store'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

// ── The wire shape (handoff 30, "The wire shape") ────────────────────────────────────────────

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
  delegation: { parentAttemptId: string; childAttemptId: string }[]
  delivery: DeliveryView
  coverage: Coverage
  cursors: Record<string, number>
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
  processOutcome: string
  lastActivityAt: string | null
}

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
  checks: { headSha: string | null; results: CheckView[] }
  diff: {
    headSha: string | null
    summary: string | null
    files: { path: string; added: number; removed: number }[]
  }
  usage: { reportedUsd: number | null; missingAttempts: number; mode: 'api' | 'subscription' | 'unknown' }
  coverage: Coverage
}

export type NeedItem =
  | {
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
  | {
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

export type SearchHit = {
  kind: 'message' | 'work' | 'task' | 'attempt' | 'reference'
  id: string
  title: string
  repoLabel: string | null
  workItemId: string | null
}

// ── Redaction at the boundary ────────────────────────────────────────────────────────────────

/** The one place text is redacted (§17, §22). No fingerprints or exact keys: a second line of defence. */
const redactText = (text: string): string => redact(text, [], [])

/** Redacts every string in a response, keys excluded. */
function scrub<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T
  if (Array.isArray(value)) return value.map((entry) => scrub(entry)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)])) as T
  }
  return value
}

/** Redact first, then cut: a cut must never leave the front half of a key that no longer matches. */
const cutText = (text: string, max: number): string => redactText(text).slice(0, max)

// ── Small readers over loosely typed docs ────────────────────────────────────────────────────

const str = (value: Json | undefined): string | null => (typeof value === 'string' ? value : null)
const num = (value: Json | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const obj = (value: Json | undefined): Record<string, Json> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null
const strings = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const firstLine = (text: string): string | null => {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return null
}

const repoIdOf = (doc: StoreDoc | undefined): string | null => (doc === undefined ? null : str(doc.repoId))

/** `acme/alpha` for a remote, the last path segment for a local path. */
export function repoLabelFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '')
  const segments = (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? new URL(trimmed).pathname : trimmed)
    .split(/[\\/]/)
    .filter((segment) => segment !== '')
  const clean = segments.map((segment, i) =>
    i === segments.length - 1 ? segment.replace(/\.git$/i, '') : segment,
  )
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? clean.slice(-2).join('/') : (clean.at(-1) ?? trimmed)
}

class BadRequest extends Error {}

// ── The inspector ────────────────────────────────────────────────────────────────────────────

const QUESTION_PREFIX = 'question/'
const REPO_PREFIX = 'repo_'
/** An open set is naturally small (cards expire, questions get answered); this only bounds the pathological case. */
const OPEN_CAP = 200
const RECENT_CAP = 20
const TASK_CAP = 200
const SNAPSHOT_STREAM_CAP = 100
const SEARCH_CAP = 20
/** Headroom for the envelope fields around a page's items. */
const ENVELOPE_BYTES = 1024

type InspectDeps = { store: Store; reads: InspectionReads; now: () => Date }

class Inspector {
  readonly #store: Store
  readonly #reads: InspectionReads
  readonly #now: () => Date
  readonly #labels = new Map<string, string | null>()

  constructor(deps: InspectDeps) {
    this.#store = deps.store
    this.#reads = deps.reads
    this.#now = deps.now
  }

  observedAt(): string {
    return this.#now().toISOString()
  }

  // ── repositories ──

  repoLabel(repoId: string | null): string | null {
    if (repoId === null) return null
    if (!this.#labels.has(repoId)) {
      const url = str(this.#store.engines.get(repoId)?.url)
      let label: string | null = null
      if (url !== null) {
        try {
          label = cutText(repoLabelFromUrl(url), 80)
        } catch {
          label = null
        }
      }
      this.#labels.set(repoId, label)
    }
    return this.#labels.get(repoId) ?? null
  }

  repositories(): { id: string; label: string | null }[] {
    const page = this.#reads.pageDocs('engine', { idPrefix: REPO_PREFIX, limit: MAX_PAGE_LIMIT })
    return page.rows.map((row) => ({ id: String(row.doc.id), label: this.repoLabel(String(row.doc.id)) }))
  }

  // ── needs: open questions and pending cards ──

  #collect(kind: string, options: Parameters<InspectionReads['pageDocs']>[1], cap: number): StoreDoc[] {
    const docs: StoreDoc[] = []
    let cursor: string | null = null
    do {
      const page: ReturnType<InspectionReads['pageDocs']> = this.#reads.pageDocs(kind, {
        ...options,
        limit: MAX_PAGE_LIMIT,
        cursor,
      })
      docs.push(...page.rows.map((row) => row.doc))
      cursor = page.nextCursor
    } while (cursor !== null && docs.length < cap)
    return docs.slice(0, cap)
  }

  #workRepo(workItemId: string | null): string | null {
    return workItemId === null ? null : repoIdOf(this.#store.workItems.get(workItemId))
  }

  #questionItem(doc: StoreDoc): NeedItem {
    const workItemId = str(doc.workItemId)
    const repoId = repoIdOf(doc) ?? this.#workRepo(workItemId)
    const stored = str(doc.status) ?? 'open'
    return {
      kind: 'question',
      id: str(doc.questionId) ?? String(doc.id).slice(QUESTION_PREFIX.length),
      repoId,
      repoLabel: this.repoLabel(repoId),
      workItemId,
      question: cutText(str(doc.question) ?? '', 2000),
      options: strings(doc.options)
        .slice(0, 20)
        .map((option) => cutText(option, 200)),
      status: stored === 'open' ? 'open' : stored === 'answered' ? 'answered' : 'expired',
      askedAt: str(doc.askedAt),
      answer: str(doc.answer) === null ? null : cutText(String(doc.answer), 2000),
    }
  }

  /** Cards join to work only through a stored workItemId or a mandateId some work item carries. */
  #cardItems(docs: StoreDoc[]): NeedItem[] {
    const mandateIds = [
      ...new Set(
        docs.filter((doc) => str(doc.workItemId) === null).flatMap((doc) => str(doc.mandateId) ?? []),
      ),
    ]
    const byMandate = new Map<string, string>()
    for (const work of this.#reads.docsByField('work_item', 'mandate.id', mandateIds)) {
      const mandateId = str(obj(work.mandate)?.id)
      if (mandateId !== null) byMandate.set(mandateId, String(work.id))
    }
    const nowIso = this.observedAt()
    return docs.map((doc): NeedItem => {
      const mandateId = str(doc.mandateId)
      const workItemId =
        str(doc.workItemId) ?? (mandateId === null ? null : (byMandate.get(mandateId) ?? null))
      const payload = obj(doc.payload)
      const repoId = repoIdOf(doc) ?? str(payload?.repoId) ?? this.#workRepo(workItemId)
      const expiresAt = str(doc.expiresAt) ?? ''
      const stored = str(doc.status) ?? 'pending'
      const status: Extract<NeedItem, { kind: 'card' }>['status'] =
        stored === 'pending'
          ? expiresAt !== '' && expiresAt <= nowIso
            ? 'expired'
            : 'pending'
          : stored === 'approved' || stored === 'denied' || stored === 'expired' || stored === 'stale'
            ? stored
            : 'stale'
      const id = String(doc.id)
      return {
        kind: 'card',
        id,
        repoId,
        repoLabel: (repoId === null ? null : this.repoLabel(repoId)) ?? str(payload?.repo),
        workItemId,
        cls: str(doc.cls) ?? '',
        status,
        expiresAt,
        detailPath: `/api/inbox/${id}/detail`,
      }
    })
  }

  /** Everything that needs a person now, all repositories, oldest first. The single source of every count. */
  openNeeds(): NeedItem[] {
    const questions = this.#collect(
      'engine',
      { idPrefix: QUESTION_PREFIX, equals: { status: 'open' } },
      OPEN_CAP,
    )
    const cards = this.#cardItems(this.#collect('confirmation', { equals: { status: 'pending' } }, OPEN_CAP))
    return [...questions.map((doc) => this.#questionItem(doc)), ...cards].filter(
      (item) => item.status === 'open' || item.status === 'pending',
    )
  }

  /** Recently settled and expired items, newest first. Never counted as needing anyone. */
  recentNeeds(): NeedItem[] {
    const settledQuestions = this.#reads
      .pageDocs('engine', { idPrefix: QUESTION_PREFIX, order: 'desc', limit: MAX_PAGE_LIMIT })
      .rows.map((row) => row.doc)
      .filter((doc) => (str(doc.status) ?? 'open') !== 'open')
    const cards = this.#cardItems(
      this.#reads
        .pageDocs('confirmation', { order: 'desc', limit: MAX_PAGE_LIMIT })
        .rows.map((row) => row.doc),
    ).filter((item) => item.kind === 'card' && item.status !== 'pending')
    return [...settledQuestions.map((doc) => this.#questionItem(doc)), ...cards].slice(0, RECENT_CAP * 2)
  }

  needs(repoId: string | undefined, recent: boolean): NeedItem[] {
    const scoped = (items: NeedItem[]): NeedItem[] =>
      repoId === undefined ? items : items.filter((item) => item.repoId === repoId)
    const open = scoped(this.openNeeds())
    return recent ? [...open, ...scoped(this.recentNeeds()).slice(0, RECENT_CAP)] : open
  }

  // ── work ──

  #titleOf(doc: StoreDoc): string | null {
    const stored = str(doc.title)
    if (stored !== null && stored.trim() !== '') return cutText(stored.trim(), 80)
    const originId = str(doc.originMessageId)
    const text = originId === null ? null : str(this.#store.messages.get(originId)?.text)
    const line = text === null ? null : firstLine(redactText(text))
    return line === null ? null : line.slice(0, 80)
  }

  #deliveryOf(doc: StoreDoc): DeliveryView {
    const stored = obj(doc.delivery)
    const stages: DeliveryView['stage'][] = [
      'none',
      'local-complete',
      'awaiting-push',
      'awaiting-pr',
      'pr-open',
      'pr-ready',
      'merged',
    ]
    const stage = stages.find((candidate) => candidate === stored?.stage) ?? 'none'
    return {
      stage,
      branch: str(stored?.branch),
      headSha: str(stored?.headSha),
      prNumber: num(stored?.prNumber),
      prUrl: str(stored?.prUrl),
    }
  }

  #viewOf(
    doc: StoreDoc,
    facts: { openQuestions: number; awaitingConfirmation: boolean; attempts: StoreDoc[] },
  ): WorkItemView {
    const hold = obj(doc.hold)
    const live = facts.attempts.filter((a) =>
      ['queued', 'running', 'quota_wait'].includes(str(a.state) ?? ''),
    )
    const parked = live.length > 0 && live.every((a) => a.state === 'quota_wait')
    const resets = live.flatMap((a) => str(a.resetsAt) ?? str(a.resetAt) ?? []).sort()
    return {
      state: str(doc.state) ?? 'admitted',
      openQuestions: facts.openQuestions,
      awaitingConfirmation: facts.awaitingConfirmation,
      holdStatus: hold !== null && str(hold.liftedAt) === null ? 'held' : 'free',
      // loginNeeded, latestReport, userMessageSinceReport and queued are not recorded yet (M2 writes
      // reports and capacity): absent facts cannot match their rows, so the item is never a person stage by guesswork.
      ...(parked && { quotaWait: resets[0] === undefined ? {} : { resetAt: resets[0] } }),
      merged: this.#deliveryOf(doc).stage === 'merged',
    }
  }

  #reasonAndAction(
    stage: Stage,
    doc: StoreDoc,
    facts: { openQuestions: number; awaitingConfirmation: boolean },
  ): { reason: string | null; nextAction: string | null } {
    switch (stage.key) {
      case 'person/decision':
        return facts.openQuestions > 0
          ? {
              reason: `${facts.openQuestions} open question${facts.openQuestions === 1 ? '' : 's'}`,
              nextAction: 'Answer the question',
            }
          : { reason: 'A confirmation is waiting for you', nextAction: 'Approve or deny the card' }
      case 'held': {
        const hold = obj(doc.hold)
        const why = str(hold?.reason)
        return {
          reason: `Held by you since ${str(hold?.at) ?? 'an unknown time'}${why === null ? '' : `: ${cutText(why, 200)}`}`,
          nextAction: 'Tell the meta agent to go ahead when ready',
        }
      }
      case 'person/blocked':
        return {
          reason:
            str(doc.blockedReason) === null
              ? 'Blocked'
              : `Blocked: ${cutText(String(doc.blockedReason), 200)}`,
          nextAction: 'Resolve what blocks it',
        }
      case 'waiting/quota':
        return { reason: 'Every runnable attempt is waiting for quota', nextAction: null }
      case 'working':
        return { reason: str(doc.state) === 'planning' ? 'Planning' : null, nextAction: null }
      default:
        return { reason: stage.key.startsWith('ended/') ? `Ended: ${stage.label}` : null, nextAction: null }
    }
  }

  /** The row for each doc. Every batch read below is one query for the whole page, not one per row. */
  workRows(docs: StoreDoc[], needs: NeedItem[]): WorkRow[] {
    const ids = docs.map((doc) => String(doc.id))
    const counts = this.#reads.countByField('task', 'workItemId', 'status', ids, 'ready')
    const lastAt = this.#reads.lastEventAt(ids.map((id) => `work:${id}`))
    const attempts = this.#groupBy(this.#reads.docsByField('attempt', 'workItemId', ids), 'workItemId')
    return docs.map((doc) => {
      const id = String(doc.id)
      const mine = needs.filter((item) => item.workItemId === id)
      const facts = {
        openQuestions: mine.filter((item) => item.kind === 'question').length,
        awaitingConfirmation: mine.some((item) => item.kind === 'card'),
      }
      const stage = stageOf(this.#viewOf(doc, { ...facts, attempts: attempts.get(id) ?? [] }))
      const byStatus = counts[id] ?? {}
      const repoId = repoIdOf(doc)
      return {
        id,
        title: this.#titleOf(doc),
        repoId,
        repoLabel: this.repoLabel(repoId),
        readOnly: repoId === null,
        state: str(doc.state) ?? 'admitted',
        stage,
        ...this.#reasonAndAction(stage, doc, facts),
        taskCounts: { total: Object.values(byStatus).reduce((sum, n) => sum + n, 0), byStatus },
        lastActivityAt: lastAt[`work:${id}`] ?? null,
        updatedAt: str(doc.updatedAt) ?? '',
      }
    })
  }

  #groupBy(docs: StoreDoc[], field: string): Map<string, StoreDoc[]> {
    const grouped = new Map<string, StoreDoc[]>()
    for (const doc of docs) {
      const key = str(doc[field])
      if (key !== null) grouped.set(key, [...(grouped.get(key) ?? []), doc])
    }
    return grouped
  }

  workPage(repoId: string | undefined, cursor: string | null, limit: number): Page<WorkRow> {
    const page = this.#reads.pageDocs('work_item', {
      cursor,
      limit,
      ...(repoId !== undefined && { equals: { repoId } }),
    })
    const rows = this.workRows(
      page.rows.map((row) => row.doc),
      this.openNeeds(),
    )
    // The store capped the raw docs; cap what is actually sent too, ending early with a valid cursor.
    const items: WorkRow[] = []
    let bytes = ENVELOPE_BYTES
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(scrub(row)))
      if (items.length > 0 && bytes + size > MAX_PAGE_BYTES) break
      bytes += size
      items.push(row)
    }
    const last = items.length - 1
    const nextCursor =
      items.length < rows.length ? encodeCursor(page.rows[last]?.rowid ?? 0) : page.nextCursor
    return { items, nextCursor, observedAt: this.observedAt() }
  }

  #coverage(attempts: StoreDoc[], workDoc: StoreDoc | undefined): Coverage {
    const some = (test: (a: StoreDoc) => boolean): boolean => attempts.some(test)
    const streams = attempts.map((a) => `attempt:${String(a.id)}`)
    return {
      reports:
        some((a) => obj(a.report) !== null) || (workDoc !== undefined && str(workDoc.latestReport) !== null),
      checks: some((a) => Array.isArray(a.checks)),
      diff: some((a) => obj(a.diff) !== null),
      activity: streams.length > 0 && Object.keys(this.#reads.lastEventAt(streams)).length > 0,
      usage: some((a) => num(a.costUsd) !== null),
      delivery: workDoc !== undefined && obj(workDoc.delivery) !== null,
    }
  }

  taskRows(tasks: StoreDoc[]): TaskRow[] {
    const ids = tasks.map((task) => String(task.id))
    const counts = this.#reads.countByField('attempt', 'taskId', 'state', ids)
    return tasks.map((task) => {
      const id = String(task.id)
      const objective = str(task.objective)
      const line = objective === null ? null : firstLine(redactText(objective))
      return {
        id,
        localKey: str(task.localKey),
        title: line === null ? (str(task.localKey) ?? id) : line.slice(0, 80),
        role: str(task.role),
        status: str(task.status) ?? 'ready',
        dependsOn: strings(task.dependsOn),
        planRevision: num(task.planRevision),
        attemptCount: Object.values(counts[id] ?? {}).reduce((sum, n) => sum + n, 0),
      }
    })
  }

  workDetail(id: string, needs: NeedItem[]): WorkDetail | undefined {
    const doc = this.#reads.getDoc('work_item', id)
    if (doc === undefined) return undefined
    const [row] = this.workRows([doc], needs) as [WorkRow]
    const tasks = this.#reads.docsByField('task', 'workItemId', [id]).slice(0, TASK_CAP)
    const attempts = this.#reads.docsByField('attempt', 'workItemId', [id])
    const originId = str(doc.originMessageId)
    const goalText = originId === null ? null : str(this.#store.messages.get(originId)?.text)
    const hold = obj(doc.hold)
    const streams = [`work:${id}`, ...attempts.map((a) => `attempt:${String(a.id)}`)]
    return {
      ...row,
      originMessageId: originId,
      goal: goalText === null ? null : cutText(goalText, 2000),
      hold:
        hold !== null && str(hold.liftedAt) === null
          ? {
              since: str(hold.at) ?? '',
              reason: str(hold.reason) === null ? null : cutText(String(hold.reason), 200),
            }
          : null,
      planRevision: num(doc.planRevision),
      tasks: this.taskRows(tasks),
      // Parent and child attempts: empty until M2 records them, never inferred from dependencies.
      delegation: [],
      delivery: this.#deliveryOf(doc),
      coverage: this.#coverage(attempts, doc),
      cursors: this.#reads.cursors(streams),
    }
  }

  // ── tasks ──

  taskDetail(id: string): TaskDetail | undefined {
    const task = this.#reads.getDoc('task', id)
    if (task === undefined) return undefined
    const [row] = this.taskRows([task]) as [TaskRow]
    const workItemId = str(task.workItemId) ?? ''
    const workDoc = workItemId === '' ? undefined : this.#store.workItems.get(workItemId)
    const attempts = this.#reads
      .docsByField('attempt', 'taskId', [id])
      .sort((a, b) => (num(a.generation) ?? 0) - (num(b.generation) ?? 0))
    const lastAt = this.#reads.lastEventAt(attempts.map((a) => `attempt:${String(a.id)}`))
    const modelRequest = obj(task.modelRequest)
    const views = attempts.map((attempt): AttemptView => {
      const slotId = str(attempt.slotId)
      const model = str(attempt.model)
      const engine = str(attempt.engine)
      const exitCode = num(attempt.exit_code)
      const terminal = str(attempt.terminal_reason)
      return {
        id: String(attempt.id),
        generation: num(attempt.generation) ?? 1,
        state: str(attempt.state) ?? 'unknown',
        role: str(task.role),
        requested: { tier: str(modelRequest?.tier), model: str(modelRequest?.model) },
        // The model that actually ran is recorded by the attempt; never copied from the request.
        actual:
          model === null && engine === null && slotId === null
            ? null
            : {
                model,
                engine,
                slotLabel: slotId === null ? null : (str(this.#store.slots.get(slotId)?.label) ?? null),
              },
        baseSha: str(attempt.baseSha),
        headSha: str(attempt.headSha),
        processOutcome: terminal ?? (exitCode === null ? 'unknown' : `exit ${exitCode}`),
        lastActivityAt: lastAt[`attempt:${String(attempt.id)}`] ?? null,
      }
    })
    const named = [...attempts].reverse().find((attempt) => str(attempt.headSha) !== null)
    const head = str(named?.headSha)
    // Checks and diff belong to the exact head they ran on, never inherited from another scope.
    const checkList = named?.checks
    const checks: CheckView[] = Array.isArray(checkList)
      ? checkList.flatMap((entry): CheckView[] => {
          const check = obj(entry)
          if (check === null || str(check.name) === null || str(check.headSha) !== head) return []
          const state = str(check.state)
          return [
            {
              name: cutText(String(check.name), 120),
              state: state === 'passed' || state === 'failed' ? state : 'not-run',
              headSha: head,
              detail: str(check.detail) === null ? null : cutText(String(check.detail), 500),
              artifactRef: str(check.artifactRef),
            },
          ]
        })
      : []
    const diffRecord = obj(named?.diff)
    const fileList = diffRecord?.files
    const files = Array.isArray(fileList)
      ? fileList.flatMap((entry) => {
          const file = obj(entry)
          return file !== null && str(file.path) !== null
            ? [
                {
                  path: cutText(String(file.path), 300),
                  added: num(file.added) ?? 0,
                  removed: num(file.removed) ?? 0,
                },
              ]
            : []
        })
      : []
    const costs = attempts.map((attempt) => num(attempt.costUsd))
    const reported = costs.filter((cost): cost is number => cost !== null)
    const modes = new Set(attempts.map((attempt) => str(attempt.usageMode)).filter((mode) => mode !== null))
    const onlyMode = modes.size === 1 ? [...modes][0] : null
    return {
      ...row,
      workItemId,
      repoId: repoIdOf(task) ?? repoIdOf(workDoc),
      objective: cutText(str(task.objective) ?? '', 20000),
      attempts: views,
      checks: { headSha: checks.length > 0 ? head : null, results: checks },
      diff: {
        headSha: diffRecord === null ? null : head,
        summary: str(diffRecord?.summary) === null ? null : cutText(String(diffRecord?.summary), 2000),
        files,
      },
      usage: {
        reportedUsd: reported.length === 0 ? null : reported.reduce((sum, cost) => sum + cost, 0),
        missingAttempts: costs.length - reported.length,
        mode: onlyMode === 'api' || onlyMode === 'subscription' ? onlyMode : 'unknown',
      },
      coverage: this.#coverage(attempts, workDoc),
    }
  }

  // ── search ──

  search(q: string, repoId: string | undefined): SearchHit[] {
    const hits = new Map<string, SearchHit>()
    const scope = repoId === undefined ? {} : { equals: { repoId } }
    const add = (hit: SearchHit): void => {
      hits.set(`${hit.kind}:${hit.id}`, hit)
    }
    const inScope = (workItemId: string | null, own: string | null): boolean =>
      repoId === undefined || (own ?? this.#workRepo(workItemId)) === repoId
    const workHit = (doc: StoreDoc, kind: 'work' | 'reference'): void => {
      const id = String(doc.id)
      add({
        kind,
        id,
        title: this.#titleOf(doc) ?? id,
        repoLabel: this.repoLabel(repoIdOf(doc)),
        workItemId: id,
      })
    }

    // Messages by text or id.
    const messages = this.#reads.searchDocs('message', ['text'], q, { limit: SEARCH_CAP, ...scope })
    const byId = this.#reads.getDoc('message', q)
    if (byId !== undefined && inScope(str(byId.workItemId), repoIdOf(byId))) messages.unshift(byId)
    for (const message of messages) {
      const id = String(message.id)
      const repo = repoIdOf(message)
      add({
        kind: 'message',
        id,
        title: cutText(firstLine(str(message.text) ?? '') ?? id, 80),
        repoLabel: this.repoLabel(repo),
        workItemId: str(message.workItemId),
      })
    }

    // Work by title, by id, or by the message that started it.
    const works = this.#reads.searchDocs('work_item', ['title'], q, { limit: SEARCH_CAP, ...scope })
    const direct = this.#reads.getDoc('work_item', q)
    if (direct !== undefined && (repoId === undefined || repoIdOf(direct) === repoId)) works.unshift(direct)
    const fromMessages = this.#reads
      .docsByField(
        'work_item',
        'originMessageId',
        messages.map((m) => String(m.id)),
      )
      .filter((doc) => repoId === undefined || repoIdOf(doc) === repoId)
    for (const work of [...works, ...fromMessages]) workHit(work, 'work')

    // Tasks by name (local key or objective).
    const tasks = this.#reads.searchDocs('task', ['localKey', 'objective'], q, {
      limit: SEARCH_CAP,
      ...scope,
    })
    const taskById = this.#reads.getDoc('task', q)
    if (taskById !== undefined && inScope(str(taskById.workItemId), repoIdOf(taskById)))
      tasks.unshift(taskById)
    for (const task of tasks) {
      const [row] = this.taskRows([task]) as [TaskRow]
      const repo = repoIdOf(task) ?? this.#workRepo(str(task.workItemId))
      add({
        kind: 'task',
        id: row.id,
        title: row.title,
        repoLabel: this.repoLabel(repo),
        workItemId: str(task.workItemId),
      })
    }

    // References a stored field holds: a PR number, a GitHub URL, a SHA.
    const pr = /^#(\d{1,9})$/.exec(q)
    const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(q)
    const number = pr !== null ? Number(pr[1]) : url !== null ? Number(url[2]) : null
    if (number !== null) {
      const filter = { ...(repoId !== undefined && { repoId }) }
      for (const work of this.#reads.pageDocs('work_item', {
        equals: { 'delivery.prNumber': number, ...filter },
        limit: SEARCH_CAP,
      }).rows) {
        const prUrl = str(obj(work.doc.delivery)?.prUrl)
        if (url === null || prUrl === null || prUrl.includes(`${url[1]}/pull/${url[2]}`))
          workHit(work.doc, 'reference')
      }
    }
    if (/^[0-9a-f]{7,40}$/i.test(q)) {
      const sha = q.toLowerCase()
      for (const attempt of this.#reads.searchDocs('attempt', ['headSha', 'baseSha'], sha, {
        limit: SEARCH_CAP,
      })) {
        const workItemId = str(attempt.workItemId)
        if (!inScope(workItemId, null)) continue
        const id = String(attempt.id)
        add({
          kind: 'reference',
          id,
          title: `Attempt ${id} at ${sha.slice(0, 12)}`,
          repoLabel: this.repoLabel(this.#workRepo(workItemId)),
          workItemId,
        })
      }
      for (const work of this.#reads.searchDocs('work_item', ['delivery.headSha'], sha, {
        limit: SEARCH_CAP,
        ...scope,
      })) {
        workHit(work, 'reference')
      }
    }
    return [...hits.values()].slice(0, SEARCH_CAP * 5)
  }

  // ── snapshot ──

  snapshot(repoId: string | undefined): {
    observedAt: string
    repositories: { id: string; label: string | null; needsCount: number }[]
    needsCount: number
    cursors: Record<string, number>
  } {
    const open = this.openNeeds()
    const works = this.#reads.pageDocs('work_item', {
      order: 'desc',
      limit: SNAPSHOT_STREAM_CAP,
      ...(repoId !== undefined && { equals: { repoId } }),
    })
    const streams = ['repositories', ...works.rows.map((row) => `work:${String(row.doc.id)}`)]
    return {
      observedAt: this.observedAt(),
      repositories: this.repositories().map((repo) => ({
        ...repo,
        needsCount: open.filter((item) => item.repoId === repo.id).length,
      })),
      needsCount: open.filter((item) => repoId === undefined || item.repoId === repoId).length,
      cursors: this.#reads.cursors(streams),
    }
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────────

function pageParams(query: Record<string, unknown>): { cursor: string | null; limit: number } {
  const rawLimit = query.limit
  let limit = DEFAULT_PAGE_LIMIT
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      throw new BadRequest('limit must be a whole number of at least 1')
    }
    limit = Math.min(Number(rawLimit), MAX_PAGE_LIMIT)
  }
  const rawCursor = query.cursor
  if (rawCursor === undefined) return { cursor: null, limit }
  if (typeof rawCursor !== 'string') throw new BadRequest('cursor is not valid')
  try {
    decodeCursor(rawCursor)
  } catch (error) {
    if (error instanceof CursorError) throw new BadRequest(error.message)
    throw error
  }
  return { cursor: rawCursor, limit }
}

/**
 * Registers `GET /api/inspect/{snapshot,work,work/:id,tasks/:id,needs,search}`. Additive: the
 * existing routes keep their shapes. Every response is redacted on its way out.
 */
export function registerInspectionRoutes(app: FastifyInstance, deps: InspectDeps): void {
  const inspector = new Inspector(deps)

  const repoFilter = (request: FastifyRequest): string | undefined => {
    const repoId = (request.query as { repoId?: unknown }).repoId
    if (repoId === undefined) return undefined
    if (typeof repoId !== 'string') throw new BadRequest('repoId must be a string')
    assertRepoAdmission(deps.store, { repoId })
    return repoId
  }

  /** One consistent read, one redacted answer; a refused request answers 400 before any query. */
  const serve =
    <T>(read: (request: FastifyRequest, reply: FastifyReply) => T | undefined) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        const result = deps.reads.consistent(() => read(request, reply))
        if (result === undefined) {
          reply.code(404)
          return { error: 'not found' }
        }
        return scrub(result)
      } catch (error) {
        if (error instanceof BadRequest) {
          reply.code(400)
          return { error: 'bad_request', detail: error.message }
        }
        throw error
      }
    }

  app.get(
    '/api/inspect/snapshot',
    serve((request) => inspector.snapshot(repoFilter(request))),
  )

  app.get(
    '/api/inspect/work',
    serve((request) => {
      const repoId = repoFilter(request)
      const { cursor, limit } = pageParams(request.query as Record<string, unknown>)
      return inspector.workPage(repoId, cursor, limit)
    }),
  )

  app.get(
    '/api/inspect/work/:id',
    serve((request) =>
      inspector.workDetail(String((request.params as { id?: string }).id ?? ''), inspector.openNeeds()),
    ),
  )

  app.get(
    '/api/inspect/tasks/:id',
    serve((request) => inspector.taskDetail(String((request.params as { id?: string }).id ?? ''))),
  )

  app.get(
    '/api/inspect/needs',
    serve((request): Page<NeedItem> => {
      const repoId = repoFilter(request)
      const recent = (request.query as { recent?: unknown }).recent
      return {
        items: inspector.needs(repoId, recent === '1' || recent === 'true'),
        nextCursor: null,
        observedAt: inspector.observedAt(),
      }
    }),
  )

  app.get(
    '/api/inspect/search',
    serve((request): Page<SearchHit> => {
      const repoId = repoFilter(request)
      const q = (request.query as { q?: unknown }).q
      if (typeof q !== 'string' || q.trim() === '' || q.length > 200) {
        throw new BadRequest('q must be 1 to 200 characters')
      }
      return {
        items: inspector.search(q.trim(), repoId),
        nextCursor: null,
        observedAt: inspector.observedAt(),
      }
    }),
  )
}
