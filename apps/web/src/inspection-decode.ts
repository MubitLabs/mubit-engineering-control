/**
 * Decoders from the inspection routes' JSON to next/inspection-wire.ts. Pure, like api-decode.ts:
 * a payload that does not fit throws DecodeError and the surface shows a failed state, because a
 * guess would put invented work on screen. A stage key stays open-ended (a new one still has its
 * label); a closed vocabulary such as a need's status does not.
 */

import { DecodeError } from './api-decode'
import type {
  ActivityItem,
  ArtifactPage,
  AttemptView,
  CardEvidence,
  ChatLine,
  CheckView,
  Coverage,
  DeliveryView,
  MetaAnswer,
  NeedItem,
  Page,
  SearchHit,
  Snapshot,
  Stage,
  TaskDetail,
  TaskRow,
  WorkDetail,
  WorkRow,
} from './next/inspection-wire'

type Obj = Record<string, unknown>

function obj(path: string, value: unknown, what: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecodeError(path, `${what} is not an object`)
  }
  return value as Obj
}

function str(path: string, value: unknown, what: string): string {
  if (typeof value !== 'string') throw new DecodeError(path, `${what} is not a string`)
  return value
}

function strOrNull(path: string, value: unknown, what: string): string | null {
  return value === null ? null : str(path, value, what)
}

function num(path: string, value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DecodeError(path, `${what} is not a number`)
  }
  return value
}

function numOrNull(path: string, value: unknown, what: string): number | null {
  return value === null ? null : num(path, value, what)
}

function bool(path: string, value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new DecodeError(path, `${what} is not a boolean`)
  return value
}

function list<T>(
  path: string,
  value: unknown,
  what: string,
  item: (entry: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(value)) throw new DecodeError(path, `${what} is not an array`)
  return value.map((entry, index) => item(entry, `${what}[${index}]`))
}

function strings(path: string, value: unknown, what: string): string[] {
  return list(path, value, what, (entry, label) => str(path, entry, label))
}

function oneOf<T extends string>(path: string, value: unknown, what: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DecodeError(path, `${what} is not one of ${allowed.join(', ')}`)
  }
  return value as T
}

function numberRecord(path: string, value: unknown, what: string): Record<string, number> {
  const raw = obj(path, value, what)
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(raw)) out[key] = num(path, entry, `${what}.${key}`)
  return out
}

function page<T>(path: string, raw: unknown, item: (entry: unknown, label: string) => T): Page<T> {
  const body = obj(path, raw, 'the body')
  return {
    items: list(path, body.items, 'items', item),
    nextCursor: strOrNull(path, body.nextCursor, 'nextCursor'),
    observedAt: str(path, body.observedAt, 'observedAt'),
  }
}

function stage(path: string, value: unknown, what: string): Stage {
  const raw = obj(path, value, what)
  return {
    key: str(path, raw.key, `${what}.key`),
    label: str(path, raw.label, `${what}.label`),
    waitingOn: oneOf(path, raw.waitingOn, `${what}.waitingOn`, ['person', 'system', 'none']),
  }
}

function coverage(path: string, value: unknown, what: string): Coverage {
  const raw = obj(path, value, what)
  return {
    reports: bool(path, raw.reports, `${what}.reports`),
    checks: bool(path, raw.checks, `${what}.checks`),
    diff: bool(path, raw.diff, `${what}.diff`),
    activity: bool(path, raw.activity, `${what}.activity`),
    usage: bool(path, raw.usage, `${what}.usage`),
    delivery: bool(path, raw.delivery, `${what}.delivery`),
  }
}

function workRow(path: string, value: unknown, what: string): WorkRow {
  const raw = obj(path, value, what)
  const counts = obj(path, raw.taskCounts, `${what}.taskCounts`)
  return {
    id: str(path, raw.id, `${what}.id`),
    title: strOrNull(path, raw.title, `${what}.title`),
    repoId: strOrNull(path, raw.repoId, `${what}.repoId`),
    repoLabel: strOrNull(path, raw.repoLabel, `${what}.repoLabel`),
    readOnly: bool(path, raw.readOnly, `${what}.readOnly`),
    state: str(path, raw.state, `${what}.state`),
    stage: stage(path, raw.stage, `${what}.stage`),
    reason: strOrNull(path, raw.reason, `${what}.reason`),
    nextAction: strOrNull(path, raw.nextAction, `${what}.nextAction`),
    taskCounts: {
      total: num(path, counts.total, `${what}.taskCounts.total`),
      byStatus: numberRecord(path, counts.byStatus, `${what}.taskCounts.byStatus`),
    },
    lastActivityAt: strOrNull(path, raw.lastActivityAt, `${what}.lastActivityAt`),
    updatedAt: str(path, raw.updatedAt, `${what}.updatedAt`),
    turnOutcome: raw.turnOutcome === 'answered' || raw.turnOutcome === 'no-answer' ? raw.turnOutcome : null,
  }
}

function taskRow(path: string, value: unknown, what: string): TaskRow {
  const raw = obj(path, value, what)
  return {
    id: str(path, raw.id, `${what}.id`),
    localKey: strOrNull(path, raw.localKey, `${what}.localKey`),
    title: str(path, raw.title, `${what}.title`),
    role: strOrNull(path, raw.role, `${what}.role`),
    status: str(path, raw.status, `${what}.status`),
    dependsOn: strings(path, raw.dependsOn, `${what}.dependsOn`),
    dependsOnTruncated: num(path, raw.dependsOnTruncated, `${what}.dependsOnTruncated`),
    planRevision: numOrNull(path, raw.planRevision, `${what}.planRevision`),
    attemptCount: num(path, raw.attemptCount, `${what}.attemptCount`),
  }
}

function delivery(path: string, value: unknown, what: string): DeliveryView {
  const raw = obj(path, value, what)
  return {
    stage: oneOf(path, raw.stage, `${what}.stage`, [
      'none',
      'local-complete',
      'awaiting-push',
      'awaiting-pr',
      'pr-open',
      'pr-ready',
      'merged',
    ]),
    branch: strOrNull(path, raw.branch, `${what}.branch`),
    headSha: strOrNull(path, raw.headSha, `${what}.headSha`),
    prNumber: numOrNull(path, raw.prNumber, `${what}.prNumber`),
    prUrl: strOrNull(path, raw.prUrl, `${what}.prUrl`),
    // The server leaves these out until they are true, so absent is the healthy answer.
    repo: raw.repo == null ? null : str(path, raw.repo, `${what}.repo`),
    ci:
      raw.ci == null
        ? null
        : oneOf<NonNullable<DeliveryView['ci']>>(path, raw.ci, `${what}.ci`, [
            'passing',
            'none-required',
            'running',
            'failing',
            'unreadable',
          ]),
    ciReadAt: raw.ciReadAt == null ? null : str(path, raw.ciReadAt, `${what}.ciReadAt`),
    failure: raw.failure == null ? null : str(path, raw.failure, `${what}.failure`),
    mergeCardId: raw.mergeCardId == null ? null : str(path, raw.mergeCardId, `${what}.mergeCardId`),
  }
}

function attempt(path: string, value: unknown, what: string): AttemptView {
  const raw = obj(path, value, what)
  const requested = obj(path, raw.requested, `${what}.requested`)
  const actual = raw.actual === null ? null : obj(path, raw.actual, `${what}.actual`)
  return {
    id: str(path, raw.id, `${what}.id`),
    generation: num(path, raw.generation, `${what}.generation`),
    state: str(path, raw.state, `${what}.state`),
    role: strOrNull(path, raw.role, `${what}.role`),
    requested: {
      tier: strOrNull(path, requested.tier, `${what}.requested.tier`),
      model: strOrNull(path, requested.model, `${what}.requested.model`),
    },
    actual:
      actual === null
        ? null
        : {
            model: strOrNull(path, actual.model, `${what}.actual.model`),
            engine: strOrNull(path, actual.engine, `${what}.actual.engine`),
            slotLabel: strOrNull(path, actual.slotLabel, `${what}.actual.slotLabel`),
          },
    baseSha: strOrNull(path, raw.baseSha, `${what}.baseSha`),
    headSha: strOrNull(path, raw.headSha, `${what}.headSha`),
    processOutcome: str(path, raw.processOutcome, `${what}.processOutcome`),
    placement: typeof raw.placement === 'string' ? raw.placement : null,
    lastActivityAt: strOrNull(path, raw.lastActivityAt, `${what}.lastActivityAt`),
  }
}

function check(path: string, value: unknown, what: string): CheckView {
  const raw = obj(path, value, what)
  return {
    name: str(path, raw.name, `${what}.name`),
    state: oneOf(path, raw.state, `${what}.state`, ['passed', 'failed', 'not-run']),
    headSha: strOrNull(path, raw.headSha, `${what}.headSha`),
    detail: strOrNull(path, raw.detail, `${what}.detail`),
    artifactRef: strOrNull(path, raw.artifactRef, `${what}.artifactRef`),
  }
}

function fileChange(path: string, value: unknown, what: string) {
  const raw = obj(path, value, what)
  return {
    path: str(path, raw.path, `${what}.path`),
    added: num(path, raw.added, `${what}.added`),
    removed: num(path, raw.removed, `${what}.removed`),
    ...(raw.binary === true && { binary: true as const }),
  }
}

function needItem(path: string, value: unknown, what: string): NeedItem {
  const raw = obj(path, value, what)
  const shared = {
    id: str(path, raw.id, `${what}.id`),
    repoId: strOrNull(path, raw.repoId, `${what}.repoId`),
    repoLabel: strOrNull(path, raw.repoLabel, `${what}.repoLabel`),
    workItemId: strOrNull(path, raw.workItemId, `${what}.workItemId`),
  }
  if (raw.kind === 'question') {
    return {
      kind: 'question',
      ...shared,
      question: str(path, raw.question, `${what}.question`),
      options: strings(path, raw.options, `${what}.options`),
      status: oneOf(path, raw.status, `${what}.status`, ['open', 'answered', 'expired']),
      askedAt: strOrNull(path, raw.askedAt, `${what}.askedAt`),
      answer: strOrNull(path, raw.answer, `${what}.answer`),
    }
  }
  if (raw.kind === 'card') {
    return {
      kind: 'card',
      ...shared,
      cls: str(path, raw.cls, `${what}.cls`),
      status: oneOf(path, raw.status, `${what}.status`, [
        'pending',
        'approved',
        'denied',
        'expired',
        'stale',
      ]),
      expiresAt: str(path, raw.expiresAt, `${what}.expiresAt`),
      detailPath: str(path, raw.detailPath, `${what}.detailPath`),
    }
  }
  if (raw.kind === 'work') {
    return {
      kind: 'work',
      ...shared,
      workItemId: str(path, raw.workItemId, `${what}.workItemId`),
      title: str(path, raw.title, `${what}.title`),
      stageKey: str(path, raw.stageKey, `${what}.stageKey`),
      stageLabel: str(path, raw.stageLabel, `${what}.stageLabel`),
      reason: strOrNull(path, raw.reason, `${what}.reason`),
      nextAction: strOrNull(path, raw.nextAction, `${what}.nextAction`),
      status: oneOf(path, raw.status, `${what}.status`, ['open']),
      since: str(path, raw.since, `${what}.since`),
      readOnly: bool(path, raw.readOnly, `${what}.readOnly`),
    }
  }
  throw new DecodeError(path, `${what}.kind is not a need this page knows`)
}

/** GET /api/inspect/work */
export function decodeWorkPage(raw: unknown): Page<WorkRow> {
  const path = '/api/inspect/work'
  return page(path, raw, (entry, label) => workRow(path, entry, label))
}

/** GET /api/inspect/work/:id */
export function decodeWorkDetail(raw: unknown): WorkDetail {
  const path = '/api/inspect/work/:id'
  const body = obj(path, raw, 'the body')
  const hold = body.hold === null ? null : obj(path, body.hold, 'hold')
  const retry = body.retry === null ? null : obj(path, body.retry, 'retry')
  return {
    ...workRow(path, body, 'the body'),
    originMessageId: strOrNull(path, body.originMessageId, 'originMessageId'),
    goal: strOrNull(path, body.goal, 'goal'),
    answer: typeof body.answer === 'string' ? body.answer : null,
    hold:
      hold === null
        ? null
        : { since: str(path, hold.since, 'hold.since'), reason: strOrNull(path, hold.reason, 'hold.reason') },
    planRevision: numOrNull(path, body.planRevision, 'planRevision'),
    tasks: list(path, body.tasks, 'tasks', (entry, label) => taskRow(path, entry, label)),
    tasksTruncated: num(path, body.tasksTruncated, 'tasksTruncated'),
    delegation: list(path, body.delegation, 'delegation', (entry, label) => {
      const row = obj(path, entry, label)
      const requested = obj(path, row.requested, `${label}.requested`)
      const activity = row.activity === null ? null : obj(path, row.activity, `${label}.activity`)
      return {
        taskId: str(path, row.taskId, `${label}.taskId`),
        title: str(path, row.title, `${label}.title`),
        role: strOrNull(path, row.role, `${label}.role`),
        status: str(path, row.status, `${label}.status`),
        requested: {
          tier: strOrNull(path, requested.tier, `${label}.requested.tier`),
          model: strOrNull(path, requested.model, `${label}.requested.model`),
        },
        attempts: num(path, row.attempts, `${label}.attempts`),
        latest: row.latest === null ? null : attempt(path, row.latest, `${label}.latest`),
        waiting: strOrNull(path, row.waiting, `${label}.waiting`),
        activity:
          activity === null
            ? null
            : {
                summary: str(path, activity.summary, `${label}.activity.summary`),
                at: str(path, activity.at, `${label}.activity.at`),
              },
      }
    }),
    delivery: delivery(path, body.delivery, 'delivery'),
    retry:
      retry === null
        ? null
        : {
            kind: oneOf(path, retry.kind, 'retry.kind', ['integration', 'push', 'pr']),
            reason: str(path, retry.reason, 'retry.reason'),
          },
    coverage: coverage(path, body.coverage, 'coverage'),
    cursors: numberRecord(path, body.cursors, 'cursors'),
    cursorsTruncated: num(path, body.cursorsTruncated, 'cursorsTruncated'),
  }
}

/** GET /api/inspect/tasks/:id */
export function decodeTaskDetail(raw: unknown): TaskDetail {
  const path = '/api/inspect/tasks/:id'
  const body = obj(path, raw, 'the body')
  const checks = obj(path, body.checks, 'checks')
  const diff = obj(path, body.diff, 'diff')
  const usage = obj(path, body.usage, 'usage')
  return {
    ...taskRow(path, body, 'the body'),
    workItemId: str(path, body.workItemId, 'workItemId'),
    repoId: strOrNull(path, body.repoId, 'repoId'),
    objective: str(path, body.objective, 'objective'),
    attempts: list(path, body.attempts, 'attempts', (entry, label) => attempt(path, entry, label)),
    attemptsTruncated: num(path, body.attemptsTruncated, 'attemptsTruncated'),
    checks: {
      headSha: strOrNull(path, checks.headSha, 'checks.headSha'),
      results: list(path, checks.results, 'checks.results', (entry, label) => check(path, entry, label)),
      truncated: num(path, checks.truncated, 'checks.truncated'),
    },
    diff: {
      headSha: strOrNull(path, diff.headSha, 'diff.headSha'),
      summary: strOrNull(path, diff.summary, 'diff.summary'),
      files: list(path, diff.files, 'diff.files', (entry, label) => fileChange(path, entry, label)),
      truncated: num(path, diff.truncated, 'diff.truncated'),
    },
    usage: {
      reportedUsd: numOrNull(path, usage.reportedUsd, 'usage.reportedUsd'),
      missingAttempts: num(path, usage.missingAttempts, 'usage.missingAttempts'),
      mode: oneOf(path, usage.mode, 'usage.mode', ['api', 'subscription', 'unknown']),
    },
    coverage: coverage(path, body.coverage, 'coverage'),
  }
}

/** GET /api/inspect/attempts/:id/activity */
export function decodeActivityPage(raw: unknown): Page<ActivityItem> {
  const path = '/api/inspect/attempts/:id/activity'
  return page(path, raw, (entry, label) => {
    const item = obj(path, entry, label)
    return {
      seq: num(path, item.seq, `${label}.seq`),
      type: str(path, item.type, `${label}.type`),
      at: str(path, item.at, `${label}.at`),
      summary: str(path, item.summary, `${label}.summary`),
      detail: strOrNull(path, item.detail, `${label}.detail`),
    }
  })
}

export interface ArtifactResponse {
  contentType: string
  body: string
  /** `x-mec-artifact-size`, which only a text answer carries. */
  size: string | null
  /** `x-mec-next-cursor`, set while more of the file remains. */
  next: string | null
}

/** The body type decides, never the body: a JSON file served as text stays text. */
export function decodeArtifact(ref: string, response: ArtifactResponse): ArtifactPage {
  const path = '/api/inspect/artifacts'
  const { contentType, body, size, next } = response
  if (contentType.startsWith('text/plain')) {
    if (size === null || !/^\d+$/.test(size)) throw new DecodeError(path, 'the size header is missing')
    return { kind: 'text', ref, text: body, size: Number(size), nextCursor: next }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new DecodeError(path, 'the answer is neither text nor JSON')
  }
  const meta = obj(path, parsed, 'the body')
  if (meta.binary !== true) throw new DecodeError(path, 'the answer is not binary metadata')
  return { kind: 'binary', ref, size: num(path, meta.size, 'size') }
}

/** GET /api/inspect/needs */
export function decodeNeedsPage(raw: unknown): Page<NeedItem> {
  const path = '/api/inspect/needs'
  return page(path, raw, (entry, label) => needItem(path, entry, label))
}

/** GET /api/inspect/snapshot */
export function decodeSnapshot(raw: unknown): Snapshot {
  const path = '/api/inspect/snapshot'
  const body = obj(path, raw, 'the body')
  return {
    observedAt: str(path, body.observedAt, 'observedAt'),
    repositories: list(path, body.repositories, 'repositories', (entry, label) => {
      const repo = obj(path, entry, label)
      return {
        id: str(path, repo.id, `${label}.id`),
        label: strOrNull(path, repo.label, `${label}.label`),
        needsCount: num(path, repo.needsCount, `${label}.needsCount`),
      }
    }),
    repositoriesTruncated: num(path, body.repositoriesTruncated, 'repositoriesTruncated'),
    needsCount: num(path, body.needsCount, 'needsCount'),
    cursors: numberRecord(path, body.cursors, 'cursors'),
  }
}

/** GET /api/inspect/search */
export function decodeSearchPage(raw: unknown): Page<SearchHit> {
  const path = '/api/inspect/search'
  return page(path, raw, (entry, label): SearchHit => {
    const hit = obj(path, entry, label)
    return {
      kind: oneOf(path, hit.kind, `${label}.kind`, ['message', 'work', 'task', 'attempt', 'reference']),
      id: str(path, hit.id, `${label}.id`),
      title: str(path, hit.title, `${label}.title`),
      repoLabel: strOrNull(path, hit.repoLabel, `${label}.repoLabel`),
      workItemId: strOrNull(path, hit.workItemId, `${label}.workItemId`),
    }
  })
}

/** GET /api/inbox/:id/detail. The route leaves `verb`, a check's `note` and a fact's `mono` out. */
export function decodeCardEvidence(raw: unknown): CardEvidence {
  const path = '/api/inbox/:id/detail'
  const body = obj(path, raw, 'the body')
  const consequences = obj(path, body.consequences, 'consequences')
  const diff = obj(path, body.diff, 'diff')
  return {
    ...(body.absent === true && { absent: true as const }),
    what: str(path, body.what, 'what'),
    verb: typeof body.verb === 'string' ? body.verb : null,
    why: str(path, body.why, 'why'),
    facts: list(path, body.facts, 'facts', (entry, label) => {
      const fact = obj(path, entry, label)
      return {
        label: str(path, fact.label, `${label}.label`),
        value: str(path, fact.value, `${label}.value`),
        mono: fact.mono === true,
      }
    }),
    operation: str(path, body.operation, 'operation'),
    requestedBy: str(path, body.requestedBy, 'requestedBy'),
    consequences: {
      approve: str(path, consequences.approve, 'consequences.approve'),
      deny: str(path, consequences.deny, 'consequences.deny'),
    },
    checks: list(path, body.checks, 'checks', (entry, label) => {
      const row = obj(path, entry, label)
      return {
        name: str(path, row.name, `${label}.name`),
        state: oneOf(path, row.state, `${label}.state`, ['passed', 'failed', 'running', 'none']),
        note: typeof row.note === 'string' ? row.note : null,
      }
    }),
    diff: {
      summary: str(path, diff.summary, 'diff.summary'),
      files: list(path, diff.files, 'diff.files', (entry, label) => fileChange(path, entry, label)),
    },
  }
}

/** GET /api/inspect/meta */
export function decodeMeta(raw: unknown): MetaAnswer {
  const path = '/api/inspect/meta'
  const body = obj(path, raw, 'the body')
  const connection = body.connection === null ? null : obj(path, body.connection, 'connection')
  return {
    observedAt: str(path, body.observedAt, 'observedAt'),
    connection:
      connection === null
        ? null
        : {
            slotLabel: strOrNull(path, connection.slotLabel, 'connection.slotLabel'),
            engine: strOrNull(path, connection.engine, 'connection.engine'),
            model: strOrNull(path, connection.model, 'connection.model'),
            modelAt: strOrNull(path, connection.modelAt, 'connection.modelAt'),
          },
    repositories: list(path, body.repositories, 'repositories', (entry, label) => {
      const row = obj(path, entry, label)
      return {
        repoId: str(path, row.repoId, `${label}.repoId`),
        state: str(path, row.state, `${label}.state`),
        line: str(path, row.line, `${label}.line`),
        workItemId: strOrNull(path, row.workItemId, `${label}.workItemId`),
        running: bool(path, row.running, `${label}.running`),
        at: strOrNull(path, row.at, `${label}.at`),
      }
    }),
  }
}

/** GET /api/chat/messages: the fields the conversation shows, and no others. */
export function decodeChatLines(raw: unknown): ChatLine[] {
  const path = '/api/chat/messages'
  return list(path, raw, 'the body', (entry, label) => {
    const line = obj(path, entry, label)
    return {
      id: str(path, line.id, `${label}.id`),
      text: str(path, line.text, `${label}.text`),
      createdAt: str(path, line.createdAt, `${label}.createdAt`),
      workItemId: typeof line.workItemId === 'string' ? line.workItemId : null,
      kind: typeof line.kind === 'string' ? line.kind : null,
      ...(typeof line.ackText === 'string' && { ackText: line.ackText }),
      ...(typeof line.replyText === 'string' && { replyText: line.replyText }),
      ...(typeof line.idempotencyKey === 'string' && { idempotencyKey: line.idempotencyKey }),
      ...(line.secretGuard === true && { secretGuard: true as const }),
      ...(typeof line.replyText === 'string' && { replyText: line.replyText }),
      ...(typeof line.pausedAck === 'string' && { pausedAck: line.pausedAck }),
    }
  })
}
