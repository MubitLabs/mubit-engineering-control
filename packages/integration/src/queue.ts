/**
 * Integration-queue planning, plan §14: one integration worktree per work item, built from
 * the pinned base, where accepted tasks merge in dependency order (`--no-ff`, packages/git
 * merge.ts) and the combined checks run on the exact resulting SHA — one task per run.
 *
 * This module is the pure decision of which single step runs next; it does no git and no
 * I/O. The caller executes the step — a merge via `mergeIntoIntegration`, a repair in the
 * mid-merge worktree — updates the snapshot, and asks again.
 *
 * Dependency gating mirrors packages/domain blockers.ts: the task's own `basePolicy`
 * describes how it relates to its dependencies. An `integration` task starts from the
 * integration commit, so every dependency must be `integrated`; a `contract` task starts
 * once its prerequisites are accepted, so an accepted-but-unintegrated dependency does not
 * hold it back. A dependency absent from the snapshot counts as unsatisfied.
 *
 * `done` covers every accepted task being integrated and the nothing-ever-accepted
 * snapshot alike: the queue only ever speaks for tasks that reached acceptance.
 */
export type IntegrationTask = {
  taskId: string
  dependsOn: string[]
  /** How this task bases itself on its dependencies (plan §14, task-graph.ts). */
  basePolicy: 'integration' | 'contract'
  accepted: boolean
  integrated: boolean
  /** The merge or the checks on the merge SHA failed (plan §14); repair comes before any retry. */
  mergeFailed: boolean
  /**
   * Unmerged paths a conflicting merge left behind (merge.ts). A conflict always has at
   * least one, so their absence means `mergeFailed` records failing combined checks.
   */
  conflictedPaths?: string[]
  /** The merge SHA this task integrated at; reported as the starting point of later merges. */
  integratedSha?: string
}

export type QueueStep =
  | { action: 'merge'; taskId: string; fromIntegrationSha?: string }
  | { action: 'repair'; taskId: string; reason: 'conflict' | 'checks_failed'; conflictedPaths?: string[] }
  | { action: 'wait'; reason: 'dependency_not_integrated' | 'not_accepted' }
  | { action: 'done' }

export function nextIntegrationStep(tasks: readonly IntegrationTask[]): QueueStep {
  const byId = new Map(tasks.map((t) => [t.taskId, t] as const))

  // One task per run (§14): the first launchable task in dependency order (the array is
  // already ordered) wins — even when an earlier task sits failed awaiting repair.
  const candidate = tasks.find((t) => t.accepted && !t.integrated && !t.mergeFailed)
  if (candidate !== undefined) {
    for (const depId of candidate.dependsOn) {
      const dep = byId.get(depId)
      if (candidate.basePolicy === 'integration') {
        if (dep?.integrated !== true) return { action: 'wait', reason: 'dependency_not_integrated' }
      } else if (dep?.accepted !== true && dep?.integrated !== true) {
        return { action: 'wait', reason: 'not_accepted' }
      }
    }
    // The merge runs in the work item's single integration worktree, so it starts from the
    // most recent integration commit: dependency order, merge order and array order agree.
    // The first merge has none and starts from the pinned base.
    const base = tasks.findLast((t) => t.integrated && t.integratedSha !== undefined)
    return base?.integratedSha === undefined
      ? { action: 'merge', taskId: candidate.taskId }
      : { action: 'merge', taskId: candidate.taskId, fromIntegrationSha: base.integratedSha }
  }

  // Nothing can merge: a task whose merge or checks failed gets a repair whose worktree
  // starts mid-merge (§14). Conflicts carry their unmerged paths; a clean merge whose
  // checks failed carries none.
  const failed = tasks.find((t) => t.accepted && !t.integrated && t.mergeFailed)
  if (failed !== undefined) {
    const conflictedPaths = failed.conflictedPaths ?? []
    return conflictedPaths.length > 0
      ? { action: 'repair', taskId: failed.taskId, reason: 'conflict', conflictedPaths }
      : { action: 'repair', taskId: failed.taskId, reason: 'checks_failed' }
  }

  // Every accepted task is integrated, or nothing was ever accepted: the queue is drained.
  return { action: 'done' }
}
