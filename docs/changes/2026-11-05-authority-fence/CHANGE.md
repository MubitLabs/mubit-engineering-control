# M1.4a: Authority fence, hold, stop and persistent pause

**What.** The owner can hold, lift, stop, pause and resume over HTTP and from the classic UI. A stop during a planner turn means nothing launches, ever. A hold survives restart and only the owner's lift releases it. Pause survives restart and starts no effects, including during shutdown.

**Why.** Before this, a stop written during the brain's await was overwritten by the commit, an answered question could move stopped work to `executing`, the planner could lift a hold, nothing checked authority at launch, and pause lived in memory while `close()` drained the queue regardless. Decisions #20 and #21, spec §10, §12.5, §13 invariant 4, §20.

**Design.**

- `packages/meta/src/authority.ts` holds `mandateOf`, `isHeld`, `launchAuthority` and the writers. The writers run in the caller's transaction and need no meta agent, so hold and stop work with no meta slot.
- One stop path, `stopWorkItem`: the machine moves the work and `withdraw` applies to the mandate in the same write. The withdrawal goes on the existing `work_stopped` event, so the stream's event list is unchanged.
- A failed turn or a rejected plan stops work only in `planning`.
- `#fencedTurn` re-reads the work at the top of `#commitPlan` and in `#ackOnlyTurn`. There is no await between that read and the commit, so it is the same read as one inside the commit's `atomic`, and placing it first also covers an invalid plan, which would otherwise be answered as a failed start and count against the escalation streak.
- `#dispatch` is the extracted block, in its M1.2 form, plus a re-read. It must re-read: a route in the same turn can hold or stop the work after the commit began.
- `launchHandler` calls `launchAuthority` first, fake path included. `drop` drains the row with a `launch_refused` event; `defer` throws `Later`.

**Changes the handoff did not name, each forced by a requirement.**

- `guard` in `composition.ts` now passes `Later` through. It marked the kind's health as `error` on every deferral, which breaks "defers without counting a failure".
- `runFakeLaunch`'s `saveAttempt` now keeps the stored doc. `save` replaces, so a fake launch wiped `taskId` and `workItemId`: stop could not find the attempt and lift launched its task a second time. `WorkItem.held` in `apps/web/src/api.ts` sits outside the operator-commands block for the same reason: `live.held` needs it.
- A replan no longer writes `execution_started` to the stream unless the state moved. Blocked work stays blocked on a replan and does not dispatch; before this a replan moved it to `executing`.

**Intended test change.** `packages/domain/test/states.test.ts` gains `queued --interrupt_confirmed--> interrupted` (requirement 13). No other existing test changed.

**Owner decisions applied (#36).** Mandate `scope` is the first 200 characters of the origin message, `budgetTurns: 0` means unset, `expiresAt: null`, nothing enforced. `policy_changed` at launch drops the launch and blocks the work with `blockedReason: 'policy_changed'`. A planner `hold` or `stop` on a wake turn is refused with `route_refused`. Legacy read-only work takes a stop and refuses hold and lift (409 `read_only`).

**Judgement calls, for review.**

- Lift places ready tasks with no attempt at all, not "no live attempt". The fake path leaves a task `ready` after its attempt succeeds, so "no live attempt" would launch finished work again. It matches the rule `#commitPlan` already uses for a kept task.
- Lift with no meta agent answers 409 `no_meta_agent` and keeps the hold. A lift there has no dispatch, so it would spend the hold and strand the saved tasks. Work not held still answers `free`.
- A policy change does not outrank a hold: the launch keeps deferring and the lift answers 409 `mandate_policy_changed`. Stop is then the exit.
- A launch with no repository is dropped as `repo_mismatch`. M1.2 already says Unassigned work never launches.
- A dropped launch leaves its attempt `queued` unless a stop already moved it. Only `stopWork` was asked to change attempts; decision #26's `failed` state is the natural home.

**Spec mismatch, for the owner.** §17 says re-enqueuing a waiting key makes it due at once, but `upsert` keeps `next_run_at`. So a launch deferred by a hold restarts within `LATER_DELAY_SECONDS` (30 s) of the lift, not at once. Left as it is, as the handoff directs.

**Spec lines proposed (not edited).**

- §6: "A hold is lifted only by the owner's explicit lift command; the meta agent has no way to lift one, including from a chat message (decision #20)."
- §12.5: replace "the user's explicit go does" with "only the owner's explicit lift command does; a chat 'go' does not (decision #20)."

**Not done here.** Killing a running process on stop (M2.1), per-kind pause (M2.4), durable wakes and truthful non-fake launch (M1.4b).
