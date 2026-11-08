# Verification

Branch `fix/ceiling-and-reference` on base 8d8bc8f. Run by the builder on 8 November 2026. No real engine, no `~/.mec`, no port 61610, no push.

## Failing first

Each test was written before its fix and seen red for the intended reason, then green.

| Item | Test | Red |
| --- | --- | --- |
| C1 | `packages/domain/test/scheduling.test.ts` "blocks new placements above the utilisation ceiling", "a ceiling wait names the least used", "the ceiling is a bound" | `reason: 'capacity'` with no `slotId`, where `utilisation_ceiling` was expected |
| C1 | `packages/meta/test/scheduler.test.ts` "the utilisation ceiling, in words" (4 of 6 red) | a slot at 90% took nothing (80% ceiling); the defer was `capacity` with "a slot unit comes free"; no chat line |
| C1 | `apps/desktop/test/recovery.test.ts` "a live park tells chat and the slot the same thing" (new assertion) | the slot doc had no `usageWindow` or `usageResetsAt` |
| C1 | `apps/desktop/test/meta-visibility.test.ts` "a wait on a connection at its ceiling" (3) | Delegation `until Claude account …`; Work row reason `null`; live line `No specialist is running on this request` |
| C2 | `packages/meta/test/service.test.ts` "sent by reference to the running work" "is answered in the chat by a planner turn" | `expected [] to have a length of 1`: no planner turn, the message went to the specialist |

Written with the fix, green from the start, to pin today's route: "a referenced message that asks nothing still lands with the running work", "with nothing running, a referenced question keeps the turn on that work it has today", "a full slot is still a unit coming free, with no chat line", "names the ceiling only when no unit coming free would release the task", and "the reset reads as a day and a time a person knows".

One assertion changed on purpose: `scheduling.test.ts` "blocks new placements above the utilisation ceiling" expected `capacity`, and now expects `utilisation_ceiling` with the slot (owner ruling, 8 November 2026).

## Mutants

`python3 tools/mutants/run.py tools/mutants/ceiling-and-reference.json`: 15 of 15 killed.

## Suites

- `pnpm typecheck`: clean. `pnpm lint`: no errors (warnings as on base).
- `pnpm test:a`: 108 files passed, 1 skipped; 1896 tests passed.
- `vitest run --project b --maxWorkers=3`: 4 failed, 1921 passed. The failures were `packages/runtime/test/supervisor.test.ts` (3 stray-process stop cases, about 2.2 s each) and `apps/desktop/test/bundle-defaults.test.ts` "fails a package with no workbench" (60 s timeout). This change touches neither. Run alone, both files passed (37 of 37). An earlier full `pnpm test` with both projects at once timed out about 30 process-heavy cases in runtime and desktop. That was load on a shared machine; the same files then passed in the run above.
- `apps/desktop/test/version-sync.test.ts` on the 0.3.1 tree: passed.
