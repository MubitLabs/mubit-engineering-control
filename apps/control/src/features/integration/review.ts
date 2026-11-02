import { taskMachine } from '@mec/domain'
import type { ApprovalHooks } from '../approvals/service'
import type { RepairContext, TaskRow } from '../attempts/service'
import { transition } from '../state'
import { refreshReadiness } from '../tasks/readiness'

/**
 * Human review of a task result (PDF §15). The approval is bound to the attempt's head SHA; a newer
 * attempt or a task that left review makes it stale. Accepting records the exact accepted commit;
 * sending back starts a bounded repair that continues from it.
 */
export const resultHooks: ApprovalHooks = {
  async currentBinding(tx, approval) {
    if (!approval.taskId || !approval.attemptId) return null
    const [row] = await tx<{ state: string; headSha: string | null; latest: string }[]>`
      select t.state, a.head_sha,
        (select id from attempts where task_id = t.id order by number desc limit 1) as latest
      from tasks t join attempts a on a.id = ${approval.attemptId}
      where t.id = ${approval.taskId}
    `
    if (row?.state !== 'awaiting_review' || row.latest !== approval.attemptId) return null
    return row.headSha ?? `attempt:${approval.attemptId}`
  },

  async onResolved(tx, approval, decision, actor) {
    const [task] = await tx<(TaskRow & { projectId: string })[]>`
      select t.*, d.project_id from tasks t join deliveries d on d.id = t.delivery_id
      where t.id = ${approval.taskId} for update of t
    `
    const [attempt] = await tx<
      { headSha: string | null; baseSha: string | null; diff: { baseSha?: string } | null }[]
    >`
      select head_sha, base_sha, diff from attempts where id = ${approval.attemptId}
    `
    if (!task || !attempt) return
    const ctx = {
      projectId: task.projectId,
      deliveryId: task.deliveryId,
      taskId: task.id,
      actor: { kind: 'user' as const, id: actor.userId },
      payload: { approvalId: approval.id, sha: attempt.headSha },
    }
    if (decision.kind === 'approve') {
      await transition(tx, {
        table: 'tasks',
        machine: taskMachine,
        id: task.id,
        from: 'awaiting_review',
        event: 'review_accepted',
        set: { acceptedSha: attempt.headSha, blocker: null },
        ...ctx,
      })
      // Interface dependents (basePolicy "contract") may start once this is accepted.
      await refreshReadiness(tx, { id: task.deliveryId, projectId: task.projectId })
      return
    }
    const notes = decision.kind === 'reject' ? (decision.reason ?? '') : ''
    const exhausted = task.attemptsUsed >= (task.spec.maxAttempts ?? 2)
    const repair: RepairContext = {
      reason: 'review_sent_back',
      notes: `The reviewer sent this back${notes ? `: ${notes}` : '.'}`,
      startSha: attempt.headSha,
      diffBaseSha: attempt.diff?.baseSha ?? attempt.baseSha,
      previousAttemptId: approval.attemptId!,
    }
    await transition(tx, {
      table: 'tasks',
      machine: taskMachine,
      id: task.id,
      from: 'awaiting_review',
      event: 'review_sent_back',
      set: {
        repairContext: tx.json(repair as never),
        blocker: exhausted
          ? tx.json({
              kind: 'decision',
              detail: 'Attempt budget used; start a repair attempt manually',
              refs: [],
            } as never)
          : null,
      },
      ...ctx,
    })
  },
}
