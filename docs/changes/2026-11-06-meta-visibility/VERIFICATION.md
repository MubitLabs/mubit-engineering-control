# Verifying meta agent visibility

Builder's evidence, from this branch's worktree. A separate behaviour verification is still to run.

## Evidence of the causes (read-only GETs on the installed 0.3.0)

- `wi_mw59961s1wu8bt1`: `delegation: []`, and `att_1` holds `slotId`, role, `requested.tier: fast`, and `session_started.model: claude-haiku-5-5`.
- `wi_mw59ad2z390yd5m`: `result_reported.summary` holds the answer, and the chat line has only `ackText`.
- `wi_mw5auzox46qjk53`: `planning_started` only. The message has `ackText`, `tasksCreated: 0`, `updatedAt` 27 s after `createdAt`.

## Failing first

- `apps/desktop/test/meta-visibility.test.ts`: 22 of 23 failed before the server change, then 23 passed.
- `apps/web/test/meta-visibility.test.ts`: failed to load on the old delegation shape, then passed.
- `apps/web/test/submission.test.ts`: the two pinned assertions on "draft clears only on success" changed on purpose, and new cases cover the restore.

## Intended test changes

- `inspection.test.ts`, `inspection-trace.test.ts`: `delegation` was pinned empty. It now lists tasks from attempts.
- `work-model.test.ts`, `work.screens`, `work-live.screens`: the heading is the repository, not the request.
- `submission.test.ts`: the box clears on send.

## Mutants

`python3 tools/mutants/run.py tools/mutants/meta-visibility.json`: 21 of 21 killed.

## Screens

Under the lock, in this worktree: the whole suite, 936 passed, axe clean at 1440, 1024 and 390 in both themes. The `work-conversation` and `work-inspector` baselines were regenerated for all six cells.

## `pnpm check`

Typecheck and lint pass. The test step did not go green on this shared machine: two full runs gave 69 and then 50 failures, in process-spawning files, with a different set each time (`condition never held`, `attempt never left queued`, worker start timeouts). After fixing one real miss of mine (`sse-resume.test.ts`), running the 14 failing files one at a time gave 310 of 311. `coordination` and `attempt-runner` each passed alone. `recovery.test.ts` still fails alone with a changing set, 1 to 5 tests. On a clean export of `origin/main` it does the same: 2 failed, then 7 failed, in other tests. `packages/runtime` and `packages/engines` have no diff here. A clean run on a quiet machine is still owed.

## Scratch smoke

Built app, scratch `HOME` and `MEC_DATA_DIR`, fake engine. `/api/inspect/meta` answers `connection: null`, then idle with `at: null`, then `waiting_specialist`. The delegated work's detail lists both tasks: one with its placement reason, one with `waiting: dependency`.

## Not run

- No real engine ran, by the brief. So these are proven only over fakes: `session_started` reaching `meta/session` through the real adapter, the phases on a real planner turn, and whether the new protocol wording makes the planner answer.
- The installed server cannot serve `/api/inspect/meta`: this needs a build.
