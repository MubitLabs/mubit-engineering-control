/**
 * The scheduler pass (spec §11): one function, inside `atomic`, that plan commit, lift and the
 * timer all use. It reads persisted state, so a pass after a restart decides what the one before
 * it would have. Per open work item it settles what attempts have finished, then places what is
 * ready through `planDispatches`, and every task it does not place carries why, and what releases
 * it. Nothing here runs an engine: it writes queued attempts and their `launch` rows, and the
 * launch gate re-checks authority when a row runs.
 *
 * - **Capacity is what the store says.** A `queued` attempt holds its task and slot, because the
 *   next pass runs two seconds later. A queued attempt whose launch row gave up holds nothing.
 * - **Holds and stops.** Held, stopped and withdrawn work gets no launch (§13.4, decision #20).
 * - **Placement grants, the planner only asks.** A pin is honoured, a model request must resolve
 *   on the slot, and nothing unavailable silently becomes a default (§3, §11).
 */
import { randomBytes } from 'node:crypto'
import type { Effects, EngineId, Json, Report, Store, StoreDoc } from '@mec/contracts'
import { ModelRequest } from '@mec/contracts'
import type {
  AttemptState,
  BasePolicy,
  BoundFinding,
  Caps,
  Placement,
  SchedulableTask,
  SlotModelsView,
  SlotView,
} from '@mec/domain'
import {
  ACTIVE_ATTEMPT_STATES,
  acceptance,
  canTransition,
  dependencySatisfied,
  planDispatches,
  TASK_MACHINE,
  transition,
  WORK_ITEM_MACHINE,
} from '@mec/domain'
import { type ResolvedModel, resolveModel } from '../../runtime/src/model'
import { repoOf } from './admission'
import {
  blockWork,
  cannotStartYet,
  HOST_RUN_UNAGREED,
  holdsGroup,
  hostRunAgreed,
  isHeld,
  isTerminal,
  mandateOf,
  noVerdict,
  processingOf,
} from './authority'
import { ceilingWords, UTILISATION_CEILING } from './ceiling'
import { enqueueWake, type FollowUps } from './followups'
import { type Continuation, nextRepair, nextReview, repairLedger } from './repair'
import { classifyWake } from './wakes'
import { integrationDocId, requiredChecks, verdictsOf } from './work-facts'

/** The capability table `resolveModel` reads; the planner's seam supplies it. */
export type PlacementTable = Parameters<typeof resolveModel>[2]

/** A launch a pass enqueued, as persisted on the message doc so replays reuse the key. */
export type LaunchRecord = { attemptId: string; key: string; taskId: string; slotId: string }

export type SchedulerDeps = {
  store: Store
  effects: Effects
  caps: Caps
  /** The slots a launch can start on, marks included. */
  slots: () => readonly SlotModelsView[]
  /** The meta slot's engine, which unpinned work prefers where the tier fits; absent, nothing does. */
  metaEngine?: () => string | undefined
  table: () => PlacementTable | undefined
  followups: FollowUps
  /** A launch row's state, when the queue can say. `failed` means it gave up. */
  launchRowState?: (key: string) => string | undefined
}

/** A task's stored defer: why it waits, and what lets it go. */
type Deferred = { reason: string; releases: string }

/** What holds a task and a slot. `queued` is here: a launch in the queue is a claim on both. */
const OCCUPYING: readonly AttemptState[] = ['queued', ...ACTIVE_ATTEMPT_STATES]

/** The single slot v0 dispatches onto while MEC_FAKE_ENGINE=1. */
const FAKE_SLOT: SlotView = {
  id: 'fake-slot',
  state: 'healthy',
  usageUtilization: 0,
  inUse: 0,
  concurrency: 4,
  pinnedRoles: [],
}

const RELEASES: Readonly<Record<string, string>> = {
  capacity: 'a slot unit comes free',
  slot_unhealthy: 'a healthy slot matches this task',
  model_unavailable: 'a slot serves the requested model',
  confirmation: 'the confirmation settles',
  policy: 'policy allows it',
}

const launchKey = (attempt: StoreDoc): string => `${String(attempt.id)}:${Number(attempt.generation ?? 1)}`

function occupies(deps: SchedulerDeps, attempt: StoreDoc): boolean {
  const state = String(attempt.state) as AttemptState
  if (cannotStartYet(deps.store, attempt)) return false
  // A resume on its way holds what it held, or a new task would take its place (§20).
  if (attempt.resuming === true) return true
  if (!OCCUPYING.includes(state)) return false
  if (state === 'queued') return deps.launchRowState?.(launchKey(attempt)) !== 'failed'
  return !noVerdict(attempt)
}

/** Numbered ids sort as numbers: `att_10` is later than `att_9`. */
const attemptOrder = (doc: StoreDoc): number => Number(/^att_(\d+)$/.exec(String(doc.id))?.[1] ?? 0)

const latestOf = (attempts: readonly StoreDoc[]): StoreDoc | undefined =>
  [...attempts]
    .sort(
      (a, b) =>
        String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
        attemptOrder(a) - attemptOrder(b),
    )
    .at(-1)

function failure(deps: SchedulerDeps, attempt: StoreDoc): string | undefined {
  const id = String(attempt.id)
  const state = String(attempt.state)
  if (state === 'failed')
    return `attempt ${id} failed: ${String(attempt.terminal_reason ?? 'no reason given')}`
  if (state === 'checks_failed') return `attempt ${id} failed its checks on ${String(attempt.head_sha)}`
  // Stopped work is fenced, and a restart resumes (M2.4). Only the budget ending it is a failure.
  if (state === 'interrupted' && attempt.terminal_reason === 'wall_clock') {
    return `attempt ${id} ran out of its wall clock`
  }
  // The same clock landing during a repo check ends in `checksSkipped`, with no interruption.
  if (noVerdict(attempt) && attempt.checks_stopped === 'wall_clock') {
    return `attempt ${id} ran out of its wall clock`
  }
  if (noVerdict(attempt) && attempt.checks_stopped === 'head_moved') {
    return `attempt ${id} left a worktree that is not on the head it reported`
  }
  if (state === 'queued' && deps.launchRowState?.(launchKey(attempt)) === 'failed') {
    return `attempt ${id} could not launch`
  }
  return undefined
}

function moveTask(store: Store, task: StoreDoc, event: string, fields: StoreDoc, at: string): StoreDoc {
  const moved = {
    ...task,
    ...fields,
    status: transition(TASK_MACHINE, String(task.status), event),
    updatedAt: at,
  }
  store.tasks.save(moved)
  return moved
}

/** What the attempt last said of itself (§10). The stored report is redacted. */
function lastReport(store: Store, attempt: StoreDoc): Pick<Report, 'kind' | 'summary'> | undefined {
  const doc = store.engines.get(`report/${String(attempt.id)}/${Number(attempt.reports ?? 0)}`)
  return doc?.report as Pick<Report, 'kind' | 'summary'> | undefined
}

/**
 * §10 and §15: an agent ending its turn is not success, and passing checks do not undo what it
 * said. `failed` and `blocked` block the task with the report's summary, and `dropped` ends it.
 * Red checks do not undo it either: a person must act, so no repair runs after a `blocked` or
 * `failed` report, whatever the head. `dropped` on a red head is no such word, and checks decide.
 * Returns whether the report settled the task. Runs before acceptance, on a task still waiting
 * for this attempt: a late report never takes back an accepted task.
 */
function settleOnReport(store: Store, task: StoreDoc, attempt: StoreDoc, at: string): boolean {
  const passedOrUnjudged = attempt.state === 'succeeded' || noVerdict(attempt)
  if (attempt.state !== 'checks_failed' && !passedOrUnjudged) return false
  if (task.status !== 'active' && task.status !== 'awaiting_review') return false
  const report = lastReport(store, attempt)
  const id = String(attempt.id)
  if (report?.kind === 'failed' || report?.kind === 'blocked') {
    blockTask(store, task, `attempt ${id} reported ${report.kind}: ${report.summary}`, at)
    return true
  }
  const said = report === undefined ? endedBlocked(store, attempt) : undefined
  if (said !== undefined) {
    blockTask(store, task, `attempt ${id} ended blocked with no report: ${said}`, at)
    return true
  }
  if (report?.kind !== 'dropped' || !passedOrUnjudged) return false
  const { deferred: _deferred, ...rest } = task
  moveTask(store, rest, 'cancel', { cancelledReason: `attempt ${id} dropped it: ${report.summary}` }, at)
  appendEvent(
    store,
    `work:${String(task.workItemId)}`,
    'task_cancelled',
    { taskId: String(task.id), attemptId: id, at },
    at,
  )
  return true
}

/** A turn's last words that open with `Blocked:`, markdown emphasis allowed. */
const BLOCKED_OPENING = /^[\s*_`>#]*blocked\s*[:*_]+\s*/i

/**
 * An attempt that sent no report but whose turn ended on a message opening with `Blocked:` said
 * it is blocked, plainly, so it reads as blocked and not as success (§15: an agent ending its turn
 * is not success). Only the turn's last message counts: an earlier one was overtaken. Returns that
 * message without its opening, or undefined.
 */
function endedBlocked(store: Store, attempt: StoreDoc): string | undefined {
  const generation = Number(attempt.generation ?? 1)
  const last = store.events
    .read(`attempt:${String(attempt.id)}`)
    .filter((event) => {
      const body = event.body as { role?: unknown; generation?: unknown } | null
      if (event.type !== 'message' || body?.role !== 'assistant') return false
      return body.generation === undefined || Number(body.generation) === generation
    })
    .at(-1)
  const text = String((last?.body as { text?: unknown } | undefined)?.text ?? '')
  if (!BLOCKED_OPENING.test(text)) return undefined
  const rest = text.replace(BLOCKED_OPENING, '').trim()
  return rest === '' ? 'no reason given' : rest
}

type Target = { worktree?: string; branch?: string }

const lastReportDoc = (store: Store, attempt: StoreDoc): StoreDoc | undefined =>
  store.engines.get(`report/${String(attempt.id)}/${Number(attempt.reports ?? 0)}`)

const kindOf = (attempt: StoreDoc): unknown => (attempt.continuation as { kind?: unknown } | undefined)?.kind

/**
 * The head a report speaks for. An attempt cannot commit (§8: the clone is read-only to its shell),
 * so MEC commits the tree it left, after it reported. A claim that named the worktree's real head,
 * or no claim at all, therefore speaks for that commit. A claim that was false stays false.
 */
function reportHead(doc: StoreDoc | undefined, attempt: StoreDoc): string | undefined {
  const claimed = (doc?.report as { head_sha?: string } | undefined)?.head_sha
  if (claimed === undefined || doc?.head_matches === true) return attempt.head_sha as string | undefined
  return claimed
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/** What the attempt's commits did against its base, and what the brief lets them do (§10, §14). */
function workFacts(task: StoreDoc, attempt: StoreDoc) {
  return {
    ...(typeof attempt.base_sha === 'string' && { base: attempt.base_sha }),
    ...(task.noChangeOk === true && { noChangeOk: true }),
    owned: strings(task.ownedPaths),
    ...(Array.isArray(attempt.changed_paths) && { changed: strings(attempt.changed_paths) }),
  }
}

/** What a reviewer said, bound to the commit it read (§15): the report's `finding` artifacts. */
function findingsOf(doc: StoreDoc | undefined, attempt: StoreDoc): BoundFinding[] {
  const artifacts = (doc?.report as { artifacts?: { kind: string; ref: string }[] } | undefined)?.artifacts
  return (artifacts ?? []).flatMap((artifact) =>
    artifact.kind === 'finding' ? [{ text: artifact.ref, sha: String(attempt.head_sha) }] : [],
  )
}

/** The commit a reviewer read and found nothing on; a review with no `ready` says nothing. */
function reviewedSha(store: Store, attempts: readonly StoreDoc[]): string | undefined {
  const reviews = attempts.filter((doc) => kindOf(doc) === 'review' && doc.state === 'succeeded')
  const clean = reviews.filter((doc) => {
    const report = lastReportDoc(store, doc)
    const ready = (report?.report as Report | undefined)?.kind === 'ready'
    return ready && findingsOf(report, doc).length === 0
  })
  return latestOf(clean)?.head_sha as string | undefined
}

/** One counter for a task and the repair tasks opened for it (decision #36). */
function familyOf(store: Store, task: StoreDoc): { attempts: StoreDoc[]; reports: StoreDoc[] } {
  const root = typeof task.repairOf === 'string' ? task.repairOf : String(task.id)
  const members = store.tasks
    .list({ workItemId: String(task.workItemId) })
    .filter((doc) => doc.id === root || doc.repairOf === root)
  const attempts = members.flatMap((doc) => store.attempts.list({ taskId: doc.id }))
  const reports = attempts.flatMap((attempt) =>
    Array.from({ length: Number(attempt.reports ?? 0) }, (_, index) =>
      store.engines.get(`report/${String(attempt.id)}/${index + 1}`),
    ).filter((doc) => doc !== undefined),
  )
  return { attempts, reports }
}

/** Every finding this task's reviewers made. Accepting the task means a later head answered them. */
function foundOn(store: Store, attempts: readonly StoreDoc[]): { text: string; disposition: string }[] {
  const found = attempts.flatMap((doc) => findingsOf(lastReportDoc(store, doc), doc))
  return [...new Set(found.map((finding) => finding.text))].map((text) => ({ text, disposition: 'fixed' }))
}

function acceptTask(
  store: Store,
  task: StoreDoc,
  attempt: StoreDoc,
  attempts: readonly StoreDoc[],
  at: string,
): void {
  let current = task
  if (canTransition(TASK_MACHINE, String(current.status), 'work_complete')) {
    current = moveTask(store, current, 'work_complete', {}, at)
  }
  if (!canTransition(TASK_MACHINE, String(current.status), 'review_accepted')) return
  const { deferred: _deferred, ...rest } = current
  const findings = foundOn(store, attempts)
  moveTask(
    store,
    rest,
    'review_accepted',
    {
      acceptedHead: attempt.head_sha ?? null,
      acceptedBranch: attempt.branch ?? null,
      ...(findings.length > 0 && { findings }),
    },
    at,
  )
  appendEvent(
    store,
    `work:${String(task.workItemId)}`,
    'task_accepted',
    { taskId: String(task.id), attemptId: String(attempt.id), head: (attempt.head_sha ?? null) as Json, at },
    at,
  )
}

/** Queues what comes next on the task; a pass places it through the same caps as any launch. */
function continueTask(store: Store, task: StoreDoc, next: Continuation, at: string): void {
  if (next.kind === 'review') {
    store.tasks.save({ ...task, next: next as unknown as Json, updatedAt: at })
    return
  }
  const event = task.status === 'awaiting_review' ? 'review_sent_back' : 'attempt_failed'
  moveTask(store, task, event, { next: next as unknown as Json }, at)
}

/**
 * §10, §15, decision #32: what a finished attempt's verdicts mean for its task. Reads only what
 * is stored, so a pass after a restart decides the same. A task with a continuation queued is
 * waiting for that attempt, and one the machine has moved on from stays where it is.
 */
function settleAttempt(
  deps: SchedulerDeps,
  task: StoreDoc,
  attempts: readonly StoreDoc[],
  latest: StoreDoc,
  at: string,
): void {
  const { store, caps } = deps
  if (task.next !== undefined || !['active', 'awaiting_review'].includes(String(task.status))) return
  const report = lastReportDoc(store, latest)
  const kind = (report?.report as Report | undefined)?.kind
  const claimed = reportHead(report, latest)
  const reviewed = reviewedSha(store, attempts)
  const decided = acceptance({
    attemptState: String(latest.state),
    ...(typeof latest.head_sha === 'string' && { head: latest.head_sha }),
    ...(kind !== undefined && { report: { kind, ...(claimed !== undefined && { headSha: claimed }) } }),
    required: requiredChecks(task, store.engines.get(String(task.repoId))),
    verdicts: verdictsOf(store, latest),
    findings: findingsOf(report, latest),
    policy: { sensitive: task.sensitive === true, ...(reviewed !== undefined && { reviewedSha: reviewed }) },
    // A reviewer reads and changes nothing, so no-change and owned paths judge the task's own work.
    ...(kindOf(latest) !== 'review' && workFacts(task, latest)),
  })
  if (decided.verdict === 'accepted') acceptTask(store, task, latest, attempts, at)
  if (decided.verdict === 'blocked') blockTask(store, task, decided.reason, at)
  if (decided.verdict !== 'repair' && decided.verdict !== 'review') return
  const target: Target = {
    ...(typeof latest.worktree === 'string' && { worktree: latest.worktree }),
    ...(typeof latest.branch === 'string' && { branch: latest.branch }),
  }
  const { attempts: family, reports } = familyOf(store, task)
  const ledger = repairLedger(family, reports)
  const step =
    decided.verdict === 'review'
      ? nextReview(decided.head, ledger, caps, target)
      : nextRepair(decided, ledger, caps, {
          ...target,
          ...(claimed !== undefined && { claimedHead: claimed }),
        })
  if ('block' in step) {
    blockTask(store, task, step.block, at)
    wakeOnUsedUp(deps.effects, task, step.block)
  } else {
    continueTask(store, task, step.next, at)
  }
}

/**
 * §6: used-up repairs are work parked with no automatic resolution, and no report may say so. The
 * key is the task's family, so a task wakes one turn however many checks failed or passes ran.
 */
function wakeOnUsedUp(effects: Effects, task: StoreDoc, what: string): void {
  const workItemId = String(task.workItemId)
  if (classifyWake({ kind: 'work_parked', workItemId, autoResolvable: false }) !== 'wake') return
  const root = typeof task.repairOf === 'string' ? task.repairOf : String(task.id)
  enqueueWake(effects, { causationId: `used-up:${root}`, reason: 'work parked', detail: what, workItemId })
}

/**
 * §14, decision #36: a conflict or red combined checks open a repair task, on the same counter as
 * its task's own repairs, in the integration worktree. At the cap the task blocks with what
 * remains. A task already integrated cannot block, so its work does.
 */
export function openRepairTask(
  store: Store,
  effects: Effects,
  caps: Caps,
  input: { root: StoreDoc; evidence: string; worktree: string; branch: string; id: string; at: string },
): void {
  const { root, evidence, worktree, branch, id, at } = input
  const { attempts, reports } = familyOf(store, root)
  const ledger = repairLedger(attempts, reports)
  const decided = { verdict: 'repair', reason: 'integration', evidence } as const
  const step = nextRepair(decided, ledger, caps, { worktree, branch })
  if ('block' in step) {
    if (canTransition(TASK_MACHINE, String(root.status), 'block')) blockTask(store, root, step.block, at)
    else blockWork(store, String(root.workItemId), step.block, at)
    wakeOnUsedUp(effects, root, step.block)
    return
  }
  saveRepairTask(store, root, { id, objective: evidence, next: step.next, at })
}

/** The repair task of an integration, in its worktree, ready for the next pass to place. */
function saveRepairTask(
  store: Store,
  root: StoreDoc,
  input: { id: string; objective: string; next: Continuation; at: string },
): void {
  const { id, objective, next, at } = input
  const number = store.tasks.list({ workItemId: String(root.workItemId) }).length + 1
  store.tasks.save({
    id,
    workItemId: root.workItemId ?? null,
    repoId: root.repoId ?? null,
    localKey: `repair-${number}`,
    repairOf: root.id ?? null,
    planRevision: root.planRevision ?? null,
    objective,
    dependsOn: [],
    role: 'repair_agent',
    basePolicy: 'integration',
    status: 'ready',
    acceptanceChecks: root.acceptanceChecks ?? [],
    originalRequestRef: root.originalRequestRef ?? null,
    // The tier the planner asked for, and why, holds for the repair of its work too.
    ...(root.modelRequest !== undefined && { modelRequest: root.modelRequest }),
    next: next as unknown as Json,
    createdAt: at,
    updatedAt: at,
  })
  appendEvent(
    store,
    `work:${String(root.workItemId)}`,
    'repair_opened',
    { taskId: id, repairOf: String(root.id), at },
    at,
  )
}

/** What a person, and only a person, may answer with one more repair (owner ruling 2026-11-07). */
const OWNER_RETRYABLE = /^(repairs used up |attempt \S+ (reported blocked|ended blocked with no report): )/

/** `integration` is set when the repair belongs in the integration worktree: its task is already integrated. */
export type OwnerRepairOffer = {
  taskId: string
  reason: string
  integration?: { worktree: string; branch: string }
}
export type OwnerRepairOutcome =
  | { status: 'retrying'; taskId: string }
  | { status: 'missing' }
  | { status: 'refused'; error: string }

/**
 * Blocked work whose task used up its repairs or reported blocked offers the owner "Try again":
 * one fresh repair attempt in that task's worktree. Held, stopped and ended work offers nothing,
 * and neither does a repository not agreed to host runs, since the attempt runs its commands. A
 * task with an attempt still holding its place has nothing to try again yet.
 */
export function ownerRepairOffer(store: Store, work: StoreDoc): OwnerRepairOffer | undefined {
  if (isTerminal(work) || isHeld(work) || mandateOf(work).status === 'withdrawn') return undefined
  if (work.state !== 'blocked' || !hostRunAgreed(store, repoOf(work))) return undefined
  const workItemId = String(work.id)
  const target = store.tasks
    .list({ workItemId })
    .filter((task) => task.status === 'blocked' && OWNER_RETRYABLE.test(String(task.blockedReason ?? '')))
    .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')))
    .at(-1)
  const offer =
    target === undefined
      ? integrationRepairOffer(store, work)
      : { taskId: String(target.id), reason: String(target.blockedReason) }
  if (offer === undefined) return undefined
  const live = store.attempts.list({ workItemId }).some((attempt) => {
    const state = String(attempt.state) as AttemptState
    return state === 'queued' || ACTIVE_ATTEMPT_STATES.includes(state)
  })
  return live ? undefined : offer
}

/**
 * Combined checks that failed after their task was integrated: the used-up block lands on the work,
 * since that task cannot block, so no task carries it. The integration record names the task and
 * its worktree, which is where one more repair runs (§14, decision #36).
 */
function integrationRepairOffer(store: Store, work: StoreDoc): OwnerRepairOffer | undefined {
  const reason = String(work.blockedReason ?? '')
  if (!OWNER_RETRYABLE.test(reason)) return undefined
  const record = store.engines.get(integrationDocId(String(work.id)))
  const failed = record?.failed as { taskId?: unknown; repairing?: unknown } | undefined
  if (failed?.repairing !== true || typeof failed.taskId !== 'string') return undefined
  const { worktree, branch } = record ?? {}
  if (typeof worktree !== 'string' || typeof branch !== 'string') return undefined
  if (store.tasks.get(failed.taskId)?.status !== 'integrated') return undefined
  return { taskId: failed.taskId, reason, integration: { worktree, branch } }
}

/**
 * The owner's Try again, inside one transaction so a second press finds nothing. The task goes
 * back to ready with one repair queued on it, carrying where it stopped; its dependents blocked
 * on it go back to ready, and the work leaves blocked. The next pass places the attempt through
 * the same caps and gates as any launch, so a hold or a stop landing first still wins. The
 * repair counter keeps counting: a failure blocks again with what remains.
 */
export function ownerRetryRepair(store: Store, workItemId: string, at: string): OwnerRepairOutcome {
  return store.atomic((): OwnerRepairOutcome => {
    const work = store.workItems.get(workItemId)
    if (work === undefined) return { status: 'missing' }
    if (mandateOf(work).status === 'withdrawn') return { status: 'refused', error: 'mandate_withdrawn' }
    if (isHeld(work)) return { status: 'refused', error: 'held' }
    const offer = ownerRepairOffer(store, work)
    if (offer === undefined) {
      const waits = work.state === 'blocked' && !hostRunAgreed(store, repoOf(work))
      return { status: 'refused', error: waits ? HOST_RUN_UNAGREED : 'nothing_to_retry' }
    }
    const task = store.tasks.get(offer.taskId) as StoreDoc
    const latest = latestOf(store.attempts.list({ taskId: offer.taskId }))
    const { attempts, reports } = familyOf(store, task)
    const evidence = `The owner asked to try again. Where it stopped:\n${offer.reason}`
    const round = repairLedger(attempts, reports).rounds
    if (offer.integration !== undefined) {
      const id = `task_${randomBytes(6).toString('hex')}`
      const next: Continuation = { kind: 'repair', role: 'repair_agent', evidence, round, origin: 'owner' }
      saveRepairTask(store, task, { id, objective: evidence, next: { ...next, ...offer.integration }, at })
      const { blockedReason: _blocked, ...free } = work
      store.workItems.save({
        ...free,
        state: transition(WORK_ITEM_MACHINE, String(work.state), 'resume_integrating'),
        updatedAt: at,
      })
      appendEvent(
        store,
        `work:${workItemId}`,
        'retry_requested',
        { workItemId, kind: 'repair', taskId: id, origin: 'owner', at },
        at,
      )
      return { status: 'retrying', taskId: id }
    }
    const next: Continuation = {
      kind: 'repair',
      role: 'repair_agent',
      evidence,
      round,
      origin: 'owner',
      ...(typeof latest?.worktree === 'string' && { worktree: latest.worktree }),
      ...(typeof latest?.branch === 'string' && { branch: latest.branch }),
    }
    const { blockedReason: _reason, deferred: _deferred, ...rest } = task
    moveTask(store, rest, 'unblock', { next: next as unknown as Json }, at)
    for (const dependent of store.tasks.list({ workItemId })) {
      if (
        dependent.status !== 'blocked' ||
        !String(dependent.blockedReason ?? '').startsWith('prerequisite ')
      ) {
        continue
      }
      const { blockedReason: _why, ...kept } = dependent
      moveTask(store, kept, 'unblock', {}, at)
    }
    const { blockedReason: _blocked, ...free } = work
    store.workItems.save({
      ...free,
      state: transition(WORK_ITEM_MACHINE, String(work.state), 'resume_executing'),
      updatedAt: at,
    })
    appendEvent(
      store,
      `work:${workItemId}`,
      'retry_requested',
      { workItemId, kind: 'repair', taskId: offer.taskId, origin: 'owner', at },
      at,
    )
    return { status: 'retrying', taskId: offer.taskId }
  })
}

/** §10: work reaches `reviewing` with the first finished task and `integrating` with the first accepted. */
function advanceWork(store: Store, workItemId: string, at: string): void {
  const statuses = store.tasks.list({ workItemId }).map((task) => String(task.status))
  const accepted = statuses.some((status) => status === 'accepted' || status === 'integrated')
  const reviewing = accepted || statuses.includes('awaiting_review')
  const events = [...(reviewing ? ['review_started'] : []), ...(accepted ? ['integration_started'] : [])]
  for (const event of events) {
    const work = store.workItems.get(workItemId) as StoreDoc
    if (!canTransition(WORK_ITEM_MACHINE, String(work.state), event)) continue
    store.workItems.save({
      ...work,
      state: transition(WORK_ITEM_MACHINE, String(work.state), event),
      updatedAt: at,
    })
  }
}

export function blockTask(store: Store, task: StoreDoc, reason: string, at: string): void {
  const { deferred: _deferred, ...rest } = task
  moveTask(store, rest, 'block', { blockedReason: reason }, at)
  appendEvent(
    store,
    `work:${String(task.workItemId)}`,
    'task_blocked',
    { taskId: String(task.id), reason, at },
    at,
  )
}

const dependencyName = (task: StoreDoc | undefined, id: string): string =>
  typeof task?.localKey === 'string' ? task.localKey : id

/** What attempts have finished means for their tasks, and for whatever waits on those. */
function settleTasks(deps: SchedulerDeps, workItemId: string, at: string): void {
  const { store } = deps
  for (const task of store.tasks.list({ workItemId })) {
    const attempts = store.attempts.list({ taskId: task.id })
    const latest = latestOf(attempts)
    if (latest === undefined) continue
    if (settleOnReport(store, task, latest, at)) continue
    // Checks that were stopped are no verdict to judge: `failure` says what the stop means.
    const stopped = noVerdict(latest) && latest.checks_stopped !== undefined
    if (['succeeded', 'checks_failed'].includes(String(latest.state)) || (noVerdict(latest) && !stopped)) {
      settleAttempt(deps, task, attempts, latest, at)
      continue
    }
    const failed = failure(deps, latest)
    if (failed === undefined || attempts.some((attempt) => occupies(deps, attempt))) continue
    if (canTransition(TASK_MACHINE, String(task.status), 'block')) blockTask(store, task, failed, at)
  }
  blockDependents(store, workItemId, at)
  advanceWork(store, workItemId, at)
  const tasks = store.tasks.list({ workItemId })
  const blocked = tasks.find((task) => task.status === 'blocked')
  const open = tasks.some((task) => ['ready', 'active', 'awaiting_review'].includes(String(task.status)))
  if (blocked !== undefined && !open) {
    blockWork(store, workItemId, String(blocked.blockedReason ?? 'a task is blocked'), at)
  }
}

/** A blocked or cancelled prerequisite blocks its dependents, transitively, each with its reason. */
function blockDependents(store: Store, workItemId: string, at: string): void {
  for (;;) {
    const tasks = store.tasks.list({ workItemId })
    const byId = new Map(tasks.map((task) => [String(task.id), task]))
    let moved = false
    for (const task of tasks) {
      if (task.status !== 'ready') continue
      const stuck = dependsOnOf(task).find((dep) => {
        const status = byId.get(dep)?.status
        return status === 'blocked' || status === 'cancelled'
      })
      if (stuck === undefined) continue
      const prerequisite = byId.get(stuck)
      const why =
        prerequisite?.blockedReason ??
        prerequisite?.cancelledReason ??
        `it is ${String(prerequisite?.status)}`
      const reason = `prerequisite ${dependencyName(prerequisite, stuck)} cannot finish: ${String(why)}`
      blockTask(store, task, reason, at)
      moved = true
    }
    if (!moved) return
  }
}

const dependsOnOf = (task: StoreDoc): string[] =>
  Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []

const basePolicyOf = (task: StoreDoc): BasePolicy =>
  task.basePolicy === 'contract' ? 'contract' : 'integration'

/** Which prerequisite is not there yet, or undefined when the task may start (§14). */
function unmetDependency(task: StoreDoc, statuses: ReadonlyMap<string, StoreDoc>): Deferred | undefined {
  const policy = basePolicyOf(task)
  for (const dep of dependsOnOf(task)) {
    const prerequisite = statuses.get(dep)
    const status = prerequisite?.status
    const met = (status === 'accepted' || status === 'integrated') && dependencySatisfied(dep, status, policy)
    if (!met) {
      const needed = policy === 'contract' ? 'accepted' : 'integrated'
      return { reason: 'dependency', releases: `${dependencyName(prerequisite, dep)} is ${needed}` }
    }
  }
  return undefined
}

/**
 * The owner's ruling (8 November 2026): the first time work waits on a connection's ceiling, chat
 * says so on that work, once. The task's own words follow later readings; this line does not.
 */
function tellCeilingOnce(store: Store, workItemId: string, words: string, at: string): void {
  const id = `msg_ceiling_${workItemId}`
  if (store.messages.get(id) !== undefined) return
  const repoId = repoOf(store.workItems.get(workItemId))
  store.messages.save({
    id,
    text: `Waiting: ${words}`,
    routing: 'notice',
    notice: true,
    workItemId,
    ...(repoId !== undefined && { repoId }),
    createdAt: at,
    updatedAt: at,
  })
}

/** Writes a task's defer only when it changed. Returns whether it did, so events stay one each. */
function defer(store: Store, task: StoreDoc, deferred: Deferred, at: string): boolean {
  const stored = task.deferred as Deferred | undefined
  if (stored?.reason === deferred.reason && stored.releases === deferred.releases) return false
  store.tasks.save({ ...task, deferred: { ...deferred, at }, updatedAt: at })
  return true
}

/** The slots that resolve this task's model request (§11, O7), with what each resolved to. */
function modelFit(
  deps: SchedulerDeps,
  task: StoreDoc,
  views: readonly SlotModelsView[],
): { modelSlots?: string[]; degradedSlots?: string[]; resolved: Map<string, ResolvedModel> } {
  const resolved = new Map<string, ResolvedModel>()
  if (task.modelRequest === undefined || process.env.MEC_FAKE_ENGINE === '1') return { resolved }
  const request = ModelRequest.safeParse(task.modelRequest)
  const table = deps.table()
  if (!request.success || table === undefined) return { modelSlots: [], resolved }
  for (const view of views) {
    try {
      const provider = view.provider
      const slot = { engine: view.engine as EngineId, ...(provider !== undefined && { provider }) }
      // §3 rule 2: what the slot's engine does not offer is never chosen, so the next one is.
      const unavailable = new Set(
        Object.entries(view.marks).flatMap(([key, mark]) => (mark === 'unavailable' ? [key] : [])),
      )
      const model = resolveModel(request.data, slot, table, { unavailable })
      if (view.marks[model.model] !== 'unavailable') resolved.set(view.slotId, model)
    } catch {
      // Refused for this slot: another may serve it, and if none does the task defers.
    }
  }
  const degradedSlots = [...resolved].flatMap(([slotId, model]) =>
    model.tier_degraded === undefined ? [] : [slotId],
  )
  return { modelSlots: [...resolved.keys()], degradedSlots, resolved }
}

function nextAttemptId(store: Store): string {
  let max = 0
  for (const doc of store.attempts.list()) max = Math.max(max, attemptOrder(doc))
  return `att_${max + 1}`
}

/** What really decided this launch: a step that changed nothing is not claimed (§7, §11). */
function rationale(
  task: SchedulableTask,
  slotId: string,
  placement: Placement,
  metaEngine: string | undefined,
): string {
  if (placement.pinned) return `pinned to ${slotId} by the plan`
  const { candidates } = placement
  const said = [
    ...(placement.missed.includes('slot_class') ? [`no candidate in slot class ${task.slotClass}`] : []),
    ...(placement.narrowedBy.includes('slot_class') ? [`in slot class ${task.slotClass}`] : []),
    ...(placement.narrowedBy.includes('engine') ? [`on the meta agent's engine, ${metaEngine}`] : []),
    ...(placement.missed.includes('engine') ? [`no ${metaEngine} slot fits`] : []),
    ...(placement.tiebreak === 'only_candidate' ? ['the only candidate'] : []),
    ...(placement.tiebreak === 'utilisation' ? [`lowest utilisation of ${candidates} candidates`] : []),
    ...(placement.tiebreak === 'load' ? [`fewest attempts of ${candidates} candidates`] : []),
    ...(placement.tiebreak === 'id' ? [`first by id of ${candidates} tied candidates`] : []),
  ]
  return `${slotId}: ${said.join('; ')}`
}

/**
 * One pass. `workItemId` names a commit's own work, so a no-repository plan says why it did not
 * launch; a timer's pass leaves it unset. Must run inside `atomic`, because a launch row is
 * enqueued with its attempt. Returns the launches of `workItemId` when set, else all of them.
 */
export function schedulePass(deps: SchedulerDeps, opts: { at: string; workItemId?: string }): LaunchRecord[] {
  const { store, effects, caps, followups } = deps
  const { at, workItemId: scoped } = opts
  if (processingOf(store).paused) return []
  followups.sweep(at)

  const ready: SchedulableTask[] = []
  const candidates = new Map<string, { doc: StoreDoc; resolved: Map<string, ResolvedModel> }>()
  const views = deps.slots()

  for (const listed of store.workItems.list()) {
    const workItemId = String(listed.id)
    if (isTerminal(listed) || mandateOf(listed).status === 'withdrawn') continue
    if (store.tasks.list({ workItemId }).length === 0) continue
    if (repoOf(listed) === undefined) {
      // Unassigned work is planned but never launched, and nothing rewrites a legacy row.
      if (workItemId === scoped) {
        const reason = 'no repository'
        appendEvent(store, `work:${workItemId}`, 'launch_withheld', { workItemId, reason, at }, at)
      }
      continue
    }
    settleTasks(deps, workItemId, at)
    const work = store.workItems.get(workItemId) as StoreDoc
    if (String(work.state) === 'blocked') continue

    const tasks = store.tasks.list({ workItemId })
    const startable = tasks.filter((task) => {
      if (task.next !== undefined) return task.status === 'ready' || task.status === 'awaiting_review'
      return task.status === 'ready' && store.attempts.list({ taskId: task.id }).length === 0
    })
    if (isHeld(work)) {
      const held = { reason: 'held', releases: 'the owner lifts the hold' }
      const changed = startable.map((task) => defer(store, task, held, at)).some(Boolean)
      if (changed || workItemId === scoped) {
        appendEvent(store, `work:${workItemId}`, 'launch_withheld', { workItemId, reason: 'held', at }, at)
      }
      continue
    }
    if (!hostRunAgreed(store, repoOf(work))) {
      const unagreed = { reason: HOST_RUN_UNAGREED, releases: 'the owner agrees to host runs here' }
      const changed = startable.map((task) => defer(store, task, unagreed, at)).some(Boolean)
      if (changed || workItemId === scoped) {
        const body = { workItemId, reason: HOST_RUN_UNAGREED, at }
        appendEvent(store, `work:${workItemId}`, 'launch_withheld', body, at)
      }
      continue
    }

    const byId = new Map(tasks.map((task) => [String(task.id), task]))
    for (const task of startable) {
      const unmet = unmetDependency(task, byId)
      if (unmet !== undefined) {
        defer(store, task, unmet, at)
        continue
      }
      const taskId = String(task.id)
      const next = task.next as Continuation | undefined
      const { modelSlots, degradedSlots, resolved } = modelFit(deps, task, views)
      const hint = task.slotHint as { slotClass?: string; slotId?: string } | undefined
      candidates.set(taskId, { doc: task, resolved })
      ready.push({
        taskId,
        workItemId,
        workItemPinned: false,
        readyAt: Date.parse(String(task.createdAt ?? at)),
        generation: 1,
        role: next?.role ?? String(task.role),
        ...(hint?.slotClass !== undefined && { slotClass: hint.slotClass }),
        ...(hint?.slotId !== undefined && { slotId: hint.slotId }),
        ...(modelSlots !== undefined && { modelSlots }),
        ...(degradedSlots !== undefined && { degradedSlots }),
      })
    }
  }

  const active = store.attempts
    .list()
    .filter((doc) => occupies(deps, doc) || holdsGroup(doc))
    .map((doc) => ({
      taskId: String(doc.taskId),
      slotId: String(doc.slotId),
      workItemId: String(doc.workItemId),
    }))
  const inUse = (slotId: string): number => active.filter((row) => row.slotId === slotId).length
  const slots: SlotView[] =
    process.env.MEC_FAKE_ENGINE === '1'
      ? [{ ...FAKE_SLOT, inUse: inUse(FAKE_SLOT.id) }]
      : views.map((view) => ({
          id: view.slotId,
          engine: view.engine,
          state: view.healthy ? 'healthy' : 'degraded',
          pinnedRoles: [],
          inUse: inUse(view.slotId),
          concurrency: view.concurrency ?? caps.perSlot,
          ...(view.utilisation !== undefined && { usageUtilization: view.utilisation }),
          ...(view.slotClass !== undefined && { slotClass: view.slotClass }),
        }))

  const metaEngine = deps.metaEngine?.()
  const dispatch = planDispatches({
    ready,
    slots,
    active,
    caps,
    utilisationCeiling: UTILISATION_CEILING,
    // §11: a person continuing existing work goes before any launch.
    reservedWakeSlot: followups.deliveryWaiting(),
    ...(metaEngine !== undefined && { preferredEngine: metaEngine }),
  })

  for (const { taskId, reason, slotId } of dispatch.deferred) {
    const doc = candidates.get(taskId)?.doc
    if (doc === undefined) continue
    if (reason === 'utilisation_ceiling' && slotId !== undefined) {
      const words = ceilingWords(store.slots.get(slotId), slotId)
      defer(store, doc, { reason, releases: words }, at)
      tellCeilingOnce(store, String(doc.workItemId), words, at)
      continue
    }
    defer(store, doc, { reason, releases: RELEASES[reason] ?? reason }, at)
  }

  const records: LaunchRecord[] = []
  for (const [index, launch] of dispatch.launches.entries()) {
    const candidate = candidates.get(launch.taskId) as { doc: StoreDoc; resolved: Map<string, ResolvedModel> }
    const task = ready.find((row) => row.taskId === launch.taskId) as SchedulableTask
    const { deferred: _deferred, next, ...doc } = candidate.doc
    if (candidate.doc.deferred !== undefined || next !== undefined) {
      store.tasks.save({ ...doc, updatedAt: at })
    }
    const model = candidate.resolved.get(launch.slotId)
    const attemptId = nextAttemptId(store)
    const { workItemId } = task
    store.attempts.save({
      id: attemptId,
      taskId: launch.taskId,
      workItemId,
      slotId: launch.slotId,
      state: 'queued',
      generation: 1,
      placement: rationale(task, launch.slotId, dispatch.placements[index] as Placement, metaEngine),
      ...(next !== undefined && { role: task.role, continuation: next }),
      ...(model !== undefined && {
        resolved_model: model.model,
        ...(model.effort !== undefined && { effort: model.effort }),
        ...(model.tier_degraded !== undefined && { tier_degraded: model.tier_degraded }),
        ...(model.passed_over !== undefined && { models_passed_over: model.passed_over }),
      }),
      createdAt: at,
      updatedAt: at,
    })
    appendEvent(
      store,
      `attempt:${attemptId}`,
      'attempt_queued',
      { attemptId, taskId: launch.taskId, workItemId, slotId: launch.slotId, generation: 1, at },
      at,
    )
    const key = `${attemptId}:1`
    effects.enqueue('launch', key, {
      attempt_id: attemptId,
      task_id: launch.taskId,
      work_item_id: workItemId,
      slot_id: launch.slotId,
      generation: 1,
    })
    if (scoped === undefined || scoped === workItemId) {
      records.push({ attemptId, key, taskId: launch.taskId, slotId: launch.slotId })
    }
  }
  return records
}

function appendEvent(store: Store, stream: string, type: string, body: Json, at: string): void {
  const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
  store.events.append(stream, { stream, seq, at, type, body })
}
