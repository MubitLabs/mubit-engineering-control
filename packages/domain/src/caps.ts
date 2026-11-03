/**
 * Policy caps, plan §11: deterministic, local, simple. Pure predicates over a snapshot —
 * the scheduler re-checks every claim, and the meta agent may only *recommend*; code grants.
 */

export type Caps = {
  globalActiveAttempts: number
  perWorkItem: number
  perSlot: number
  fanOut: number
  agentDepth: number
  repairAttemptsPerTask: number
}

/** Defaults from plan §11: 4 global, 2 per work item, 2 per slot, fan-out 3, depth 1, 2 repairs. */
export const DEFAULT_CAPS: Caps = {
  globalActiveAttempts: 4,
  perWorkItem: 2,
  perSlot: 2,
  fanOut: 3,
  agentDepth: 1,
  repairAttemptsPerTask: 2,
}

export function withinGlobalCaps(active: number, caps: Caps): boolean {
  return active <= caps.globalActiveAttempts
}

export function withinPerWorkItemCaps(active: number, caps: Caps): boolean {
  return active <= caps.perWorkItem
}

export function withinPerSlotCaps(active: number, caps: Caps): boolean {
  return active <= caps.perSlot
}
