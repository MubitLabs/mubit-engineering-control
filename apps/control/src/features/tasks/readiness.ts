import type { BasePolicy, TaskSpec } from '@mec/contracts'
import { type Blocker, dependencyBlocker, type TaskState, taskMachine } from '@mec/domain'
import type { Tx } from '../../db/sql'
import type { ActorKind } from '../../events/append'
import { transition } from '../state'

interface TaskRow {
  id: string
  key: string
  state: TaskState
  spec: TaskSpec
  blocker: Blocker | null
}

/**
 * Re-evaluates dependency blockers for one delivery: approved tasks whose prerequisites are now
 * satisfied become ready; the rest record what they wait for. Safe to call after any change.
 */
export async function refreshReadiness(
  tx: Tx,
  delivery: { id: string; projectId: string },
  actor: { kind: ActorKind; id?: string | null } = { kind: 'system' },
): Promise<string[]> {
  const tasks = await tx<TaskRow[]>`
    select id, key, state, spec, blocker from tasks
    where delivery_id = ${delivery.id} and state <> 'cancelled' and kind = 'work'
    for update
  `
  const deps = await tx<{ taskId: string; dependsOnTaskId: string }[]>`
    select d.task_id, d.depends_on_task_id
    from task_dependencies d join tasks t on t.id = d.task_id
    where t.delivery_id = ${delivery.id}
  `
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const becameReady: string[] = []

  for (const task of tasks) {
    if (task.state !== 'approved' && task.state !== 'ready') continue
    const prerequisites = deps
      .filter((d) => d.taskId === task.id)
      .map((d) => byId.get(d.dependsOnTaskId))
      .filter((t): t is TaskRow => t !== undefined)
      .map((t) => ({ key: t.key, state: t.state }))
    const policy: BasePolicy = task.spec.basePolicy ?? 'integration'
    const blocker = dependencyBlocker(policy, prerequisites)

    if (task.state === 'approved' && blocker === null) {
      await transition(tx, {
        table: 'tasks',
        machine: taskMachine,
        id: task.id,
        from: 'approved',
        event: 'dependencies_satisfied',
        set: { blocker: null },
        projectId: delivery.projectId,
        deliveryId: delivery.id,
        taskId: task.id,
        actor,
      })
      becameReady.push(task.id)
    } else if (task.state === 'ready' && blocker !== null) {
      await transition(tx, {
        table: 'tasks',
        machine: taskMachine,
        id: task.id,
        from: 'ready',
        event: 'dependencies_reopened',
        set: { blocker: tx.json(blocker as never) },
        projectId: delivery.projectId,
        deliveryId: delivery.id,
        taskId: task.id,
        actor,
      })
    } else if (task.state === 'approved' && JSON.stringify(task.blocker) !== JSON.stringify(blocker)) {
      await tx`update tasks set blocker = ${tx.json(blocker as never)}, updated_at = now() where id = ${task.id}`
    }
  }
  return becameReady
}
