/**
 * What the store says about a work item's checks and result, read one way by the scheduler, the
 * service and delivery. The registered checks are the ones the work was pinned to: the launch gate
 * refuses a work item whose repository profile changed since admission (`repo_profile_changed`).
 */
import type { Store, StoreDoc } from '@mec/contracts'
import { type CheckVerdict, NO_CHECKS_MARKER, type WorkResult, workResult } from '@mec/domain'

export const integrationDocId = (workItemId: string): string => `integration/${workItemId}`

const checkId = (attemptId: string, name: string): string => `check/${attemptId}/${name}`

/** The check names a repository registers. */
export function registeredChecks(repo: StoreDoc | undefined): string[] {
  const checks = Array.isArray(repo?.checks) ? repo.checks : []
  return checks.flatMap((check) => {
    const name = (check as { name?: unknown }).name
    return typeof name === 'string' ? [name] : []
  })
}

/** What a plan may name (§15). The marker only where nothing is registered. */
export function knownChecks(store: Store, repoId: string | undefined): string[] {
  const names = registeredChecks(repoId === undefined ? undefined : store.engines.get(repoId))
  return names.length > 0 ? names : [NO_CHECKS_MARKER]
}

/**
 * What must pass on a head: everything registered, plus anything the task names. A plan can add to
 * this but never narrow it, because the runner runs them all and `succeeded` already needs them all.
 */
export function requiredChecks(task: StoreDoc, repo: StoreDoc | undefined): string[] {
  const named = Array.isArray(task.acceptanceChecks) ? task.acceptanceChecks.map(String) : []
  return [...new Set([...registeredChecks(repo), ...named])].filter((name) => name !== NO_CHECKS_MARKER)
}

/** The stored verdicts of an attempt, each bound to the SHA it ran on. */
export function verdictsOf(store: Store, attempt: StoreDoc): CheckVerdict[] {
  const names = Array.isArray(attempt.checks) ? attempt.checks.map(String) : []
  return names.flatMap((name) => {
    const doc = store.engines.get(checkId(String(attempt.id), name))
    if (doc === undefined) return []
    return [
      {
        name,
        status: doc.status as CheckVerdict['status'],
        sha: String(doc.sha),
        logTail: String(doc.log_tail ?? ''),
      },
    ]
  })
}

/** Why a task the planner cancelled with `cancel_task` is not in the result. */
export const PLANNER_CANCELLED = 'cancelled by the planner'

/**
 * Why a cancelled task is excluded. Before 0.3.7 the planner's `cancel_task` stored no reason, so
 * its own `task_cancelled` event is the record that a cancel was asked for, and it says the same.
 * A cancel with neither stays unexplained, and the result stays incomplete.
 */
function excludedReason(store: Store, task: StoreDoc): string | undefined {
  if (typeof task.cancelledReason === 'string') return task.cancelledReason
  if (task.status !== 'cancelled') return undefined
  const asked = store.events.read(`task:${String(task.id)}`).some((event) => event.type === 'task_cancelled')
  return asked ? PLANNER_CANCELLED : undefined
}

/** The reducer's answer for one work item. The planner's `report_result` carries this beside its words. */
export function workResultOf(store: Store, workItemId: string): WorkResult {
  const doc = store.engines.get(integrationDocId(workItemId))
  const integrated = (doc?.integrated ?? {}) as Record<string, string>
  const tasks = store.tasks.list({ workItemId }).filter((task) => task.repairOf === undefined)
  const combined = doc?.combined as Parameters<typeof workResult>[0]['combined']
  return workResult({
    tasks: tasks.map((task) => {
      const id = String(task.id)
      const excluded = excludedReason(store, task)
      return {
        id,
        status: String(task.status),
        ...(integrated[id] !== undefined && { sha: integrated[id] }),
        ...(excluded !== undefined && { excludedReason: excluded }),
      }
    }),
    ...(typeof doc?.head === 'string' && { head: doc.head }),
    ...(combined !== undefined && { combined }),
    findings: tasks.flatMap((task) =>
      Array.isArray(task.findings) ? (task.findings as { text: string; disposition?: string }[]) : [],
    ),
  })
}
