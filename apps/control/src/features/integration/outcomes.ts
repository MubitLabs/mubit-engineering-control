import type { RunnerEventEnvelope } from '@mec/contracts'
import { taskMachine } from '@mec/domain'
import type { Tx } from '../../db/sql'
import type { AttemptRow, RepairContext } from '../attempts/service'
import { transition } from '../state'
import { refreshReadiness } from '../tasks/readiness'

interface Merged {
  taskId: string
  taskKey: string
  sha: string
}

async function sendBack(tx: Tx, attempt: AttemptRow, taskId: string, repair: RepairContext): Promise<void> {
  const [task] = await tx<{ state: string }[]>`select state from tasks where id = ${taskId} for update`
  if (task?.state !== 'accepted') return
  await transition(tx, {
    table: 'tasks',
    machine: taskMachine,
    id: taskId,
    from: 'accepted',
    event: 'integration_conflict',
    set: { repairContext: tx.json(repair as never), acceptedSha: null },
    projectId: attempt.projectId,
    deliveryId: attempt.deliveryId,
    taskId,
    actor: { kind: 'system', id: 'integrator' },
    payload: { reason: repair.reason, integrationAttemptId: attempt.id },
  })
}

/**
 * Integration checks ran on the exact merge SHA (PDF §14). Passing integrates the task and advances
 * the delivery's integration line, so dependents start from it; failing sends the task back for a
 * repair that starts from the combined commit with the failures attached.
 */
export async function onIntegrationCompleted(
  tx: Tx,
  attempt: AttemptRow,
  env: RunnerEventEnvelope,
): Promise<void> {
  const p = env.payload as {
    sha: string
    baseSha: string | null
    passed: boolean
    pushed: boolean
    merged: Merged[]
  }
  if (attempt.kind !== 'integration') return
  if (p.passed) {
    for (const m of p.merged) {
      const [task] = await tx<{ state: string }[]>`select state from tasks where id = ${m.taskId} for update`
      if (task?.state !== 'accepted') continue
      await transition(tx, {
        table: 'tasks',
        machine: taskMachine,
        id: m.taskId,
        from: 'accepted',
        event: 'integrated',
        set: { blocker: null },
        projectId: attempt.projectId,
        deliveryId: attempt.deliveryId,
        taskId: m.taskId,
        actor: { kind: 'system', id: 'integrator' },
        payload: { integrationSha: p.sha, mergeSha: m.sha },
      })
    }
    await tx`
      update deliveries set integration_sha = ${p.sha},
        integration_pushed_sha = case when ${p.pushed} then ${p.sha} else integration_pushed_sha end,
        updated_at = now()
      where id = ${attempt.deliveryId}
    `
    await refreshReadiness(tx, { id: attempt.deliveryId, projectId: attempt.projectId })
    return
  }
  const failures = await tx<{ name: string; status: string; logTail: string | null }[]>`
    select name, status, log_tail from check_results where attempt_id = ${attempt.id} and status <> 'passed'
  `
  for (const m of p.merged) {
    await sendBack(tx, attempt, m.taskId, {
      reason: 'integration_checks_failed',
      notes: `Integration checks failed after merging onto the integration branch at ${p.baseSha?.slice(0, 10)}. The combined commit is in this working tree; make the checks pass.`,
      failures,
      startSha: p.sha,
      diffBaseSha: p.baseSha,
      previousAttemptId: attempt.id,
    })
  }
}

/**
 * A merge conflict creates a bounded repair against the integration line with both changes
 * (PDF §14): the repair starts at the integration commit with the task's commit mid-merge.
 */
export async function onIntegrationConflict(
  tx: Tx,
  attempt: AttemptRow,
  env: RunnerEventEnvelope,
): Promise<void> {
  const p = env.payload as {
    taskId: string
    taskKey: string
    conflicts: string[]
    integrationSha: string | null
  }
  if (attempt.kind !== 'integration') return
  const [task] = await tx<
    { acceptedSha: string | null }[]
  >`select accepted_sha from tasks where id = ${p.taskId}`
  await sendBack(tx, attempt, p.taskId, {
    reason: 'integration_conflict',
    notes: `Merging into the integration branch conflicted in ${p.conflicts.join(', ')}.`,
    conflicts: p.conflicts,
    startSha: p.integrationSha,
    diffBaseSha: p.integrationSha,
    mergeSha: task?.acceptedSha ?? null,
    previousAttemptId: attempt.id,
  })
}
