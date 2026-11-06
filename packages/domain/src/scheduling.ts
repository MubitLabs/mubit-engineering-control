import type { Caps } from './caps'

/**
 * Deterministic dispatch planning, plan §11 (v1's `planDispatches`, ported in spirit). Pure: a
 * snapshot of ready tasks, slots and active attempts goes in, a launch/defer plan comes out — no
 * I/O, no clocks, nothing reserved. The caller re-checks every claim when it takes slot capacity,
 * so this function only has to be correct for one snapshot.
 */
export type SchedulableTask = {
  taskId: string
  workItemId: string
  /** User-pinned work items schedule before unpinned ones (§11 ordering). */
  workItemPinned: boolean
  /** Milliseconds since epoch; older first. */
  readyAt: number
  /** Plan revision, carried for callers that fence stale replays; not used to order. */
  generation: number
  /** Slot class the task is bound to, when it declares one. */
  slotClass?: string
  /** The one slot the plan pinned this task to; it outranks every preference (§11). */
  slotId?: string
  /** The slots that can serve the task's model request; absent means it made none (§11, O7). */
  modelSlots?: readonly string[]
  /** Those that would serve it only by degrading its tier (§3 rule 1): the tier does not fit them. */
  degradedSlots?: readonly string[]
  role: string
}

export type SlotView = {
  id: string
  /** The engine it runs; absent says nothing, and no engine preference matches it. */
  engine?: string
  state: 'healthy' | 'degraded'
  /** Last reported window utilisation (0-1); absent means no reading yet (§5.9: never 0%). */
  usageUtilization?: number
  /** Roles this slot is pinned to; empty serves any role (§11: "the role's pinning or slot class"). */
  pinnedRoles: string[]
  inUse: number
  concurrency: number
  slotClass?: string
}

export type ActiveAttempt = {
  taskId: string
  slotId: string
  workItemId: string
}

/**
 * `confirmation` and `policy` belong to upstream gates (§13); this pass emits `capacity` (caps,
 * the reserved wake unit, or healthy-but-full slots), `slot_unhealthy` (no healthy slot matched
 * the task's pin or role pinning) and `model_unavailable` (those that did serve no model
 * the task asked for: unavailable never silently becomes a default).
 */
export type DeferReason = 'capacity' | 'slot_unhealthy' | 'model_unavailable' | 'confirmation' | 'policy'

/** Why a launch landed where it did, so the attempt's placement can say what really decided. */
export type Placement = {
  taskId: string
  pinned: boolean
  /** What cut the field, strongest first. */
  narrowedBy: ('slot_class' | 'engine')[]
  /** What was asked for and could not be honoured (§7: "records when it could not"). */
  missed: ('slot_class' | 'engine')[]
  /** What chose inside the field; absent when narrowing left one slot. */
  tiebreak?: 'only_candidate' | 'utilisation' | 'load' | 'id'
  /** The size of the field the choice was made in. */
  candidates: number
}

export type DispatchPlan = {
  launches: { taskId: string; slotId: string }[]
  deferred: { taskId: string; reason: DeferReason }[]
  /** One per launch, in the same order. */
  placements: Placement[]
}

const utilisation = (slot: SlotView): number => slot.usageUtilization ?? 0

/**
 * §11 ordering: pinned work items first, then fair rotation across work items (the n-th oldest
 * task of each work item before the (n+1)-th of any), then readyAt, then taskId for a stable
 * result — v1's `orderCandidates` with pinning in place of numeric priority.
 */
function orderReady(ready: readonly SchedulableTask[]): SchedulableTask[] {
  const byWorkItem = new Map<string, SchedulableTask[]>()
  for (const task of [...ready].sort((a, b) => a.readyAt - b.readyAt || a.taskId.localeCompare(b.taskId))) {
    const list = byWorkItem.get(task.workItemId) ?? []
    list.push(task)
    byWorkItem.set(task.workItemId, list)
  }
  const round = new Map<string, number>()
  for (const list of byWorkItem.values()) {
    let index = 0
    for (const task of list) {
      if (!round.has(task.taskId)) round.set(task.taskId, index++)
    }
  }
  return [...ready].sort(
    (a, b) =>
      Number(b.workItemPinned) - Number(a.workItemPinned) ||
      round.get(a.taskId)! - round.get(b.taskId)! ||
      a.readyAt - b.readyAt ||
      a.taskId.localeCompare(b.taskId),
  )
}

export function planDispatches(input: {
  /** Dependency-satisfied tasks; any input order — they are ordered internally. */
  ready: readonly SchedulableTask[]
  slots: readonly SlotView[]
  active: readonly ActiveAttempt[]
  caps: Caps
  /** Stop NEW placements on a slot at/above this (0-1); existing attempts keep running. */
  utilisationCeiling: number
  /** Keep one slot-equivalent of capacity free for a user's follow-up delivery (§11). */
  reservedWakeSlot: boolean
  /** The meta slot's engine: unpinned work prefers it where the tier fits. Absent, nothing does. */
  preferredEngine?: string
}): DispatchPlan {
  const launches: DispatchPlan['launches'] = []
  const deferred: DispatchPlan['deferred'] = []
  const placements: DispatchPlan['placements'] = []

  const activeTaskIds = new Set(input.active.map((attempt) => attempt.taskId))
  const activePerWorkItem = new Map<string, number>()
  for (const attempt of input.active) {
    activePerWorkItem.set(attempt.workItemId, (activePerWorkItem.get(attempt.workItemId) ?? 0) + 1)
  }

  const launchPerSlot = new Map<string, number>()
  const launchPerWorkItem = new Map<string, number>()
  const launchedTaskIds = new Set<string>()
  const load = (slot: SlotView): number => slot.inUse + (launchPerSlot.get(slot.id) ?? 0)

  const matches = (task: SchedulableTask, slot: SlotView): boolean =>
    (task.slotId === undefined || slot.id === task.slotId) &&
    (slot.pinnedRoles.length === 0 || slot.pinnedRoles.includes(task.role))

  /** New work only: a slot at/above the ceiling never takes a new attempt; running ones stay. */
  const underCeiling = (slot: SlotView): boolean =>
    slot.usageUtilization === undefined || slot.usageUtilization < input.utilisationCeiling

  /** Free capacity, bounded by the per-slot cap even when concurrency is higher. */
  const freeUnits = (slot: SlotView): number => Math.min(slot.concurrency, input.caps.perSlot) - load(slot)

  /** Free units across every slot a wake could land on (§11: wakes take the next free slot). */
  const poolFreeUnits = (): number =>
    input.slots
      .filter((slot) => slot.state === 'healthy' && underCeiling(slot))
      .reduce((sum, slot) => sum + Math.max(0, freeUnits(slot)), 0)

  for (const task of orderReady(input.ready)) {
    // Rule 1: one live attempt per task (v1's unique index); a launch made this pass counts too.
    if (activeTaskIds.has(task.taskId) || launchedTaskIds.has(task.taskId)) continue

    // Rules 2 and 4: healthy slots matching the task's pin and the slot's role pinning. The slot
    // class is a preference (§10) applied when choosing below, never a filter.
    const matching = input.slots.filter((slot) => slot.state === 'healthy' && matches(task, slot))
    if (matching.length === 0) {
      deferred.push({ taskId: task.taskId, reason: 'slot_unhealthy' })
      continue
    }
    const candidates = matching.filter(
      (slot) => task.modelSlots === undefined || task.modelSlots.includes(slot.id),
    )
    if (candidates.length === 0) {
      deferred.push({ taskId: task.taskId, reason: 'model_unavailable' })
      continue
    }

    // Rules 3, 4 and 6: candidates with room for new work — full-but-healthy is capacity, not
    // unhealthy.
    const usable = candidates.filter((slot) => underCeiling(slot) && freeUnits(slot) > 0)
    if (usable.length === 0) {
      deferred.push({ taskId: task.taskId, reason: 'capacity' })
      continue
    }

    // Rule 5: global cap, minus the reserved wake unit when this launch would take the last
    // free one. Rule 6: per-work-item cap.
    const bitesTheReservedUnit = input.reservedWakeSlot && poolFreeUnits() <= 1
    const workItemActive = activePerWorkItem.get(task.workItemId) ?? 0
    const workItemLaunches = launchPerWorkItem.get(task.workItemId) ?? 0
    if (
      input.active.length + launches.length >= input.caps.globalActiveAttempts ||
      bitesTheReservedUnit ||
      workItemActive + workItemLaunches >= input.caps.perWorkItem
    ) {
      deferred.push({ taskId: task.taskId, reason: 'capacity' })
      continue
    }

    // Rule 4 preference: the planner's slot class for this task, then the meta slot's engine where
    // the tier fits, then lowest utilisation, fewest in use and id for stability. A slot without a
    // reading ranks as least utilised (unknown is not high).
    const preferred = usable.filter(
      (slot) => task.slotClass !== undefined && slot.slotClass === task.slotClass,
    )
    const pool = [...(preferred.length > 0 ? preferred : usable)]
    const fitsEngine = (slot: SlotView): boolean =>
      slot.engine !== undefined &&
      slot.engine === input.preferredEngine &&
      !task.degradedSlots?.includes(slot.id)
    const onEngine = pool.filter(fitsEngine)
    const field = (onEngine.length > 0 ? onEngine : pool).sort(
      (a, b) => utilisation(a) - utilisation(b) || load(a) - load(b) || a.id.localeCompare(b.id),
    )
    const chosen = field[0]!

    // Rule 6: per-slot cap asserted on its own, though freeUnits already folds it in.
    if (load(chosen) >= input.caps.perSlot) {
      deferred.push({ taskId: task.taskId, reason: 'capacity' })
      continue
    }

    launches.push({ taskId: task.taskId, slotId: chosen.id })
    placements.push(placementOf({ task, usable, preferred, pool, field, load, fitsEngine, input }))
    launchedTaskIds.add(task.taskId)
    launchPerSlot.set(chosen.id, load(chosen) + 1)
    launchPerWorkItem.set(task.workItemId, workItemLaunches + 1)
  }

  return { launches, deferred, placements }
}

/** Which step decided: a step that left the field as it was decided nothing, and is not claimed. */
function placementOf(step: {
  task: SchedulableTask
  usable: readonly SlotView[]
  preferred: readonly SlotView[]
  pool: readonly SlotView[]
  field: readonly SlotView[]
  load: (slot: SlotView) => number
  fitsEngine: (slot: SlotView) => boolean
  input: { preferredEngine?: string }
}): Placement {
  const { task, usable, preferred, pool, field, load, fitsEngine, input } = step
  if (task.slotId !== undefined) {
    return { taskId: task.taskId, pinned: true, narrowedBy: [], missed: [], candidates: field.length }
  }
  const narrowedBy: Placement['narrowedBy'] = []
  if (preferred.length > 0 && preferred.length < usable.length) narrowedBy.push('slot_class')
  if (field.length < pool.length) narrowedBy.push('engine')
  const missed: Placement['missed'] = []
  if (task.slotClass !== undefined && preferred.length === 0) missed.push('slot_class')
  if (input.preferredEngine !== undefined && !usable.some(fitsEngine)) missed.push('engine')
  const [first, second] = field
  const tiebreak = ((): Placement['tiebreak'] => {
    if (first === undefined || second === undefined) {
      return usable.length === 1 ? 'only_candidate' : undefined
    }
    if (utilisation(first) !== utilisation(second)) return 'utilisation'
    return load(first) !== load(second) ? 'load' : 'id'
  })()
  return {
    taskId: task.taskId,
    pinned: false,
    narrowedBy,
    missed,
    ...(tiebreak !== undefined && { tiebreak }),
    candidates: field.length,
  }
}
