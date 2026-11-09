# Stale block: blocked work whose blocked tasks were cancelled

Branch `fix/stale-block`, base cb9050c (v0.3.7). Found on installed 0.3.7 on 9 November 2026, work item `wi_mw9kvv16…` on MubitLabs/mec-sandbox. Evidence read from `~/.mec/mec.db` (events and task docs, no keys).

## What happened

1. 22:54:58: the owner followed up, `block_lifted`. The planner added `task_topcard_popup_z` with no dependencies. It started from the integration head 55f190b.
2. 22:56:31: that task was accepted (`task_accepted`, att_15). In the same pass the work got `work_blocked` with att_13's reason. Two older tasks (`task_fix_top`, `task_topcard_zindex`) were still `blocked` and no task was open, so `settleTasks` (`packages/meta/src/scheduler.ts`) called `blockWork`.
3. 22:57: the owner said "cancel those two as superseded". The planner's `cancel_task` ran and both tasks are now `cancelled`. The tool had answered with `state: 'blocked'`, so the planner told the owner it could not confirm the cancel. A cancel-only plan change is not the owner's go-ahead, so there was no `block_lifted`.
4. Since then: the work is `blocked` with att_13's reason, and no task is blocked. The accepted task never integrated. The scheduler skips blocked work (`if (String(work.state) === 'blocked') continue`), and delivery only runs `executing`, `reviewing` and `integrating` work. No retry is offered (the reason is not an integration block, and no task is blocked for Try again). It was a dead end.

## Spec (item 2)

- §14 Integration queue: "Accepted tasks merge in dependency order (`merge --no-ff`), and the integration checks run on the exact resulting SHA, one task per run." Order comes only from dependencies.
- §10 States: Task `blocked (dependency/capacity/confirmation)` is the task's own parked state. WorkItem `blocked (reason)` is the work's parked state, and the stage `person / blocked` is "the latest report is `blocked` or `failed`".
- Neither section says a blocked task blocks its siblings' integration, or that the work blocks while machine work (a merge) is still due. So an accepted task with nothing blocked on its dependency path integrates, and the work blocks after that if a sibling is still blocked. A blocked task still blocks its own dependents, as before (`blockDependents`).

## Changes

### 1. A block whose task is no longer blocked clears on the next pass

`settleTasks` now calls `settleBlock`. For blocked work it asks which task the block came from (`blockingTaskOf`):
- New blocks record it. `blockWork` takes an optional `taskId`, stores it as `blockedTask` on the work, and adds it to the `work_blocked` event body. `blockWork` always drops an earlier `blockedTask`, so a later block that no task caused never inherits one.
- Installed data has no `blockedTask`. For that, a `task_blocked` event in the work's stream with exactly the work's `blockedReason` names the task. This is how the live work clears with no migration.
- A block with neither (`policy_changed`, `integration: …`, `bootstrap_failed: …`, a launch failure, used-up repairs on an integrated task) is not a task's. It stays until a person acts, as before.

When the block is a task's and no task is blocked now, the work goes back to `executing`. The §10 steps (`advanceWork`) then move it on to `reviewing` and `integrating` when a task is accepted or integrated. A `block_cleared` event says why: `{ taskId, reason: 'no task is blocked any more' }`. Delivery then picks the work up on its next pass: it merges the accepted task, runs the combined checks on the new head, and opens a push card for it. 0.3.7 already clears a denied answer when the head moves (#71).

The other paths that leave `blocked` (Try again, Retry integration, the owner's go-ahead) also drop `blockedTask`.

### 2. An accepted task does not wait behind a blocked sibling it does not depend on

`settleTasks` used to block the work when a task was blocked and none was `ready`, `active` or `awaiting_review`. Now accepted tasks that integration will merge without a person also hold the work open (`awaitingMerge`). That means every accepted, non-repair task has each prerequisite either integrated, or accepted and mergeable the same way. It must be every one, because the queue takes the first accepted task in dependency order and waits on it (`packages/integration/src/queue.ts`). One stuck task would hold the rest, and the work must not wait unseen. Once they are integrated, the blocked sibling blocks the work with its own reason, and the result stays incomplete, so nothing is pushed.

### 3. `cancel_task` reports the status after the cancel

`PlannerTools#cancelTask` returned the task's status before the cancel (`blocked`). The cancel is journaled and committed with the turn (`service.ts`, the decision's `cancels`). The answer is now `{ ok: true, task, state: 'cancelled', was: '<before>' }`.

### 4. The reason never names a task that is no longer blocked

When the block's task is no longer blocked but another task is, the work stays blocked and its reason becomes that task's reason. `blockedTask` follows, and a `block_reason_changed` event records it. The Blocked line (`inspection.ts`) and the planner context (`context.ts`) both read `blockedReason`, so they follow without other changes. Once no task is blocked, item 1 removes the reason.

## Contracts

No change. `blockedTask`, `block_cleared` and `block_reason_changed` live on store documents and work events, which `packages/contracts` does not type. The `work_blocked` body gains an optional `taskId`.

## The live work after the upgrade

On the first scheduler pass after the upgrade, `blockingTaskOf` finds the `task_blocked` event for `task_fix_top` with att_13's reason. That task is `cancelled`, as is `task_topcard_zindex`, so no task is blocked. The work leaves `blocked`, gets `block_cleared`, and moves to `integrating`, because `task_topcard_popup_z` is accepted and two tasks are integrated. Delivery's next pass merges `task_topcard_popup_z` onto 55f190b and runs the combined checks on the merge. If they pass, the result is complete. The cancelled tasks carry `cancelled by the planner`, and `task_fix_popup` has its `task_cancelled` event. The delivery record's denied answer was about 55f190b, so a new push card opens for the new head. If the checks fail, the usual repair task opens in the integration worktree.

## Risks

- **A planner cancel can now resume blocked work without the owner.** Item 1 resumes the work when the planner's cancel leaves no task blocked. This happens even on a turn the owner did not cause (owner ruling 2026-11-07 is about lifting a block for a plan's new work). The block no longer has a cause, and the brief asks for this. Ready tasks then launch, but cancelled ones never do.
- **Legacy matching is by reason text.** A block that no task caused, whose reason is word for word a reason some task blocked with earlier, would be read as that task's block. No such path is known. Blocks the scheduler records from now on name their task.
- **Integrating while a sibling is blocked** runs the repository's checks on the merge, as any integration does. The host-run agreement and the admission pin still gate it in delivery.
