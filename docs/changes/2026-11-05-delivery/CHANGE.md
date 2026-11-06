# M2.3: Acceptance, integration and delivery

Handoff: `docs/changes/2026-11-05-meta-agent-journeys/handoffs/22-m2.3-acceptance-integration-delivery.md`. Base: `03c44e4`, a local branch, by coordinator waiver.

## What it does

Local checks on the exact head decide acceptance, not an engine exit. Accepted tasks merge into one integration worktree, one task per pass, and combined checks run on the exact merge SHA. When every required task is in, MEC records a local result and opens a push card. An approved push opens a PR card. An approved PR plus observed checks gives a tested PR ready for review. Merge stays a separate decision, and a declined card keeps the local result.

## Design

- **`acceptance` (`packages/domain/src/acceptance.ts`)** replaces `acceptRoutine`. A pure reducer over attempt state, head, last report, verdicts, findings and policy. It answers `accepted`, `review`, `repair`, `blocked` or `pending`.
- **`workResult` (`packages/domain/src/work-result.ts`)** is the §15 definition of done. `report_result` now stores its output beside the planner's words, in the `result_reported` event.
- **`packages/meta/src/repair.ts`** holds the cap logic and the evidence text. `next` on a task is what comes after a failed attempt. A pass places it through the same caps as any launch, and the attempt carries it as `continuation`.
- **`packages/integration/src/controller.ts`** is `runIntegration`: one step, injected git and checks, and a next state the caller saves. `nextIntegrationStep` picks the step.
- **`apps/desktop/src/delivery.ts`** is the deterministic result path, driven by the 2 s timer behind `MEC_REAL_RUNNER=1`. Its record is `delivery/<work>` in `store.engines`, and its `stage` is what is true now: `local_complete`, `no_change`, `dropped`, `push_card`, `pushed`, `pr_card`, `pr_open`, `ready`, `declined`, `failed`, `closed`, `merged`, or `moved` for one pass after a head moved. The integration state is `integration/<work>`.
- **No contracts change and no SQL migration.** Everything new is a document or a field on one.

## Things the handoff did not settle, and what this did

1. **A `ready` report cannot name its head.** The handoff says a `ready` without passing checks on its `head_sha` is no acceptance. But an attempt cannot commit: MEC commits the tree it left after it reported, so a truthful report names the commit before, or nothing. Applied literally, no real attempt could ever be accepted. The reducer keeps the rule, and its test. `reportHead` in the scheduler binds a report to MEC's commit when it made no claim, or when its claim was the worktree's real head at that moment (`head_matches`). A false claim stays false and goes to a repair.
2. **`resolveReleaseCard` is not the only door.** The hook was specified there, but `/api/release/{push,pr,merge}/:id/resolve` call `resolvePush`, `resolvePrCreate` and `mergeBehindCard` directly, so continuation would have depended on who answered. The hook is in those three functions (`announce`), and `resolveReleaseCard` goes through them.
3. **Findings have no field.** `Report` has `artifacts` and `round`, and contracts must not change. A finding is an artifact `{kind: 'finding', ref}`, and it binds to the head of the attempt that reported it. The reviewer's brief says so.
4. **`sensitive` is a new optional field on a plan task** (`propose_plan` schema, `MetaPlanTask`, the stored task), because #33 says the planner sets it. A replan cannot clear it.
5. **Required checks are everything registered plus anything the task names.** The runner runs them all and `succeeded` already needs them all, so a plan cannot narrow them. A task that names none stores the registered names. The marker is stored only where a repository has none, and a plan cannot name it where real checks exist.
6. **A repository with no checks blocks its task** with that reason. M2.2 left the task `awaiting_review` forever, saying nothing.
7. **A repair reuses the worktree (§15).** That took more of `attempt-launch.ts` than the base pin: `role` and `continuation` from the attempt, the worktree and branch, and one generated section. It stays out of the registry row. A worktree that is gone refuses the launch rather than recreating it empty.
8. **`mergeIntoIntegration` gained an optional `identity`.** A bare cache has no user, so `git merge` could not commit. `packages/git/src/merge.ts` was not on the handoff's list. The alternative was writing to the cache's config, which `commitIdentity` reads, and that would change who may launch.
9. **The attempt's commit is `commitWork`.** In a mid-merge worktree it calls `completeMidMerge`, which proves two parents, and it refuses a file that still has conflict markers. Otherwise it is `commitAll`, untouched. `attempt-runner.ts` needed no hook: checks already run on the head.
10. **`yieldCheck` skips MEC's own branch**, as well as taking the default branch. Otherwise, once pushed, a moved head would yield to itself.
11. **A pending card goes stale when the local head moves** (`staleCard`). A PR card binds the head on GitHub, so a local commit after the push would not have staled it at approve. It settles as policy, and it uses `deny` so it can never read as consent.
12. **Delivery reads the base from the work item.** `#pinBase` now also saves `default_branch` (#36, read at pin time) and `git_dir`, because a second `RepoCache.ensure` would race the launch's fetch.

## Decisions applied

- **#29:** work stays `integrating` until GitHub says merged, then `done`.
- **#32, #33:** routine acceptance on the checks, one review for sensitive work, and a planner-set flag only.
- **#34:** `no_required_checks` is `ready` with `limit: 'no_required_checks'`. The merge gate still holds.
- **#36, open question 5:** a repair task for an integration conflict or red combined checks, a new attempt for a task's own failed checks, one counter.

UI evidence (§15) is not required: repository docs have no such field yet.

## Intended behaviour changes to existing tests

| Test | Before | After | Why |
| --- | --- | --- | --- |
| `scheduler.test.ts` "checks failing on the head…" | blocks with `failed its checks on abc` | with no repairs left, blocks with `Check unit failed on abc` | Failed checks now repair first. The block is reached at the cap, and it says what remains. |
| `scheduler.test.ts` "only the last report counts…" and "acceptance moves…" (was "an interim acceptance") | `succeeded` with no checks accepts | a stored verdict on the head accepts | That was the interim rule. |
| `coordination.test.ts` "two-task contract chain…" | waits for two `accepted` | waits for two `accepted` or `integrated` | Delivery may integrate them first. The chain assertion is unchanged. |
| `coordination.test.ts` "a report wakes the planner…" | exactly one note | exactly one note from the attempt | The local result is also a note, from MEC. |
| `release.test.ts` `yieldCheck` calls | three arguments | a fourth with the default branch | The signature change the handoff asks for. |
| `caps.test.ts` | six fields | seven | `reviewRoundsPerTask`. |

## Risks

- **A crash mid-merge is not recovered.** The worktree stays mid-merge with its state unsaved, the next merge refuses, and the work blocks with the reason. Part of 23 Part A.
- **A pass is serial.** A long combined check holds the other work items' integration for its length.
- **A replan cancels a repair task,** because it has no key in the plan. The root task then blocks with that reason, so nothing is lost silently.
- **Rounds at the cap block.** §15 says a task at the cap is delivered with unresolved findings stated. The handoff says it blocks with what remains, and this follows the handoff. See the owner question in `VERIFICATION.md`.
- **Target movement only re-reads required checks.** Nothing updates the integration branch: "branch updating stays outside the card".
- **`gh` reads once per 30 s for each open PR.** A busy repository could hit a rate limit with many open PRs.
- **The first exec of a new script took 25 s** on this machine, late in a test file: the fake CLI's own start, `seen.json` shows it. The tests in `delivery-flow.test.ts` allow 120 s for it.
- **`local_result` wakes nobody.** It is an event and a note, so §6 is untouched, but the planner says it only on its next turn. The push card is what the owner sees first.

## Not in this PR

Crash reconciliation (23 Part A), stage labels (M3.1), showing delivery stages (M3.2), profile editing (M3.3), scorecard outcomes, and any real GitHub write. `prTarget: 'pending'` is on the delivery record for M3.2 to show.
