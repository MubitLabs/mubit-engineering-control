/**
 * Canonical inspection (M3.1; plan §10, §17, §18, §22): read-only `GET /api/inspect/*` routes that
 * serve any repository's work, tasks, open decisions, search results, attempt activity and artifacts
 * through bounded pages. The wire shapes are the contract `31` builds against; this file is where
 * records become those shapes.
 *
 * Rules held here, each with a test:
 * - Nothing is invented. A record the system has not stored yet is `null`, `[]` or `coverage: false`,
 *   never zero. The stage is computed from facts (`stageOf`), never stored.
 * - A row with no `repoId` is Unassigned: `repoId: null`, `repoLabel: null`, `readOnly: true`. A
 *   repository is never inferred from a path, a title or a branch name.
 * - A card joins to work only through a stored `workItemId` or `mandateId`. Never by branch.
 * - Every string leaves through `redactText`, after any cut, so a cut cannot leave half a secret.
 * - A page is at most 100 rows and ends early with a valid cursor at 1 MiB of JSON. Each detail list
 *   has a count and a byte budget and says how much it cut. Those are the normal bounds; `serve` is
 *   the hard one: an answer still over 1 MiB is never sent, whatever a record holds.
 * - Every route sits behind `readGate`: a loopback Host, and the client header on a browser request.
 * - An artifact resolves only under its attempt's worktree, by real path, outside `.mec/` and `.git`.
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { EngineEvent, Json, Store, StoreDoc } from '@mec/contracts'
import { SECRET_PATTERNS } from '@mec/contracts'
import { type Stage, stageOf, workViewOf } from '@mec/domain'
import { assertRepoAdmission } from '@mec/meta'
import { type AttemptOutcome, type CheckRecord, projectAttempt } from '@mec/scorecards'
import { redact } from '@mec/slots'
import {
  CursorError,
  DEFAULT_PAGE_LIMIT,
  type DocRow,
  decodeCursor,
  decodeCursorAt,
  type EventRow,
  encodeCursor,
  type InspectionReads,
  MAX_PAGE_BYTES,
  MAX_PAGE_LIMIT,
} from '@mec/store'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { deliveryDocId } from './delivery'

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
  delegation: { parentAttemptId: string; childAttemptId: string }[]
  delivery: DeliveryView
  coverage: Coverage
  cursors: Record<string, number>
  /** Attempt streams left out of `cursors` (the work stream and the newest attempts are kept). */
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
  /** Older attempts left out of `attempts` (the newest are kept). */
  attemptsTruncated: number
  /** `truncated` counts what was cut to keep the answer under 1 MiB. */
  checks: { headSha: string | null; results: CheckView[]; truncated: number }
  diff: {
    headSha: string | null
    summary: string | null
    files: { path: string; added: number; removed: number }[]
    truncated: number
  }
  /** `coverage: 'subtotal'` says `reportedUsd` is known to be short of the total. */
  usage: {
    reportedUsd: number | null
    missingAttempts: number
    mode: 'api' | 'subscription' | 'unknown'
    coverage: AttemptOutcome['spendCoverage']
  }
  /** Three facts about the latest attempt that named a head. A clean exit proves only the first. */
  outcome: {
    process: string
    validation: AttemptOutcome['validation']
    delivery: AttemptOutcome['delivery']
  }
  coverage: Coverage
}

/** One page item of `attempts/:id/activity`. */
export type ActivityItem = { seq: number; type: string; at: string; summary: string; detail: string | null }

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
export function scrub<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T
  if (Array.isArray(value)) return value.map((entry) => scrub(entry)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)])) as T
  }
  return value
}

/** Redact first, then cut: a cut must never leave the front half of a key that no longer matches. */
const cutText = (text: string, max: number): string => redactText(text).slice(0, max)

/** Ids, times and names are short in any real record; one that is not still cannot pass the byte bound. */
const SHORT_CAP = 200
const shortText = (text: string): string => cutText(text, SHORT_CAP)
const shortOrNull = (text: string | null): string | null => (text === null ? null : shortText(text))

/** The leading entries that fit both bounds, sized as the JSON that actually leaves. */
function takeWithin<T>(list: readonly T[], count: number, bytes: number): T[] {
  const kept: T[] = []
  let used = 0
  for (const entry of list.slice(0, count)) {
    used += Buffer.byteLength(JSON.stringify(scrub(entry))) + 1
    if (used > bytes) break
    kept.push(entry)
  }
  return kept
}

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

const headOf = (attempt: StoreDoc): string | null => str(attempt.head_sha) ?? str(attempt.headSha)

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
class Refused extends Error {}

/** A short time for a sentence: `09:07`, with the day when it is not today. The exact time stays in its own field. */
function whenText(iso: string | null, now: Date): string | null {
  const at = iso === null ? new Date(Number.NaN) : new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const today = at.toDateString() === now.toDateString()
  return today ? clock : `${at.getDate()} ${at.toLocaleString('en-GB', { month: 'short' })} ${clock}`
}

// ── The read gate (§22) ──────────────────────────────────────────────────────────────────────

/** Any of these says a browser sent the request; a page cannot take one of them off. */
const BROWSER_HEADERS = ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']

/** A rebound page reaches this server under its own name, and its Host says so. */
export function hostIsLoopback(host: string | undefined): boolean {
  const name = host?.toLowerCase().replace(/:\d+$/, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
}

const isBrowser = (request: FastifyRequest): boolean =>
  BROWSER_HEADERS.some((name) => request.headers[name] !== undefined) ||
  /\bMozilla\//.test(request.headers['user-agent'] ?? '')

/** The hook above the routes passes a same-origin GET, so a read carries its own check. */
async function readGate(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (!hostIsLoopback(request.headers.host)) {
    return reply.code(403).send({ error: 'forbidden_host' })
  }
  if (isBrowser(request) && request.headers['x-mec-client'] !== '1') {
    return reply.code(403).send({ error: 'client_header_required' })
  }
  return undefined
}

// ── Artifacts ────────────────────────────────────────────────────────────────────────────────

/** The attempt's own control files: a token lives under `.mec/`, and `.git` points at the clone. */
const CONTROL_DIRS = ['.mec', '.git']
const ARTIFACT_REF_CAP = 1024
const ARTIFACT_PAGE_BYTES = MAX_PAGE_BYTES
/** How far past the page a key is looked for, so a cut cannot fall inside one. */
const ARTIFACT_OVERLAP_BYTES = 4096
const BINARY_SNIFF_BYTES = 8192

/** The file `ref` really names under `root`; undefined when it does not exist. */
function resolveArtifact(root: string, ref: string): string | undefined {
  if (isAbsolute(ref) || ref.includes('\0') || ref.split(/[\\/]/).includes('..')) {
    throw new BadRequest('ref must be a path inside the attempt')
  }
  let realRoot: string
  let real: string
  try {
    realRoot = realpathSync(root)
    real = realpathSync(join(realRoot, ref))
  } catch {
    return undefined
  }
  const inside = relative(realRoot, real)
  const segments = inside.split(sep)
  if (inside === '' || segments[0] === '..' || isAbsolute(inside)) throw new Refused('outside the attempt')
  if (segments.some((segment) => CONTROL_DIRS.includes(segment))) throw new Refused('a control file')
  return real
}

/**
 * Where a page of `chunk` ends: on a character, and never inside a key. A key cut in two matches
 * no pattern on either page, so it would leave in two halves that both pass redaction.
 */
function artifactPageEnd(chunk: Buffer): number {
  if (chunk.length <= ARTIFACT_PAGE_BYTES) return chunk.length
  let end = ARTIFACT_PAGE_BYTES
  while (end > 0 && ((chunk[end] as number) & 0xc0) === 0x80) end -= 1
  const bytes = chunk.toString('latin1')
  for (const { pattern } of SECRET_PATTERNS) {
    for (const match of bytes.matchAll(new RegExp(pattern.source, 'g'))) {
      if (match.index < end && end < match.index + match[0].length) end = match.index
    }
  }
  return end === 0 ? ARTIFACT_PAGE_BYTES : end
}

type ArtifactPage = { size: number } & (
  | { binary: true }
  | { binary: false; text: string; next: number | null }
)

function readArtifact(path: string, offset: number): ArtifactPage | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return undefined
    const { size } = stat
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, size))
    readSync(fd, sniff, 0, sniff.length, 0)
    if (sniff.includes(0)) return { size, binary: true }
    const left = Math.max(0, size - offset)
    const chunk = Buffer.alloc(Math.min(left, ARTIFACT_PAGE_BYTES + ARTIFACT_OVERLAP_BYTES))
    readSync(fd, chunk, 0, chunk.length, offset)
    const end = artifactPageEnd(chunk)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, end))
    } catch {
      return { size, binary: true }
    }
    return { size, binary: false, text: redactText(text), next: offset + end < size ? offset + end : null }
  } finally {
    closeSync(fd)
  }
}

// ── The inspector ────────────────────────────────────────────────────────────────────────────

const QUESTION_PREFIX = 'question/'
const REPO_PREFIX = 'repo_'
const RECENT_CAP = 20
/** A task answer is cut to these before it is built; what was cut is counted in the response. */
const ATTEMPT_CAP = 50
const CHECK_CAP = 200
const DIFF_FILE_CAP = 500
const TASK_CAP = 200
const DEPENDS_CAP = 100
const CURSOR_CAP = 200
const CLS_CAP = 4000
const LABEL_CAP = 80
/**
 * Count caps alone do not hold a byte bound: JSON spends up to 6 bytes on one character. These budgets
 * keep a heavy but ordinary answer servable; the hard ceiling is in `serve`.
 */
const ATTEMPT_BYTES = 150 * 1024
const CHECK_BYTES = 250 * 1024
const DIFF_BYTES = 250 * 1024
const DEPENDS_BYTES = 16 * 1024
const TASK_BYTES = 768 * 1024
const CURSOR_BYTES = 64 * 1024
const SNAPSHOT_STREAM_CAP = 100
const SEARCH_CAP = 20
/** A turn with no person behind it (`MetaAgentService.onWake`): its text is a wake reason. */
const WAKE_MESSAGE_PREFIX = 'msg_wake_'
/** Usage events read for one attempt; a stream past this is a subtotal. */
const USAGE_READ_CAP = 5000
const ACTIVITY_SUMMARY_CAP = 200
const ACTIVITY_DETAIL_CAP = 64 * 1024
/** The contract's engine events (`packages/contracts/src/events.ts`). Anything else stays private. */
const ACTIVITY_TYPES = new Set([
  'message',
  'tool_call',
  'permission_request',
  'permission_result',
  'usage',
  'rate_limit',
  'report',
  'error',
  'exit',
  'session_started',
])
/** The record's stage (`DeliveryStage`) on the wire. What has ended, or stopped short, keeps the last true place. */
const DELIVERY_STAGES: Readonly<Record<string, DeliveryView['stage']>> = {
  local_complete: 'local-complete',
  moved: 'local-complete',
  declined: 'local-complete',
  failed: 'local-complete',
  push_card: 'awaiting-push',
  pushed: 'awaiting-pr',
  pr_card: 'awaiting-pr',
  pr_open: 'pr-open',
  ready: 'pr-ready',
  merged: 'merged',
}
/** Headroom for the envelope fields around a page's items. */
const ENVELOPE_BYTES = 1024

type InspectDeps = { store: Store; reads: InspectionReads; now: () => Date }

/** A need with the rowid that keys its page: stable, unlike its position in the list. */
type NeedRow = { rowid: number; item: NeedItem; settledAt: string }

/** Latest settled first, rowid breaking a tie: a total order a cursor can resume from. */
const bySettledDesc = (a: NeedRow, b: NeedRow): number =>
  a.settledAt === b.settledAt ? b.rowid - a.rowid : a.settledAt < b.settledAt ? 1 : -1

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

  repositories(): { items: { id: string; label: string | null }[]; truncated: number } {
    const all = this.#collect('engine', { idPrefix: REPO_PREFIX })
    const rows = all.slice(0, MAX_PAGE_LIMIT)
    return {
      items: rows.map((row) => ({ id: String(row.doc.id), label: this.repoLabel(String(row.doc.id)) })),
      truncated: all.length - rows.length,
    }
  }

  // ── needs: open questions and pending cards ──

  /** Walks the whole set by keyset. Nothing is dropped here: a count must be the truth (§18). */
  #collect(kind: string, options: Parameters<InspectionReads['pageDocs']>[1]): DocRow[] {
    const rows: DocRow[] = []
    let cursor: string | null = null
    do {
      const page: ReturnType<InspectionReads['pageDocs']> = this.#reads.pageDocs(kind, {
        ...options,
        limit: MAX_PAGE_LIMIT,
        cursor,
      })
      rows.push(...page.rows)
      cursor = page.nextCursor
    } while (cursor !== null)
    return rows
  }

  #workRepo(workItemId: string | null): string | null {
    return workItemId === null ? null : repoIdOf(this.#store.workItems.get(workItemId))
  }

  #questionRow({ rowid, doc }: DocRow): NeedRow {
    const workItemId = str(doc.workItemId)
    const repoId = repoIdOf(doc) ?? this.#workRepo(workItemId)
    const stored = str(doc.status) ?? 'open'
    const item: NeedItem = {
      kind: 'question',
      id: shortText(str(doc.questionId) ?? String(doc.id).slice(QUESTION_PREFIX.length)),
      repoId: shortOrNull(repoId),
      repoLabel: this.repoLabel(repoId),
      workItemId: shortOrNull(workItemId),
      question: cutText(str(doc.question) ?? '', 2000),
      options: strings(doc.options)
        .slice(0, 20)
        .map((option) => cutText(option, 200)),
      status: stored === 'open' ? 'open' : stored === 'answered' ? 'answered' : 'expired',
      askedAt: shortOrNull(str(doc.askedAt)),
      answer: str(doc.answer) === null ? null : cutText(String(doc.answer), 2000),
    }
    return { rowid, item, settledAt: shortText(str(doc.answeredAt) ?? str(doc.askedAt) ?? '') }
  }

  /** Cards join to work only through a stored workItemId or a mandateId some work item carries. */
  #cardRows(rows: DocRow[]): NeedRow[] {
    const mandateIds = [
      ...new Set(
        rows.filter(({ doc }) => str(doc.workItemId) === null).flatMap(({ doc }) => str(doc.mandateId) ?? []),
      ),
    ]
    const byMandate = new Map<string, string>()
    for (const work of this.#reads.docsByField('work_item', 'mandate.id', mandateIds)) {
      const mandateId = str(obj(work.mandate)?.id)
      if (mandateId !== null) byMandate.set(mandateId, String(work.id))
    }
    const nowIso = this.observedAt()
    return rows.map(({ rowid, doc }): NeedRow => {
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
      const payloadRepo = str(payload?.repo)
      const id = shortText(String(doc.id))
      const item: NeedItem = {
        kind: 'card',
        id,
        repoId: shortOrNull(repoId),
        repoLabel:
          (repoId === null ? null : this.repoLabel(repoId)) ??
          (payloadRepo === null ? null : cutText(payloadRepo, LABEL_CAP)),
        workItemId: shortOrNull(workItemId),
        cls: cutText(str(doc.cls) ?? '', CLS_CAP),
        status,
        expiresAt: shortText(expiresAt),
        detailPath: `/api/inbox/${id}/detail`,
      }
      const lapsed = stored === 'pending' && status === 'expired'
      const settledAt = shortText((lapsed ? expiresAt : str(doc.resolvedAt)) ?? str(doc.createdAt) ?? '')
      return { rowid, item, settledAt }
    })
  }

  /** Everything that needs a person now, all repositories, oldest first. The single source of every count. */
  #openRows(): NeedRow[] {
    const questions = this.#collect('engine', { idPrefix: QUESTION_PREFIX, equals: { status: 'open' } })
    const cards = this.#cardRows(this.#collect('confirmation', { equals: { status: 'pending' } }))
    return [...questions.map((row) => this.#questionRow(row)), ...cards]
      .filter(({ item }) => item.status === 'open' || item.status === 'pending')
      .sort((a, b) => a.rowid - b.rowid)
  }

  openNeeds(): NeedItem[] {
    return this.#openRows().map((row) => row.item)
  }

  /**
   * Settled rows past the cursor, latest settled first. The whole kind is walked: an old row can settle
   * today, so no rowid range can hold the newest. Scope and cursor both apply before the cap.
   */
  #recentOf(
    kind: string,
    toRows: (rows: DocRow[]) => NeedRow[],
    keep: (row: NeedRow) => boolean,
    room: number,
  ): NeedRow[] {
    let found: NeedRow[] = []
    let cursor: string | null = null
    do {
      const page: ReturnType<InspectionReads['pageDocs']> = this.#reads.pageDocs(kind, {
        ...(kind === 'engine' && { idPrefix: QUESTION_PREFIX }),
        limit: MAX_PAGE_LIMIT,
        cursor,
      })
      const rows = toRows(page.rows).filter(
        (row) => row.item.status !== 'open' && row.item.status !== 'pending' && keep(row),
      )
      found = [...found, ...rows].sort(bySettledDesc).slice(0, room)
      cursor = page.nextCursor
    } while (cursor !== null)
    return found
  }

  /** Recently settled and expired items, latest settled first. Never counted as needing anyone. */
  #recentRows(repoId: string | undefined, after: { at: string; r: number } | null, room: number): NeedRow[] {
    const keep = ({ item, rowid, settledAt }: NeedRow): boolean =>
      (repoId === undefined || item.repoId === repoId) &&
      (after === null || settledAt < after.at || (settledAt === after.at && rowid < after.r))
    return [
      ...this.#recentOf('engine', (rows) => rows.map((row) => this.#questionRow(row)), keep, room),
      ...this.#recentOf('confirmation', (rows) => this.#cardRows(rows), keep, room),
    ]
      .sort(bySettledDesc)
      .slice(0, room)
  }

  /**
   * One page of needs by a stable key, so a row that settles between pages cannot shift another past
   * the cursor: open rows oldest first by rowid, then with `recent` the recent rows by settle time and
   * rowid, latest first. The recent cursor also counts what the walk has served, because its cap of
   * 20 is on the walk, not the page. Docs share one rowid space, so questions and cards share one
   * order. Ends early at the row limit or 1 MiB.
   */
  needsPage(
    repoId: string | undefined,
    recent: boolean,
    cursor: string | null,
    limit: number,
  ): Page<NeedItem> {
    const at = cursor === null ? { r: 0, recent: false } : decodeCursorAt(cursor)
    const open = at.recent
      ? []
      : this.#openRows()
          .filter(({ item }) => repoId === undefined || item.repoId === repoId)
          .filter((row) => row.rowid > at.r)
    const servedBefore = at.served ?? 0
    const settled = recent
      ? this.#recentRows(
          repoId,
          at.recent ? { at: at.at ?? '', r: at.r } : null,
          Math.max(0, RECENT_CAP - servedBefore),
        )
      : []
    const rows = [...open, ...settled]
    const served: NeedRow[] = []
    let bytes = ENVELOPE_BYTES
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(scrub(row.item)))
      if (served.length > 0 && bytes + size > MAX_PAGE_BYTES) break
      bytes += size
      served.push(row)
    }
    const last = served.at(-1)
    return {
      items: served.map((row) => row.item),
      nextCursor:
        last !== undefined && served.length < rows.length
          ? served.length > open.length
            ? encodeCursor(last.rowid, true, {
                at: last.settledAt,
                served: servedBefore + served.length - open.length,
              })
            : encodeCursor(last.rowid)
          : null,
      observedAt: this.observedAt(),
    }
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

  #deliveryRecord(doc: StoreDoc | undefined): StoreDoc | undefined {
    return doc === undefined ? undefined : this.#store.engines.get(deliveryDocId(String(doc.id)))
  }

  #deliveryOf(doc: StoreDoc): DeliveryView {
    const record = this.#deliveryRecord(doc)
    if (record !== undefined) {
      return {
        stage: DELIVERY_STAGES[str(record.stage) ?? ''] ?? 'none',
        branch: shortOrNull(str(record.branch)),
        headSha: shortOrNull(str(record.head)),
        prNumber: num(record.prNumber),
        prUrl: str(record.prUrl) === null ? null : cutText(String(record.prUrl), 500),
      }
    }
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
      branch: shortOrNull(str(stored?.branch)),
      headSha: shortOrNull(str(stored?.headSha)),
      prNumber: num(stored?.prNumber),
      prUrl: str(stored?.prUrl) === null ? null : cutText(String(stored?.prUrl), 500),
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
          reason: `Held by you since ${whenText(str(hold?.at), this.#now()) ?? 'an unknown time'}${why === null ? '' : `: ${cutText(why, 200)}`}`,
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
      const stage = stageOf(
        workViewOf(doc, {
          ...facts,
          attempts: attempts.get(id) ?? [],
          merged: this.#deliveryOf(doc).stage === 'merged',
        }),
      )
      const byStatus = counts[id] ?? {}
      const repoId = repoIdOf(doc)
      return {
        id,
        title: this.#titleOf(doc),
        repoId,
        repoLabel: this.repoLabel(repoId),
        readOnly: repoId === null,
        state: shortText(str(doc.state) ?? 'admitted'),
        stage,
        ...this.#reasonAndAction(stage, doc, facts),
        taskCounts: { total: Object.values(byStatus).reduce((sum, n) => sum + n, 0), byStatus },
        lastActivityAt: lastAt[`work:${id}`] ?? null,
        updatedAt: shortText(str(doc.updatedAt) ?? ''),
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
        some((a) => (num(a.reports) ?? 0) > 0 || obj(a.report) !== null) ||
        (workDoc !== undefined && str(workDoc.latestReport) !== null),
      checks: some((a) => Array.isArray(a.checks)),
      diff: some((a) => obj(a.diff) !== null),
      activity: streams.length > 0 && Object.keys(this.#reads.lastEventAt(streams)).length > 0,
      usage: some((a) => num(a.costUsd) !== null || obj(a.usage) !== null),
      delivery:
        this.#deliveryRecord(workDoc) !== undefined ||
        (workDoc !== undefined && obj(workDoc.delivery) !== null),
    }
  }

  taskRows(tasks: StoreDoc[]): TaskRow[] {
    const ids = tasks.map((task) => String(task.id))
    const counts = this.#reads.countByField('attempt', 'taskId', 'state', ids)
    return tasks.map((task) => {
      const id = String(task.id)
      const objective = str(task.objective)
      const line = objective === null ? null : firstLine(redactText(objective))
      const localKey = shortOrNull(str(task.localKey))
      const allDepends = strings(task.dependsOn)
      const dependsOn = takeWithin(allDepends, DEPENDS_CAP, DEPENDS_BYTES)
      return {
        id,
        localKey,
        title: line === null ? (localKey ?? id).slice(0, 80) : line.slice(0, 80),
        role: shortOrNull(str(task.role)),
        status: shortText(str(task.status) ?? 'ready'),
        dependsOn,
        dependsOnTruncated: allDepends.length - dependsOn.length,
        planRevision: num(task.planRevision),
        attemptCount: Object.values(counts[id] ?? {}).reduce((sum, n) => sum + n, 0),
      }
    })
  }

  workDetail(id: string, needs: NeedItem[]): WorkDetail | undefined {
    const doc = this.#reads.getDoc('work_item', id)
    if (doc === undefined) return undefined
    const [row] = this.workRows([doc], needs) as [WorkRow]
    const allTasks = this.#reads.docsByField('task', 'workItemId', [id])
    const tasks = takeWithin(this.taskRows(allTasks.slice(0, TASK_CAP)), TASK_CAP, TASK_BYTES)
    const attempts = this.#reads.docsByField('attempt', 'workItemId', [id])
    const originId = str(doc.originMessageId)
    const goalText = originId === null ? null : str(this.#store.messages.get(originId)?.text)
    const hold = obj(doc.hold)
    const attemptStreams = takeWithin(
      attempts.map((a) => `attempt:${String(a.id)}`).reverse(),
      CURSOR_CAP,
      CURSOR_BYTES,
    )
    return {
      ...row,
      originMessageId: shortOrNull(originId),
      goal: goalText === null ? null : cutText(goalText, 2000),
      hold:
        hold !== null && str(hold.liftedAt) === null
          ? {
              since: shortText(str(hold.at) ?? ''),
              reason: str(hold.reason) === null ? null : cutText(String(hold.reason), 200),
            }
          : null,
      planRevision: num(doc.planRevision),
      tasks,
      tasksTruncated: allTasks.length - tasks.length,
      // Parent and child attempts: empty until M2 records them, never inferred from dependencies.
      delegation: [],
      delivery: this.#deliveryOf(doc),
      coverage: this.#coverage(attempts, doc),
      cursors: this.#reads.cursors([`work:${id}`, ...attemptStreams]),
      cursorsTruncated: attempts.length - attemptStreams.length,
    }
  }

  // ── tasks ──

  /** `check/<attempt>/<name>`: what `StoreFacts.checksFinished` stored. */
  #checkDocs(attemptId: string | undefined): StoreDoc[] {
    if (attemptId === undefined) return []
    return this.#collect('engine', { idPrefix: `check/${attemptId}/` }).map((row) => row.doc)
  }

  /** The stream's usage and exit events, as the engine sent them. */
  #engineEvents(attempt: StoreDoc): { events: EngineEvent[]; capped: boolean } {
    const id = String(attempt.id)
    const stream = `attempt:${id}`
    const usage = this.#reads.eventsOfType(stream, 'usage', USAGE_READ_CAP)
    const rows: EventRow[] = [...usage, ...this.#reads.eventsOfType(stream, 'exit', 1)]
    const events = rows.map((row) => {
      const body = obj(row.body ?? undefined) ?? {}
      return {
        ...body,
        type: row.type,
        // The engine's own seq: a replay gets a new place in the stream and keeps this.
        seq: num(body.seq) ?? row.seq,
        at: row.at,
        attempt_id: id,
        generation: num(body.generation) ?? num(attempt.generation) ?? 1,
      } as unknown as EngineEvent
    })
    return { events, capped: usage.length === USAGE_READ_CAP }
  }

  /** §19: one figure per attempt from the one calculation, with what it covers. */
  #usageOf(attempts: StoreDoc[], total: number): TaskDetail['usage'] {
    const outcomes = attempts.map((attempt) => {
      const { events, capped } = this.#engineEvents(attempt)
      const { spend, spendCoverage } = projectAttempt(String(attempt.id), events)
      const stored = num(attempt.costUsd) ?? num(obj(attempt.usage)?.cost_usd)
      if (spend === 'unknown') return { usd: stored, partial: false }
      return { usd: spend, partial: capped || spendCoverage === 'subtotal' }
    })
    const known = outcomes.flatMap(({ usd }) => (usd === null ? [] : [usd]))
    const missingAttempts = total - known.length
    const modes = new Set(attempts.flatMap((attempt) => this.#billingOf(attempt) ?? []))
    const onlyMode = modes.size === 1 ? [...modes][0] : undefined
    return {
      reportedUsd: known.length === 0 ? null : known.reduce((sum, usd) => sum + usd, 0),
      missingAttempts,
      mode: onlyMode ?? 'unknown',
      coverage:
        known.length === 0
          ? 'unknown'
          : missingAttempts > 0 || outcomes.some(({ partial }) => partial)
            ? 'subtotal'
            : 'total',
    }
  }

  /** API spend and subscription use are different things (§19): the slot says which this was. */
  #billingOf(attempt: StoreDoc): 'api' | 'subscription' | undefined {
    const stored = str(attempt.usageMode)
    if (stored === 'api' || stored === 'subscription') return stored
    const kind = str(this.#store.slots.get(str(attempt.slotId) ?? '')?.kind)
    if (kind?.endsWith('-sub')) return 'subscription'
    return kind?.endsWith('-api') ? 'api' : undefined
  }

  #outcomeOf(
    named: StoreDoc | undefined,
    checks: StoreDoc[],
    workDoc: StoreDoc | undefined,
  ): TaskDetail['outcome'] {
    if (named === undefined) return { process: 'unknown', validation: 'unknown', delivery: 'unknown' }
    const head = headOf(named) ?? undefined
    const records = checks.flatMap((check): CheckRecord[] => {
      const [name, status, sha] = [str(check.name), str(check.status), str(check.sha)]
      return name === null || status === null || sha === null ? [] : [{ name, status, sha }]
    })
    const stage = str(this.#deliveryRecord(workDoc)?.stage) ?? undefined
    const outcome = projectAttempt(String(named.id), this.#engineEvents(named).events, {
      ...(head !== undefined && { head }),
      checks: records,
      ...(stage !== undefined && { deliveryStage: stage }),
    })
    return {
      process: str(named.exit_reason) ?? outcome.result,
      validation: outcome.validation,
      delivery: outcome.delivery,
    }
  }

  taskDetail(id: string): TaskDetail | undefined {
    const task = this.#reads.getDoc('task', id)
    if (task === undefined) return undefined
    const [row] = this.taskRows([task]) as [TaskRow]
    const workItemId = str(task.workItemId) ?? ''
    const workDoc = workItemId === '' ? undefined : this.#store.workItems.get(workItemId)
    const attempts = this.#reads
      .docsByField('attempt', 'taskId', [id])
      .sort((a, b) => (num(a.generation) ?? 0) - (num(b.generation) ?? 0))
    const lastAt = this.#reads.lastEventAt(attempts.slice(-ATTEMPT_CAP).map((a) => `attempt:${String(a.id)}`))
    const modelRequest = obj(task.modelRequest)
    const shown = attempts.slice(-ATTEMPT_CAP)
    const built = shown.map((attempt): AttemptView => {
      const slotId = str(attempt.slotId)
      const engine = str(attempt.engine)
      // The scheduler names a model before launch; only a pinned engine means one really ran.
      const model = str(attempt.model) ?? (engine === null ? null : str(attempt.resolved_model))
      const exitCode = num(attempt.exit_code)
      const terminal = str(attempt.terminal_reason) ?? str(attempt.exit_reason)
      return {
        id: String(attempt.id),
        generation: num(attempt.generation) ?? 1,
        state: str(attempt.state) ?? 'unknown',
        role: str(attempt.role) ?? str(task.role),
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
        baseSha: str(attempt.base_sha) ?? str(attempt.baseSha),
        headSha: headOf(attempt),
        processOutcome: terminal ?? (exitCode === null ? 'unknown' : `exit ${exitCode}`),
        lastActivityAt: lastAt[`attempt:${String(attempt.id)}`] ?? null,
      }
    })
    const views = takeWithin(built.reverse(), ATTEMPT_CAP, ATTEMPT_BYTES).reverse()
    const named = [...attempts].reverse().find((attempt) => headOf(attempt) !== null)
    const head = named === undefined ? null : headOf(named)
    // Checks and diff belong to the exact head they ran on, never inherited from another scope.
    const checkDocs = this.#checkDocs(named === undefined ? undefined : String(named.id))
    const recorded = checkDocs.flatMap((check): CheckView[] => {
      if (str(check.name) === null || str(check.sha) !== head) return []
      const status = str(check.status)
      const tail = str(check.log_tail)
      return [
        {
          name: cutText(String(check.name), 120),
          state:
            status === 'passed' ? 'passed' : status === 'failed' || status === 'error' ? 'failed' : 'not-run',
          headSha: head,
          detail: tail === null ? null : redactText(tail).slice(-500),
          artifactRef: null,
        },
      ]
    })
    const skipped = str(named?.checks_note)
    const checkList = named?.checks
    const allChecks: CheckView[] = Array.isArray(checkList)
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
    allChecks.unshift(...recorded)
    if (allChecks.length === 0 && skipped !== null) {
      allChecks.push({
        name: 'checks',
        state: 'not-run',
        headSha: head,
        detail: cutText(skipped, 500),
        artifactRef: null,
      })
    }
    const checks = takeWithin(allChecks, CHECK_CAP, CHECK_BYTES)
    const diffRecord = obj(named?.diff)
    const fileList = diffRecord?.files
    const allFiles = Array.isArray(fileList)
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
    const files = takeWithin(allFiles, DIFF_FILE_CAP, DIFF_BYTES)
    return {
      ...row,
      workItemId: shortText(workItemId),
      repoId: shortOrNull(repoIdOf(task) ?? repoIdOf(workDoc)),
      objective: cutText(str(task.objective) ?? '', 20000),
      attempts: views,
      attemptsTruncated: attempts.length - views.length,
      checks: {
        headSha: checks.length > 0 ? shortOrNull(head) : null,
        results: checks,
        truncated: allChecks.length - checks.length,
      },
      diff: {
        headSha: diffRecord === null ? null : shortOrNull(head),
        summary: str(diffRecord?.summary) === null ? null : cutText(String(diffRecord?.summary), 2000),
        files,
        truncated: allFiles.length - files.length,
      },
      usage: this.#usageOf(shown, attempts.length),
      outcome: this.#outcomeOf(named, checkDocs, workDoc),
      coverage: this.#coverage(attempts, workDoc),
    }
  }

  // ── activity and artifacts ──

  /**
   * One page of an attempt's stream, allow-listed by type. A page can hold fewer items than its limit,
   * or none, while `nextCursor` still has more. `tool_call` is a completion, so nothing here says what
   * is running now.
   */
  activityPage(id: string, cursor: string | null, limit: number): Page<ActivityItem> | undefined {
    if (this.#reads.getDoc('attempt', id) === undefined) return undefined
    const page = this.#reads.pageEvents(`attempt:${id}`, { cursor, limit })
    const items: ActivityItem[] = []
    let bytes = ENVELOPE_BYTES
    let read = 0
    for (const row of page.rows) {
      if (ACTIVITY_TYPES.has(row.type)) {
        const item = activityItem(row)
        const size = Buffer.byteLength(JSON.stringify(scrub(item)))
        if (items.length > 0 && bytes + size > MAX_PAGE_BYTES) {
          return { items, nextCursor: encodeCursor(read), observedAt: this.observedAt() }
        }
        bytes += size
        items.push(item)
      }
      read = row.seq
    }
    return { items, nextCursor: page.nextCursor, observedAt: this.observedAt() }
  }

  /** The only allow-listed root is the attempt's own worktree, as the launcher pinned it. */
  artifactRoot(attemptId: string): string | undefined {
    return str(this.#reads.getDoc('attempt', attemptId)?.worktree) ?? undefined
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
    const messages = this.#reads.searchDocs('message', ['text'], q, {
      limit: SEARCH_CAP,
      excludeIdPrefix: WAKE_MESSAGE_PREFIX,
      ...scope,
    })
    const byId = q.startsWith(WAKE_MESSAGE_PREFIX) ? undefined : this.#reads.getDoc('message', q)
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

    // Attempts by id. They carry no repository of their own, so the scope is their work's.
    const attempts = this.#reads.searchDocs('attempt', ['id'], q, { limit: SEARCH_CAP })
    for (const attempt of attempts) {
      const workItemId = str(attempt.workItemId)
      if (!inScope(workItemId, null)) continue
      const id = String(attempt.id)
      add({
        kind: 'attempt',
        id,
        title: `Attempt ${id}`,
        repoLabel: this.repoLabel(this.#workRepo(workItemId)),
        workItemId,
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
      for (const { doc: record } of this.#reads.pageDocs('engine', {
        idPrefix: 'delivery/',
        equals: { prNumber: number, ...filter },
        limit: SEARCH_CAP,
      }).rows) {
        const prUrl = str(record.prUrl)
        const work = this.#store.workItems.get(str(record.workItemId) ?? '')
        if (
          work !== undefined &&
          (url === null || prUrl === null || prUrl.includes(`${url[1]}/pull/${url[2]}`))
        )
          workHit(work, 'reference')
      }
    }
    if (/^[0-9a-f]{7,40}$/i.test(q)) {
      const sha = q.toLowerCase()
      const shaFields = ['head_sha', 'base_sha', 'headSha', 'baseSha']
      for (const attempt of this.#reads.searchDocs('attempt', shaFields, sha, { limit: SEARCH_CAP })) {
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
      for (const record of this.#reads.searchDocs('engine', ['head'], sha, { limit: SEARCH_CAP, ...scope })) {
        const work = String(record.id).startsWith('delivery/')
          ? this.#store.workItems.get(str(record.workItemId) ?? '')
          : undefined
        if (work !== undefined) workHit(work, 'reference')
      }
    }
    return [...hits.values()].slice(0, SEARCH_CAP * 5)
  }

  // ── snapshot ──

  snapshot(repoId: string | undefined): {
    observedAt: string
    repositories: { id: string; label: string | null; needsCount: number }[]
    /** Repositories left out of `repositories` (the oldest 100 are kept). */
    repositoriesTruncated: number
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
    const repositories = this.repositories()
    return {
      observedAt: this.observedAt(),
      repositories: repositories.items.map((repo) => ({
        ...repo,
        needsCount: open.filter((item) => item.repoId === repo.id).length,
      })),
      repositoriesTruncated: repositories.truncated,
      needsCount: open.filter((item) => repoId === undefined || item.repoId === repoId).length,
      cursors: this.#reads.cursors(streams),
    }
  }
}

// ── Activity lines ───────────────────────────────────────────────────────────────────────────

/** What one event says, in a line. Only the fields the contract names for that type. */
function activitySummary(type: string, body: Record<string, Json>): string {
  switch (type) {
    case 'message':
      return `${str(body.role) ?? 'unknown'}: ${firstLine(str(body.text) ?? '') ?? ''}`
    case 'tool_call':
      return `${str(body.tool) ?? 'tool'}${body.ok === false ? ' failed' : ''}`
    case 'permission_request':
      return 'Asked for permission'
    case 'permission_result':
      return 'Permission answered'
    case 'usage':
      return `${num(body.input_tokens) ?? '?'} in, ${num(body.output_tokens) ?? '?'} out`
    case 'rate_limit':
      return `${str(body.window) ?? 'unknown'} ${str(body.status) ?? 'unknown'}`
    case 'report': {
      const report = obj(body.report)
      return `${str(report?.kind) ?? 'report'}: ${str(report?.summary) ?? ''}`
    }
    case 'error':
      return `${str(body.class) ?? 'unknown'}: ${str(body.detail) ?? ''}`
    case 'exit':
      return `Exit ${num(body.code) ?? '?'}: ${str(body.terminal_reason) ?? 'unknown'}`
    default:
      return `Started ${str(body.engine) ?? 'unknown'} ${str(body.engine_version) ?? ''}`.trim()
  }
}

function activityItem(row: EventRow): ActivityItem {
  const body = obj(row.body ?? undefined) ?? {}
  const text = row.type === 'message' ? str(body.text) : JSON.stringify(row.body)
  return {
    seq: row.seq,
    type: row.type,
    at: shortText(row.at),
    summary: cutText(activitySummary(row.type, body), ACTIVITY_SUMMARY_CAP),
    detail: text === null ? null : cutText(text, ACTIVITY_DETAIL_CAP),
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
 * Registers `GET /api/inspect/{snapshot,work,work/:id,tasks/:id,needs,search,attempts/:id/activity,
 * artifacts}`. Additive: the existing routes keep their shapes. Every response is redacted on its way
 * out, and every route is behind `readGate`.
 */
export function registerInspectionRoutes(app: FastifyInstance, deps: InspectDeps): void {
  const inspector = new Inspector(deps)
  const gated = { preHandler: readGate }

  const repoFilter = (request: FastifyRequest): string | undefined => {
    const repoId = (request.query as { repoId?: unknown }).repoId
    if (repoId === undefined) return undefined
    if (typeof repoId !== 'string') throw new BadRequest('repoId must be a string')
    assertRepoAdmission(deps.store, { repoId })
    return repoId
  }

  /**
   * One consistent read, one redacted answer; a refused request answers 400 before any query. The hard
   * byte ceiling lives here, once: the bytes measured are the bytes sent, or none of them are.
   */
  const serve =
    <T>(read: (request: FastifyRequest, reply: FastifyReply) => T | undefined) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        const result = deps.reads.consistent(() => read(request, reply))
        if (result === undefined) {
          reply.code(404)
          return { error: 'not found' }
        }
        const json = JSON.stringify(scrub(result))
        if (Buffer.byteLength(json) > MAX_PAGE_BYTES) {
          reply.code(500)
          return { error: 'response_too_large', detail: 'this record is too large to serve' }
        }
        reply.type('application/json; charset=utf-8')
        return json
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
    gated,
    serve((request) => inspector.snapshot(repoFilter(request))),
  )

  app.get(
    '/api/inspect/work',
    gated,
    serve((request) => {
      const repoId = repoFilter(request)
      const { cursor, limit } = pageParams(request.query as Record<string, unknown>)
      return inspector.workPage(repoId, cursor, limit)
    }),
  )

  app.get(
    '/api/inspect/work/:id',
    gated,
    serve((request) =>
      inspector.workDetail(String((request.params as { id?: string }).id ?? ''), inspector.openNeeds()),
    ),
  )

  app.get(
    '/api/inspect/tasks/:id',
    gated,
    serve((request) => inspector.taskDetail(String((request.params as { id?: string }).id ?? ''))),
  )

  app.get(
    '/api/inspect/needs',
    gated,
    serve((request): Page<NeedItem> => {
      const repoId = repoFilter(request)
      const query = request.query as Record<string, unknown>
      const { cursor, limit } = pageParams(query)
      return inspector.needsPage(repoId, query.recent === '1' || query.recent === 'true', cursor, limit)
    }),
  )

  app.get(
    '/api/inspect/search',
    gated,
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

  app.get(
    '/api/inspect/attempts/:id/activity',
    gated,
    serve((request) => {
      const { cursor, limit } = pageParams(request.query as Record<string, unknown>)
      return inspector.activityPage(String((request.params as { id?: string }).id ?? ''), cursor, limit)
    }),
  )

  /** Text, never markup: `nosniff` and no script, whatever the file claims to be. */
  app.get('/api/inspect/artifacts', gated, async (request, reply) => {
    const { attemptId, ref, cursor } = request.query as Record<string, unknown>
    reply.header('x-content-type-options', 'nosniff')
    reply.header('content-security-policy', "default-src 'none'")
    try {
      if (typeof attemptId !== 'string' || typeof ref !== 'string') {
        throw new BadRequest('attemptId and ref are required')
      }
      if (ref === '' || ref.length > ARTIFACT_REF_CAP) throw new BadRequest('ref is not valid')
      const offset = pageParams({ cursor }).cursor
      const root = inspector.artifactRoot(attemptId)
      const path = root === undefined ? undefined : resolveArtifact(root, ref)
      const page =
        path === undefined ? undefined : readArtifact(path, offset === null ? 0 : decodeCursor(offset))
      if (page === undefined) {
        reply.code(404)
        return { error: 'not found' }
      }
      if (page.binary) return { ref: redactText(ref), binary: true, size: page.size }
      reply.header('x-mec-artifact-size', String(page.size))
      if (page.next !== null) reply.header('x-mec-next-cursor', encodeCursor(page.next))
      reply.type('text/plain; charset=utf-8')
      return page.text
    } catch (error) {
      if (error instanceof BadRequest) {
        reply.code(400)
        return { error: 'bad_request', detail: error.message }
      }
      if (error instanceof Refused) {
        reply.code(403)
        return { error: 'artifact_refused' }
      }
      throw error
    }
  })
}
