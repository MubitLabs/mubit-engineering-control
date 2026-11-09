# Verification

Branch `fix/stop-and-stages`, base 7a7dd82. The builder ran these checks on 9 November 2026. No real engine was used, nothing touched `~/.mec` or the running server, and nothing was pushed. `pnpm check` was not run (the machine is loaded, and CI is the gate).

## Failing first

| Item | Test | Red |
| --- | --- | --- |
| 1 | `apps/desktop/test/restart.test.ts` "mec stop" (real built tree, real server, scratch `MEC_DATA_DIR`) | `expected 'intentional stop recorded; …' to contain 'stopped pid 71522'`: the walkthrough's finding, with the server left running |
| 1 | `restart-proof.test.ts` "what mec stop says when it cannot finish" (2), `mec-cli.test.ts` "mec stop" (2) | `stopServer` was missing, and stop exited 0 without signalling |
| 1 | `serve-shutdown.test.ts` (4) | `closeWithin` / `SHUTDOWN_BOUND_MS` were missing |
| 2 | `packages/domain/test/stages.test.ts` (6, including the table order and fixtures) | `deliveryStopped` was missing; a declined push read Working |
| 2 | `inspection-trace.test.ts` "a declined push reads as declined …", "a failed pull request step …" | `{ key: 'working' }` and `'Working'` |
| 2 | `packages/meta/test/context-stage.test.ts` "a declined push reads as Work reads it" | `Received: "Working"` (seen red with the context change stashed) |
| 3 | `meta-visibility.test.ts` "an older answer the same turn reported against other work …" | `ended/no-answer` (seen red with the read reverted) |
| 4 | `packages/meta/test/repair.test.ts` "Try again on an integration whose repairs are used up" (2 of 4 red) | `ownerRepairOffer` returned undefined; the second press was not refused |
| 5 | `apps/web/test/delivery-surfaces.test.ts` (2) | `'Add audit view is blocked'` with the reason repeated in the body |

Green from the start, as guards: "a report from another turn is not this one's answer", "held work and a repository not agreed … offer nothing", and "an integration with no failure on record offers nothing".

I changed two existing assertions on purpose:
- `delivery-surfaces.test.ts` now expects the new sentence (finding 5).
- `restart.test.ts` "a restart that honours a stop leaves the running server alone" now writes the marker directly, because `mec stop` now stops the server (finding 1). What it asserts is unchanged: `--respect-stop` leaves a live server alone.

## Mutants

`python3 tools/mutants/run.py tools/mutants/stop-and-stages.json`: 18 of 18 killed.

## Suites

- `vitest run packages/domain packages/meta packages/store apps/web`: 68 files passed, 1 skipped; 1274 tests passed.
- `vitest run apps/desktop` in parallel: 53 tests in 12 files hit timeouts under machine load (20–60 s timeouts, `no announce after 40000ms`). Those 12 files rerun with `--no-file-parallelism`: 12 of 12 passed, 307 of 307 tests. The other 38 files passed in the parallel run, `restart.test.ts` included (11 of 11).
- `pnpm test:screens` (under `/tmp/mec-screens.lock`): 1034 passed.
- `tsc --noEmit` in apps/desktop, apps/web, packages/domain, packages/meta and packages/store: clean.
- `biome check` on the touched files: no errors; the warnings are the same as on base (17 `noExplicitAny`, 1 unused import, 1 unused variable).
