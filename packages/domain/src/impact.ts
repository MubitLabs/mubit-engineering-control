import type { TaskId } from '@mec/contracts'
import type { TaskNode } from './task-graph'

/**
 * What a new plan revision changes relative to the previous one (plan §10: "changes carry
 * an impact summary — v1's impact diff, ported"). Unchanged tasks keep running; changed
 * and removed tasks are the only ones whose work is invalidated.
 */

export type PlanTaskLike = TaskNode & { objective?: string }

export type PlanImpact = {
  added: TaskId[]
  changed: TaskId[]
  removed: TaskId[]
  unchanged: TaskId[]
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i])

/** Deep-equal on the comparable fields: arrays compare element-wise (order matters). */
const sameTask = (a: PlanTaskLike, b: PlanTaskLike): boolean =>
  a.id === b.id &&
  sameStrings(a.dependsOn, b.dependsOn) &&
  sameStrings(a.ownedPaths, b.ownedPaths) &&
  sameStrings(a.acceptanceChecks, b.acceptanceChecks) &&
  a.maxAttempts === b.maxAttempts &&
  a.basePolicy === b.basePolicy &&
  (a.objective ?? null) === (b.objective ?? null)

export function computeImpact(before: readonly PlanTaskLike[], after: readonly PlanTaskLike[]): PlanImpact {
  const oldTasks = new Map(before.map((t) => [t.id, t]))
  const newTasks = new Map(after.map((t) => [t.id, t]))
  const impact: PlanImpact = { added: [], changed: [], removed: [], unchanged: [] }
  for (const [id, task] of newTasks) {
    const old = oldTasks.get(id)
    if (old === undefined) impact.added.push(id)
    else if (sameTask(old, task)) impact.unchanged.push(id)
    else impact.changed.push(id)
  }
  for (const id of oldTasks.keys()) {
    if (!newTasks.has(id)) impact.removed.push(id)
  }
  for (const list of Object.values(impact)) list.sort()
  return impact
}
