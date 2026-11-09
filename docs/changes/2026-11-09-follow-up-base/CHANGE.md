# Follow-up base: six gaps from the installed 0.3.6 walkthrough

Branch `fix/follow-up-base`, base e55ac9f (v0.3.6). The findings come from the real run of work item `wi_mw9kvv16…` ("build a horse tinder website", MubitLabs/mec-sandbox) on 9 November 2026, read from `~/.mec/mec.db` (read-only queries; the database holds no keys). In order: task_1 (Codex, att_10) integrated at 196b59c on `mec/mw9kvv16/integration`; the owner denied the push card (`conf_mw9l5zm…`, input 196b59c); a follow-up added `task_fix_popup` with no dependency, and its attempt att_11 got a worktree on the pin d59fcce with none of the site's files and reported blocked; the planner offered "copy the files from 21ca549" or "wait for att_10 to land"; revision 3 gave the blocked task `dependsOn: [task_1]` and said it "starts from the integration head", but the work re-blocked at the same instant and nothing launched; revision 4 cancelled it (`cancel_task`) and added `task_fix_popup_2`, which ran from 196b59c and integrated at 55f190b with combined checks green. Throughout, the stage read *Push declined*. After the fix integrated, `delivery/wi_mw9kvv16…` stayed `{stage: 'moved', answer: 'denied', summary: '… at 196b59c …'}`, no push card opened, and Work offered only Hold and Stop.

## 1. A follow-up's new task started on the request-time commit (owner decision #66, "A")

**Cause.** `apps/desktop/src/attempt-launch.ts` `#baseFor` used the integration head only for a task with dependencies; anything else got the pin. att_11's `base_sha` is d59fcce while the integration branch held the site at 196b59c.

**Change.** `taskBase(task, pinned, integration, fresh)` (exported, pure) replaces `#baseFor`. A task with no dependencies starts from the integration head once the work's integration record holds at least one integrated task; before that it starts from the pin, as before. `basePolicy: 'contract'` is the opt-out for a truly independent task (the existing field, no new value). A continuation in an existing worktree (a repair, a review, a resume) keeps the old rule, so a repair never has its base moved under the tree it works in. The chosen base is the attempt's `base_sha`, and the worker's environment section still says `Pinned base: <sha>`, followed, when that is the integration head, by a line saying so and naming the integration branch. The `propose_plan` schema's `base_policy` description (`packages/mec-tools/src/tools.ts`) and the planner protocol (`packages/prompts/defaults/roles/meta_agent/protocol.md`) say the default and the opt-out in one sentence each. Spec §14 (integration queue) gains the rule; `docs/DECISIONS.md` gains row 66 quoting the owner's choice.

## 2. A replan that changed a blocked task left it blocked

**Cause.** `packages/meta/src/service.ts` `#commitPlan` kept the prior status of a reused key (`status: prior?.status ?? 'ready'`), so a blocked task stayed blocked. The owner's go-ahead lifted the work's block, and `scheduler.ts` `settleTasks` put it straight back (`blocked` task, nothing open → `blockWork`), which is the `work_blocked` at 18:24:24.613Z beside the `block_lifted`. Even unblocked, a task with an earlier attempt is not `startable` without a `next`, and the owner's Try again is a repair in att_11's worktree (§15), which would still lack the files.

**Change.** In `#commitPlan`, a reused key that was `blocked`, on a turn the owner caused (the same `#ownerWentAhead` test that lifts the work's block, owner ruling 2026-11-07), whose objective, dependencies or base policy changed, goes back to `ready` with `next: {kind: 'restart', role, evidence: <its block reason>}` and no worktree, and a `task_restarted` event. The next pass places it like any launch; the launch makes a fresh worktree (`work/<attempt>`, branch `…/a<n>`) on the base item 1 gives it, and the brief says it is a new start and why the earlier attempt stopped. `restart` is a new `Continuation` kind in `packages/meta/src/repair.ts`; it is not a repair, so it spends no repair. A blocked task the revision did not change stays blocked, and the turn's own report gets one sentence appended ("<key> is still blocked: this plan changed nothing it runs on, so it did not start."), so a planner summary cannot read as a start that did not happen. The planner protocol says the same rule.

## 3. The planner read a declined push as work never merged

**Cause.** `packages/meta/src/context.ts` gave the planner the stage label (*Push declined*), each task's state, and a `head` read from `latest.headSha`, a field no attempt writes (attempts store `head_sha`), so every head printed `head:-`. Nothing said the work was integrated locally, so "copy from 21ca549" and "wait for att_10 to land" both looked reasonable.

**Change.** Each open work item now carries two facts when they exist: `integrated locally: <keys> on <branch> at <sha> (merged on this machine; a new task builds on it)`, from the integration record, and `push to GitHub: declined: the push card for <sha> was denied; nothing has left this machine; the integrated commits are still here, and a new head gets a new push card` (or the failed, waiting or pushed wording), from the delivery record. The task row's head reads `head_sha`.

## 4. The stage read *Push declined* while a fix ran

**Cause.** `packages/domain/src/stages.ts`: the declined/failed delivery row matched on `deliveryStopped` alone, above Working.

**Change.** `workViewOf` sets `underWay` when an attempt is queued, running or parked, or the caller reports an open task (`WorkFacts.tasksOpen`: a task `ready` or `active`). The delivery-stopped row does not match work under way, so it falls through to Working (or Queued, Waiting for quota, as those rows say). With nothing under way it reads *Push declined* again. Both callers pass `tasksOpen`: Work (`apps/desktop/src/inspection.ts`, from the task counts it already reads) and the planner's context.

## 5. A tab open across an upgrade said "Could not read this delivery"

**Cause.** The page had no way to tell an answer from a newer server from a decode bug: `/api/status` named no version and the page did not know its own.

**Change.** `/api/status` adds `version` (`apps/desktop/src/own-version.ts`, the same read `mec update` used, now shared). The page's own version is `apps/web/package.json`'s, built in (`apps/web/src/live/stale.ts`). When any inspection read fails with a `DecodeError`, the inspection asks the server's version once; a different one (not absent, not `unknown`) sets `stale`. The delivery notice (`DeliveryReadFailure` in `WorkView.tsx`) then reads *MEC was updated* / *Reload this page to continue.* with a Reload button. The same version keeps *Could not read this delivery* and Retry. Only the delivery notice changes words; the other read notices are as before.

## 6. The fixed head was never offered for a push

**Cause.** Not the delivery's card logic: §13 binds a card's answer to its input SHA ("changed input makes the earlier decision stale"), and `delivery.ts` already starts over on a moved head (`#reconcile` → `moved` → `#deliver` → `#recordResult` and `#openPush`). `#deliver` never ran because `workResultOf` was not complete: the planner's `cancel_task` (`service.ts` `#persistExtras`) saved `status: 'cancelled'` with no `cancelledReason`, and the reducer (`packages/domain/src/work-result.ts`) reports such a task as "cancelled with no reason". So the delivery stayed `moved`, with the old summary, and nothing on Work could move it.

**Change.** A planner cancel stores `cancelledReason: 'cancelled by the planner'`. `workResultOf` also reads a cancelled task with no reason but with its own `task_cancelled` event (the record the planner's cancel has always written) as the same exclusion, so the live work item from the walkthrough completes on 0.3.7 without a data migration; a cancel with neither stays unexplained. `#reconcile` also clears `answer` and `prTarget` with the other old-head fields, so the denial is not carried onto the new head's record. Chosen behaviour, per §13 and the module's own rule ("a head that moved starts over"): the new head opens a new push card on its own. Decision #63 (the declined-push stage) is about the old head and still holds while it is the head.

## Not changed

- `packages/contracts` is untouched; no fixture or CONTRACTS §10 line is needed.
- The owner's Try again on a task blocked by its own report is still a repair in that task's worktree (§15). Only a replan that changes the task restarts it.
- A dependent blocked as "prerequisite <key> cannot finish" is not released when its prerequisite restarts; it waits for its own replan or Try again.
- Decision #66 also moves the base of a task with no dependencies that simply launches after another task of the same plan integrated (a slot was busy). That follows the owner's rule as worded; `contract` opts such a task out.
