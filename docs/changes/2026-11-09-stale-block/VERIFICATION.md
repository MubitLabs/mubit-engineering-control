# Verification

Branch `fix/stale-block`, base cb9050c (v0.3.7). The builder ran these checks on 9 November 2026. No real engine was used. `~/.mec/mec.db` was only read, with `sqlite3`, for the evidence in CHANGE.md. The installed server was not touched, and nothing was pushed.

## Failing first

| Item | Test | Red |
| --- | --- | --- |
| 2 | `packages/meta/test/scheduler.test.ts` "an accepted task does not wait behind blocked siblings it does not depend on (§14)" | the work went `blocked` with att_13's reason |
| 1 | same file, "the exact sequence: accepted beside two blocked, both cancelled, the next pass integrates" | after the cancel and the pass, still `blocked` |
| 1 | same file, "with nothing accepted, cleared work goes back to executing and launches what is ready" | no launch, still `blocked` |
| 1 | same file, "a block the scheduler records names its task, and clears when that task is cancelled" | no `blockedTask` |
| 4 | same file, "the reason never names a task that is no longer blocked: it moves to one that is" | the reason stayed att_13's |
| 3 | `packages/meta/test/admission.test.ts` "cancel_task answers with the task's status after the cancel, not before" | `state: "blocked"`, no `was` |
| 1 | `apps/desktop/test/delivery.test.ts` "blocked work whose blocked tasks were cancelled integrates its accepted task and asks to push the new head" | `expected { … } to match object { state: 'integrating' }` after the cancel and the settle |

These guards passed before the fix and still pass after it: "once it is integrated, a sibling still blocked blocks the work with its own reason", "an accepted task that depends on a blocked one still waits, and the work blocks", and "a block no task caused stays, even with no task blocked" (`policy_changed`, `integration: …`, `bootstrap_failed: …`). "a later block no task caused does not inherit the task an earlier block named" was added with the fix, for the `blockWork` strip. The mutant below proves it sees the strip.

The desktop test runs real git against a local bare repository, a fake `gh`, `schedulePass` and `Delivery`. It goes from 0.3.7's on-disk state (the work blocked, the reason recorded only by a `task_blocked` event, the push for the first head denied) to `integrating`. The accepted task is then integrated, the combined checks pass on the new head, and the push cards are `[denied, old head]` and `[pending, new head]`. Nothing is pushed.

## Mutants

`python3 tools/mutants/run.py tools/mutants/stale-block.json`: 12 of 12 killed. `--self-check`: the no-op SURVIVED and the syntax error was INVALID, as expected.

## Suites

- `pnpm typecheck`: exit 0.
- `pnpm lint` (`biome check .`): exit 0, no errors.
- `pnpm test` (both projects, in parallel): 3769 passed, 36 failed, 14 skipped. The 36 failures are in 12 files: `approval-key`, `attempt-launch`, `composition`, `coordination`, `delivery-flow`, `engine-registry`, `login-cards` and `recovery` in desktop, and `attempt-runner`, `codex-client`, `live-park` and `supervisor` in runtime. All are timeouts of 25 to 120 s, in tests that spawn processes, on a machine that was also running another vitest. Each file was then run again on its own with `--no-file-parallelism`:
  - `coordination`, `delivery-flow`, `recovery`, `attempt-launch`: 137 passed.
  - `composition`, `approval-key`, `engine-registry`, `login-cards` and the four runtime files: 217 passed.
- `packages/meta/test/scheduler.test.ts` 78 passed, `admission.test.ts` 24, `apps/desktop/test/delivery.test.ts` 84.

## Unverified

- The installed work item was not upgraded or run. What it does next (CHANGE.md, "The live work after the upgrade") comes from its stored docs and events, read against this code. It has not been observed.
- The combined checks on the live merge, and so whether a push card or a repair comes next, depend on the sandbox repository's own checks.
