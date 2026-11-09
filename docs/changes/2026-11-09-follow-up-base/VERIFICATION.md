# Verification

Branch `fix/follow-up-base`, base e55ac9f (v0.3.6). The builder ran these on 9 November 2026. No real engine ran. `~/.mec` was read only through `sqlite3` SELECTs on `mec.db` (events, the work item's tasks and attempts, `delivery/` and `integration/` docs, the push confirmation); the installed server on port 61610 was not touched. Nothing was pushed.

## Failing first

| Item | Test | Red |
| --- | --- | --- |
| 1 | `apps/desktop/test/follow-up-base.test.ts` (5) | `taskBase` is not exported (5 failed) |
| 1 | `apps/desktop/test/delivery-flow.test.ts` "a follow-up after a denied push starts on the integration head and offers the fixed head" | `expected '62030f0…' to be '4f5e0dd…'`: the fix task's `base_sha` was the pin, not task_1's integration head |
| 6 | the same journey, after item 1's fix | `condition never held` waiting for the second push card, after the planner cancelled `spare`: the incident's state (`moved`, old summary, no card) |
| 2 | `packages/meta/test/follow-up.test.ts` "a changed dependency runs the task again …", "a changed objective or base policy …", "says the task is still blocked …" | `expected 'blocked' not to be 'blocked'`, and no note on the report |
| 3 | `follow-up.test.ts` "integrated tasks are on the local integration branch …" | the context had no `integrated locally` line |
| 4 | `packages/domain/test/stages.test.ts` "work running after the decline reads as Working …" | `Push declined` while an attempt ran |
| 5 | `apps/desktop/test/server.test.ts` "/api/status names this build's version …" | `version` absent |
| 5 | `apps/web/test/stale-page.test.ts` (7) | `../src/live/stale` did not exist |

Written with the fix and not first seen red: `follow-up.test.ts` "a cancel stored before 0.3.7 …" and "is cancelled with a reason …" (the service change for item 6 landed while I was locating the cause; the mutants below show both tests see it), `context-stage.test.ts` "a fix running after a declined push reads as Working", `inspection-trace.test.ts` "a fix running after a declined push reads as Working …", and the two screens in `work-live.screens.playwright.ts` ("… says MEC was updated, with Reload", "the same build … says so, with Retry").

The journey reproduces the walkthrough without any steering: one message, the push card denied, a follow-up that plans a fix with `dependsOn: []` (and a task pinned to a slot that does not exist, so it never starts), the fix integrating from task_1's head with task_1's file in its tree, the worker brief naming that base, a second follow-up whose planner cancels the stuck task, and then a second push card for the new head: `[['denied', <built>], ['pending', <fixed>]]`, the delivery at `push_card` with no `answer` and a summary at the new head.

No existing assertion was changed.

## Mutants

`python3 tools/mutants/run.py --self-check tools/mutants/follow-up-base.json`: no-op SURVIVED, syntax error INVALID, as expected.
`python3 tools/mutants/run.py tools/mutants/follow-up-base.json`: **25 of 25 killed** (items 1: 4, 2: 6, 3: 3, 4: 4, 5: 5, 6: 3).

## Suites

- `pnpm test` (both projects, on a loaded machine, load average above 6): 3677 passed, 34 failed in 11 files, all in `apps/desktop` and `packages/runtime` real-process suites, every failure a timeout (`condition never held`, 40 to 60 s hooks, single tests reporting 900+ s). A second full run failed a different set (35). Each of those files then passed run alone: `supervisor` 19, `attempt-runner` 28, `codex-client` 25, `approval-key` 19, `composition` 28, `engine-registry` 61, `recovery` 51, `delivery-flow` 8, `attempt-launch` 60 and `coordination` 18 (these two needed a third, quieter run; their second run also timed out).
- Every `packages/domain`, `packages/meta`, `packages/mec-tools`, `packages/prompts` and `apps/web` test passed in the full runs.
- `pnpm typecheck`: clean. `pnpm exec biome check .`: 0 errors; the warnings in this change's files are two pre-existing unused imports in `apps/web/src/live/config.tsx`, which this change does not touch.
- `pnpm test:screens` in `apps/web` under `/tmp/mec-screens.lock` (`lockf`), port 4173 free when the lock was taken: **1043 passed**, 0 failed, no `--update-snapshots`.
- `pnpm check` as one command was not run green on this machine because of the load timeouts above.
