# Verification: M3.3 Stage B

Builder's own evidence. The handoff's separate verifier step was waived for this run, and the scratch-server walk (handoff Stage B item 5) was not done. No engine ran.

## Failing first

`npx vitest run` on `apps/web/test/config-model.test.ts`, `config-contract.test.ts`, `apps/desktop/test/parked-route.test.ts`, `server-port.test.ts`, `inspection.test.ts`: 17 failed before the change, on missing functions, a 404 from `/api/parked`, `switchWork: false`, a new port each restart, and `Waiting for quota (reset time unknown)`. All pass after it.

## Browser

`playwright test config.screens -g "parked work|retire arms|expired sign-in"` under the shared lock: 3 passed. The new case walks the facts, the arm, the disarm, the confirmation answer and an auth park with no switch, on the sample server. Baselines were not re-run.

## Mutants

18 added to `tools/mutants/m3.3-config.json`, run alone from a scratch spec: 18 of 18 killed. `offer the slot the work is parked on` survived first and is killed by the recovered-slot assertion. The six port mutants were re-run after the port moved behind `reuseLastPort`. The Stage A mutants were not re-run on the replay.

## Full gate

`pnpm check` was never green as one run on this shared machine. Typecheck and lint pass. The test step failed 25 and then 42 tests, all process-start and wait timeouts, with `Failed to start forks worker` and `syspolicyd` at 84% CPU.

- `vitest run --maxWorkers=3`: 2836 passed, 4 failed, 17 skipped, and three files never got a worker.
- The failures: `login-cards` (the baseline node-pty failure), two in `pause-attempts.test.ts`, one in `a11y-gate.test.ts`.
- Serially, `attempt-launch`, `coordination`, `pause-attempts` and `recovery`: 108 passed. `inspection`, both `packages/git` repos files, `a11y-gate` and `pause-attempts`: 80 passed.

An earlier failure, `a saved policy survives restart` with `ECONNRESET`, was real and came from reusing the port inside one process. That is why reuse is `serveMain`'s option and not the default.
