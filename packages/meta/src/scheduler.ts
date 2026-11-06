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
import type { Effects, EngineId, Json, Report, Store, StoreDoc } from '@mec/contracts'
import { ModelRequest } from '@mec/contracts'
import type { AttemptState, BasePolicy, Caps, SchedulableTask, SlotModelsView, SlotView } from '@mec/domain'
import {
  ACTIVE_ATTEMPT_STATES,
  canTransition,
  dependencySatisfied,
  planDispatches,
  TASK_MACHINE,
  transition,
} from '@mec/domain'
import { type ResolvedModel, resolveModel } from '../../runtime/src/model'
import { repoOf } from './admission'
import { blockWork, isHeld, isTerminal, mandateOf, processingOf } from './authority'
import type { FollowUps } from './followups'

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
  table: () => PlacementTable | undefined
  followups: FollowUps
  /** A launch row's state, when the queue can say. `failed` means it gave up. */
  launchRowState?: (key: string) => string | undefined
}

/** A task's stored defer: why it waits, and what lets it go. */
type Deferred = { reason: string; releases: string }

/** §11 placement ceiling; no reading ranks least utilised, not high. */
const UTILISATION_CEILING = 0.8

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

/** A repo with no checks leaves its attempt `work_complete` with a note: no verdict is coming. */
const noVerdict = (attempt: StoreDoc): boolean =>
  attempt.state === 'work_complete' && typeof attempt.checks_note === 'string'

function occupies(deps: SchedulerDeps, attempt: StoreDoc): boolean {
  const state = String(attempt.state) as AttemptState
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
  if (state === 'queued' && deps.launchRowState?.(launchKey(attempt)) === 'failed') {
    return `attempt ${id} could not launch`
  }
  return undefined
}

/**
 * How many more attempts a failed task may have. Every task has one until bounded repair (M2.3):
 * §11 offers a retry only to a person, never as a loop.
 */
const attemptsLeft = (_task: StoreDoc, _attempts: readonly StoreDoc[]): number => 0

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
 * Returns whether the report settled the task. Runs before acceptance, on a task still waiting
 * for this attempt: a late report never takes back an accepted task.
 */
function settleOnReport(store: Store, task: StoreDoc, attempt: StoreDoc, at: string): boolean {
  if (attempt.state !== 'succeeded' && !noVerdict(attempt)) return false
  if (task.status !== 'active' && task.status !== 'awaiting_review') return false
  const report = lastReport(store, attempt)
  const id = String(attempt.id)
  if (report?.kind === 'failed' || report?.kind === 'blocked') {
    blockTask(store, task, `attempt ${id} reported ${report.kind}: ${report.summary}`, at)
    return true
  }
  if (report?.kind !== 'dropped') return false
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

/**
 * Decision #32, the one rule M2.3 replaces: an attempt that `succeeded` passed the registered
 * checks on its exact head, which accepts a routine task. No reviewer exists before M2.3.
 */
function acceptRoutine(store: Store, task: StoreDoc, attempt: StoreDoc, at: string): void {
  let current = task
  if (canTransition(TASK_MACHINE, String(current.status), 'work_complete')) {
    current = moveTask(store, current, 'work_complete', {}, at)
  }
  if (!canTransition(TASK_MACHINE, String(current.status), 'review_accepted')) return
  const { deferred: _deferred, ...rest } = current
  moveTask(store, rest, 'review_accepted', { acceptedHead: attempt.head_sha ?? null }, at)
  appendEvent(
    store,
    `work:${String(task.workItemId)}`,
    'task_accepted',
    { taskId: String(task.id), attemptId: String(attempt.id), head: (attempt.head_sha ?? null) as Json, at },
    at,
  )
}

function blockTask(store: Store, task: StoreDoc, reason: string, at: string): void {
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
    if (latest.state === 'succeeded') {
      acceptRoutine(store, task, latest, at)
      continue
    }
    const failed = failure(deps, latest)
    if (failed === undefined || attempts.some((attempt) => occupies(deps, attempt))) continue
    if (attemptsLeft(task, attempts) > 0) continue
    if (canTransition(TASK_MACHINE, String(task.status), 'block')) blockTask(store, task, failed, at)
  }
  blockDependents(store, workItemId, at)
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
): { modelSlots?: string[]; resolved: Map<string, ResolvedModel> } {
  const resolved = new Map<string, ResolvedModel>()
  if (task.modelRequest === undefined || process.env.MEC_FAKE_ENGINE === '1') return { resolved }
  const request = ModelRequest.safeParse(task.modelRequest)
  const table = deps.table()
  if (!request.success || table === undefined) return { modelSlots: [], resolved }
  for (const view of views) {
    try {
      const provider = view.provider
      const slot = { engine: view.engine as EngineId, ...(provider !== undefined && { provider }) }
      const model = resolveModel(request.data, slot, table)
      if (view.marks[model.model] !== 'unavailable') resolved.set(view.slotId, model)
    } catch {
      // Refused for this slot: another may serve it, and if none does the task defers.
    }
  }
  return { modelSlots: [...resolved.keys()], resolved }
}

function nextAttemptId(store: Store): string {
  let max = 0
  for (const doc of store.attempts.list()) max = Math.max(max, attemptOrder(doc))
  return `att_${max + 1}`
}

function rationale(task: SchedulableTask, slotId: string, candidates: number): string {
  if (task.slotId !== undefined) return `pinned to ${slotId} by the plan`
  return candidates > 1
    ? `${slotId} had the lowest utilisation of ${candidates} candidates`
    : `${slotId} is the only candidate`
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
    const startable = tasks.filter(
      (task) => task.status === 'ready' && store.attempts.list({ taskId: task.id }).length === 0,
    )
    if (isHeld(work)) {
      const held = { reason: 'held', releases: 'the owner lifts the hold' }
      const changed = startable.map((task) => defer(store, task, held, at)).some(Boolean)
      if (changed || workItemId === scoped) {
        appendEvent(store, `work:${workItemId}`, 'launch_withheld', { workItemId, reason: 'held', at }, at)
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
      const { modelSlots, resolved } = modelFit(deps, task, views)
      const hint = task.slotHint as { slotClass?: string; slotId?: string } | undefined
      candidates.set(taskId, { doc: task, resolved })
      ready.push({
        taskId,
        workItemId,
        workItemPinned: false,
        readyAt: Date.parse(String(task.createdAt ?? at)),
        generation: 1,
        role: String(task.role),
        ...(hint?.slotClass !== undefined && { slotClass: hint.slotClass }),
        ...(hint?.slotId !== undefined && { slotId: hint.slotId }),
        ...(modelSlots !== undefined && { modelSlots }),
      })
    }
  }

  const active = store.attempts
    .list()
    .filter((doc) => occupies(deps, doc))
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
          state: view.healthy ? 'healthy' : 'degraded',
          pinnedRoles: [],
          inUse: inUse(view.slotId),
          concurrency: view.concurrency ?? caps.perSlot,
          ...(view.utilisation !== undefined && { usageUtilization: view.utilisation }),
          ...(view.slotClass !== undefined && { slotClass: view.slotClass }),
        }))

  const dispatch = planDispatches({
    ready,
    slots,
    active,
    caps,
    utilisationCeiling: UTILISATION_CEILING,
    // §11: a person continuing existing work goes before any launch.
    reservedWakeSlot: followups.deliveryWaiting(),
  })

  for (const { taskId, reason } of dispatch.deferred) {
    const doc = candidates.get(taskId)?.doc
    if (doc !== undefined) defer(store, doc, { reason, releases: RELEASES[reason] ?? reason }, at)
  }

  const records: LaunchRecord[] = []
  for (const launch of dispatch.launches) {
    const candidate = candidates.get(launch.taskId) as { doc: StoreDoc; resolved: Map<string, ResolvedModel> }
    const task = ready.find((row) => row.taskId === launch.taskId) as SchedulableTask
    const { deferred: _deferred, ...doc } = candidate.doc
    if (candidate.doc.deferred !== undefined) store.tasks.save({ ...doc, updatedAt: at })
    const model = candidate.resolved.get(launch.slotId)
    const placeable = slots.filter(
      (slot) => slot.state === 'healthy' && (task.modelSlots?.includes(slot.id) ?? true),
    ).length
    const attemptId = nextAttemptId(store)
    const { workItemId } = task
    store.attempts.save({
      id: attemptId,
      taskId: launch.taskId,
      workItemId,
      slotId: launch.slotId,
      state: 'queued',
      generation: 1,
      placement: rationale(task, launch.slotId, placeable),
      ...(model !== undefined && {
        resolved_model: model.model,
        ...(model.effort !== undefined && { effort: model.effort }),
        ...(model.tier_degraded !== undefined && { tier_degraded: model.tier_degraded }),
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
