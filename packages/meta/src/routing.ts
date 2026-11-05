/**
 * Plan §12.1 admission routing for a user message.
 *
 * **Reference binds**: an explicit reference (task name, PR or branch, the
 * acknowledgement it replies to, a recent change with exactly one matching work item)
 * attaches the message to the live work item it names — if that item is stopped, the
 * reference is refused (`stopped_refused`); stopped mandates never resume silently (§10).
 *
 * **Similarity never binds**: a message that references nothing is conversation when
 * live work exists (context only, no authority) or new work when nothing is live.
 * Resemblance to an existing work item is the meta agent's context, never an attachment;
 * genuine ambiguity is confirmed with the user — cheaply, once (§12.1) — not decided here.
 *
 * **An explicit New request is new work**, even beside live work: the owner said so, which is
 * the "explicit" authorisation §12.1 gives chat. It never overrides a reference.
 *
 * A reference that resolves to nothing in the given work set does not bind either; the
 * message falls through to the reference-absent rules, and the caller resolves the
 * dangling reference as ambiguity.
 */
export type LiveWork = {
  workItemId: string
  tasks: { taskId: string; status: string }[]
  openQuestions: string[]
  stopped: boolean
}

export type RoutingDecision =
  | { action: 'attach'; workItemId: string }
  | { action: 'new_work' }
  | { action: 'conversation' }
  | { action: 'stopped_refused'; workItemId: string }

export function routeMessage(input: {
  referencesWorkItem?: string
  liveWork: readonly LiveWork[]
  explicitNew?: boolean
}): RoutingDecision {
  const reference = input.referencesWorkItem
  if (reference !== undefined) {
    const target = input.liveWork.find((w) => w.workItemId === reference)
    if (target !== undefined) {
      return target.stopped
        ? { action: 'stopped_refused', workItemId: target.workItemId }
        : { action: 'attach', workItemId: target.workItemId }
    }
  }
  if (input.explicitNew === true) return { action: 'new_work' }
  return input.liveWork.some((w) => !w.stopped) ? { action: 'conversation' } : { action: 'new_work' }
}
