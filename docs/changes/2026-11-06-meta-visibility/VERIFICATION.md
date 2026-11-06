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

Under the lock, in this worktree: `work`, `work-live`, `a11y`, `next` and `keyboard` suites, 462 passed, axe clean at 1440, 1024 and 390 in both themes. The `work-conversation` and `work-inspector` baselines were regenerated for all six cells.

## Not run

- No real engine ran, by the brief. So these are proven only over fakes: `session_started` reaching `meta/session` through the real adapter, the phases on a real planner turn, and whether the new protocol wording makes the planner answer.
- The installed server cannot serve `/api/inspect/meta`: this needs a build.
