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
  role: string
}

export type SlotView = {
  id: string
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
 * the task's pin, class or role pinning) and `model_unavailable` (those that did serve no model
 * the task asked for: unavailable never silently becomes a default).
 */
export type DeferReason = 'capacity' | 'slot_unhealthy' | 'model_unavailable' | 'confirmation' | 'policy'

export type DispatchPlan = {
  launches: { taskId: string; slotId: string }[]
  deferred: { taskId: string; reason: DeferReason }[]
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
}): DispatchPlan {
  const launches: DispatchPlan['launches'] = []
  const deferred: DispatchPlan['deferred'] = []

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
    (task.slotClass === undefined || slot.slotClass === task.slotClass) &&
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

    // Rules 2 and 4: healthy slots matching the task's pin, slot class and the slot's role pinning.
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

    // Rule 4 preference: lowest utilisation, then fewest in use, then id for stability. A slot
    // without a reading ranks as least utilised (unknown is not high).
    const chosen = [...usable].sort(
      (a, b) => utilisation(a) - utilisation(b) || load(a) - load(b) || a.id.localeCompare(b.id),
    )[0]!

    // Rule 6: per-slot cap asserted on its own, though freeUnits already folds it in.
    if (load(chosen) >= input.caps.perSlot) {
      deferred.push({ taskId: task.taskId, reason: 'capacity' })
      continue
    }

    launches.push({ taskId: task.taskId, slotId: chosen.id })
    launchedTaskIds.add(task.taskId)
    launchPerSlot.set(chosen.id, load(chosen) + 1)
    launchPerWorkItem.set(task.workItemId, workItemLaunches + 1)
  }

  return { launches, deferred }
}
