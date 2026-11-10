# Verification

Branch `fix/planner-capabilities`, base ef1e309. The builder ran these checks on 10 November 2026. No real engine was used. `~/.mec/mec.db` was only read, with `sqlite3`, for the evidence in CHANGE.md. The installed server on port 61610 was not touched, and nothing was pushed.

## Failing first

The tests were written before the code and run against the base: 12 failed and 6 passed. The domain file failed to load because `../src/reach` did not exist yet, so its 15 tests count as red.

| Item | Test | Red |
| --- | --- | --- |
| 1 | `apps/desktop/test/engine-reach.test.ts`, four "engine reach" tests (OpenCode, Claude, Codex, sandbox off) | `reachOf` is not a function |
| 1 | same file, "each launchable slot carries its engine row's reach…" | `placement().reach` is undefined |
| 1 | `packages/domain/test/reach.test.ts` (words, `commandNeed` on the live objective and on edit-only text, `runsCommands`) | the module did not exist |
| 2 | `packages/meta/test/capabilities.test.ts` "an OpenCode slot reads as editing files with no commands…" | the slot line had no reach |
| 4 | same file, "pinned to a slot that cannot run them is refused with a plain reason" | `ok: true` |
| 4 | same file, "where no connection can run commands is refused…" | `ok: true` |
| 4 | same file, "whose tier is served only where commands cannot run is refused…" | `ok: true` |
| 5 | same file, "goes to a slot that can run them, though another is less used" | launched on `slot_glm`, the live placement |
| 5 | same file, "pinned to a slot that cannot run them waits…" | launched on `slot_glm` |
| 5 | same file, "where no slot can run them waits for one…" | launched on `slot_glm` |

These guards passed before the fix and still pass after it: a pin on a slot that can run commands is accepted, an unpinned task is accepted, an edit-only task pinned to the slot with no shell is accepted (with acceptance checks too), an edit-only task still takes the least used slot, a slot with no recorded reach is not ruled out, and a service with no reach supplier prints nothing about commands.

## Mutants

`python3 tools/mutants/run.py tools/mutants/planner-capabilities.json`: 23 mutants. The first run killed 22. "(1) command words match inside other words" survived, because every test case had a command word at the start of a longer word (`runtime`, `browserslist`, `nodes`), and the trailing boundary alone caught those. The test now also has `overrun`. Rerun alone, that mutant was KILLED, so 23 of 23 are killed. `--self-check`: the no-op SURVIVED and the syntax error was INVALID, as expected.

## Suites

- `pnpm typecheck`: every package Done, exit 0.
- `biome check .`: no errors.
- `vitest run packages/domain packages/meta packages/prompts`: 736 passed, 1 skipped.
- `pnpm test` (both projects, in parallel, on a loaded machine): 3341 passed, 86 failed, 10 skipped. All 86 failures are timeouts of 2 to 145 s in 13 files that spawn processes: `approval-key`, `attempt-launch`, `composition`, `coordination`, `delivery-flow`, `engine-registry`, `host-run-agreement`, `login-cards`, `pause-attempts` and `recovery` in desktop, `claude-input-eof` in engines, and `attempt-runner` and `supervisor` in runtime. Each was run again on its own with `--no-file-parallelism`:
  - `approval-key`, `composition`, `engine-registry`, `login-cards`, `pause-attempts`, `claude-input-eof`, `attempt-runner`, `supervisor`: 178 passed.
  - `attempt-launch`, `coordination`, `delivery-flow`, `host-run-agreement`, `recovery`: 154 passed. Three `attempt-launch` tests timed out again (45 to 145 s). Run alone by name, those three passed.

## Unverified

- No real planner turn ran with the new context line or protocol paragraph. Whether the live planner reads "cannot run commands" and plans accordingly has not been observed. The admission refusal and the placement narrowing are the parts that do not depend on that.
- The installed work item was not upgraded or run.
