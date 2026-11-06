# M2.4 Part A: crash and capacity recovery

Handoff: `docs/changes/2026-11-05-meta-agent-journeys/handoffs/23-m2.4-crash-capacity-recovery.md`, Part A. Branch `feat/m2.4-recovery`, based on `feat/m2.3-delivery`. Part B is `feat/m2.4b-engines`.

## What changed

- **Boot order (§20, O9).** Lock, journal replay, process reconciliation, external reconciliation, effects resume, then dispatch. `recovery/last-boot` records the order. All of it is in `apps/desktop/src/recovery.ts`, driven from `composition.ts`.
- **Journal replay (§8.6).** `Runtime.replay` and `replayJournal`: the unacknowledged tail, deduped by attempt, generation and seq, ack after commit. `#replay` in `service.ts` reads the generation instead of hardcoding 1.
- **No orphans (§8.1).** Pid and `ps` start time are stored on the attempt the moment the group exists (`process`, and `check_process` for a repo check). A boot signals only a group whose leader has that pid and start time and leads its group. A recycled pid means ours is gone. Anything else is reported as `attempt.reconcile_refused`, never signalled, and the attempt stays stalled.
- **The planner's engine.** It is now an owned group, so `close` can SIGKILL one ignoring SIGTERM, and that lets the brain remove its token tmpdir. Pid, start time and tmpdirs are on `runtime/planner`, so a boot ends what a killed server left. A boot removes only dirs listed on that doc, in the system tmpdir, with the planner's name pattern. This closes the two open items in `2026-11-05-durable-commands/CHANGE.md`.
- **Restart (§20).** `running → stalled → interrupted`, a new generation, one `launch` row marked `resume`, oldest work first. The same slot's session continues with `--resume`. The recovery note is the first stdin line. A graceful shutdown's `server_closing` attempts restart the same way. Parked, failed and blocked attempts stay. A message waiting for the old generation reaches the new one.
- **Mid-check restart.** An attempt cut short during checks, by a crash or a shutdown, runs the repo's checks again on the same head with no engine and no token. A stop's verdict stands. A worktree off its head or with a moved `.git` is not judged: `head_moved`, which blocks the task.
- **External reconciliation (§17, §20).** An approved card with no outcome is read from the remote: `ls-remote` for a push, PR by head, PR state. It is recorded with `reconciled: true`, or as `push_not_sent`, `pr_not_sent`, `merge_not_sent`. A remote that cannot be read records nothing and is read again next boot. Delivery hears the outcome as it hears an answer. Nothing is sent.
- **Pause (#21).** Per kind by `Later`: launch, deliver, relay, reply. Notes, probes and running turns go on. Resume makes deferred rows due, so they do not wait out a second pause length.
- **Stop (§12.5).** A group that will not go records `attempt.stop_failed` and the attempt stays as it was. `interrupted` still comes only after the group is gone.
- **Live parking (§5.10).** A rejected rate limit or a quota, auth or provider error stops the group as it arrives. The slot degrades, chat gets a notice, and the meta agent gets the same words as a note or a wake per `classifyWake`'s rule. A turn that finished before the stop landed keeps its work.
- **Probe (§5.8, §11).** The `probe` effect runs `claude auth status` for `claude-sub` slots at boot and every three minutes, only with the runner on. A slot waiting out a reported reset stays degraded. Readings reach placement as `usageUtilization`.
- **Resume (§5.10).** Reset passed plus a probe after the park, or the next healthy probe when unknown, or `POST /api/work/:id/resume`. All go through `resumeVerdict`: mandate first, never past a hold. A resuming attempt holds its capacity.
- **Switch (§5.10, §13).** `POST /api/work/:id/switch-slot`, behind a `slot_switch` card unless policy pre-authorises it. `planFailover` decides, the target is probed again when it applies, and a new attempt runs on the same worktree with a handoff doc and no session. An auto pair needs the slot's `pairs` and a policy pre-authorisation.
- **Sleep and stall (§20).** A sweep ends an attempt whose wall clock ran out asleep, and a dead group with a journal silent for 30 s stalls and reconciles.
- **CLI.** `mec restart` clears the marker, says no server was started and exits 1. `cliHome` honours `MEC_DATA_DIR`.

## Fixes from the blockers-only review

- **A switch and a resume exclude each other.** `parkedOn` skips a resuming attempt, and the resume gate drops an attempt with `switched_to`.
- **One switch per parked set.** `applySwitch` decides again inside its atomic block, and refuses a set that changed during its awaits (`stale`).
- **An approval is of what the card stated (§13).** The card hashes and states the parked attempt ids. An approved card whose set no longer matches is refused `stale` and still marked applied.
- **Ended work does not move.** A switch answers `work_ended` for terminal work or a withdrawn or expired mandate, and `policy_changed` for the third way the launch gate would drop the row.
- **Nothing launches beside a live group.** A parked attempt with a resume on its way is reconciled like an interrupted one. The launch and resume gates defer while `reconcile_refused` is set, and a boot that proves the group gone clears it.
- **Reason redaction.** The composition's attempt cleaner is a switch dep, so the pre-authorised path cleans the reason before its first write.
- **The planner mark survives what it cannot prove.** An unprovable or refused group moves to `refused` on `runtime/planner`, is reported as `planner.reconcile_refused` on each boot, and keeps its token dirs until a boot proves it gone.

## Decisions taken inside the handoff

- **No second row for a resume in the launch gate.** `launchAuthority` stays as it was. A resume row has `resume: true` and `resumeAuthority`. Any other late row for a non-queued attempt is still dropped.
- **The attempt stays `interrupted` until its engine is up.** `resume` is applied after the start. Marking it `running` at enqueue would leave a running attempt with no process during a hold or a pause.
- **Approved switch cards are applied by a pass**, not in the inbox route, which this handoff may not touch. It also means a crash between approval and switch is only a late switch.

## Files outside the handoff's list

Needed, each small. None belongs to a branch in flight except as noted.

- `packages/meta/src/`: `scheduler.ts` (a resuming attempt occupies; `head_moved` blocks), `followups.ts` (a resuming attempt keeps its messages; delivery follows the current generation), `repair.ts` (`handoff` continuation), `real-brain.ts` and `brain.ts` (`onTempDir`), `index.ts`.
- `packages/store/src/effects-queue.ts`: `wakeDeferred`. This also closes the "answer during a pause wakes late" limit for rows a pause deferred.
- `apps/desktop/src/core-facts.ts`, `packages/runtime/src/{checks,owned-spawn,index}.ts`.
- `packages/testkit/fake-cli/claude`: answers `auth status`.
- `apps/desktop/package.json` and `pnpm-lock.yaml`: the workspace package `@mec/failover`. No third-party dependency.

## Assertions changed on purpose

- `composition.test.ts`: `reconcile to stalled` is now `interrupted` (requirement 4). A launch held by a pause is now a `waiting` row, not `pending` (requirement 6). `probe` left the "no handler" list (requirement 10).
- `attempt-runner.test.ts`: `replay names what is not wired` became a test of replay.

## Compatibility

No SQL migration and no contracts change. New fields sit in existing json docs. `mec restart` now exits 1.

## Risks

- **First boot after upgrade** restarts attempts earlier builds left `stalled`, through the same mandate and hold gate. That can spend quota on old work.
- **Part B overlap.** Both branches touch `supervisor.ts`, `owned-spawn.ts`, `attempt-runner.ts`, `attempt-launch.ts` and `composition.ts`. Part B's strays logic is not in `reapGroup`, so a boot does not reach a command that left the group. Its `ownedSpawn` needs a `stdin` hook that Claude's stream input must keep.
- **A rejected window that does not stop the engine.** §5.9 says `rejected` parks, and the live park now ends the run at once. An `overage` rejection with other windows allowed would park work that could have gone on. No real recording shows this.
- **Session resume is unproven on a real engine**, including a session that no longer exists, which would end the attempt `no_session`.
- **An input the engine took just before a crash** can arrive twice when the session is resumed, if the crash came before `delivered` was stored.
- **A group whose leader died** cannot be proven ours, so it is reported and its attempt stays stalled until a person acts.

- **A launch row dropped after a switch.** The refusal closes the door at the switch, but a mandate that expires between the switch and its launch still drains the row and leaves the queued attempt holding capacity. This is the existing behaviour of any queued attempt.
- **A planner group that stays unprovable keeps its token dir on disk** until a later boot proves it gone.

## Rollback

Revert the branch's commits. Docs written by this build keep extra fields that older code ignores.
