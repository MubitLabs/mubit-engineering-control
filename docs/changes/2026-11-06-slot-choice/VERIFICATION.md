# Verification: slot choice

Observed on 6 November 2026, branch `fix/slot-choice`, machine loaded by other worktrees' test runs.

| Check | Result |
| --- | --- |
| `npx vitest run packages/domain/test/scheduling.test.ts` | 36 passed |
| `npx vitest run packages/meta/test/scheduler.test.ts` | 41 passed |
| `npx vitest run apps/desktop/test/attempt-launch.test.ts` (whole file, twice) | 53 of 56 passed, then 21 of 22 with `-t "the launch path"`. The failures differed each run (three launch-path tests, then "close stops a running attempt"), each a 45 s `condition never held` wait. Every failed test passed when rerun alone (3 together: 10.8 s; "close stops..." alone: 7.8 s). A clean whole-file run was not obtained. |
| Failing first | New domain tests against the old `packages/domain/src/scheduling.ts` (temporary checkout, restored): 9 failed, 27 passed. Not shown for the meta and desktop tests. |
| Old source, three launch tests alone | passed (so they are not failing for lack of this change) |
| `tools/mutants/slot-choice.json` | 13 of 14 killed in the full run; `pin reason lost` reported INVALID there, and KILLED when run alone. Tree clean afterwards. |

There is no `planner-placement` test file; `plannerPlacement` is covered through `attempt-launch.test.ts` (the gemini, meta engine and retired meta slot cases).

Not run: `pnpm check` (typecheck, lint, suite B and A in full), any real engine, the live `~/.mec`.
