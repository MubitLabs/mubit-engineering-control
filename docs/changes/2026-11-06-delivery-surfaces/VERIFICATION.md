# Verification: delivery surfaces

Builder's record, on a shared machine with load between 5 and 17. No real engine ran. `~/.mec` and port 61610 were not touched.

## Failing first

`npx vitest run` over the new and changed test files, before any source change: 7 files failed, 55 tests failed. Each failed for the behaviour being absent, for example `plannerTurnEnded is not a function`, `expected undefined to be 'passing'`, `expected [] to deeply equal [ ObjectContaining{…} ]`.

After the change, every test in those files passes.

## Tests

| Command | Outcome |
| --- | --- |
| `pnpm -r --parallel typecheck` | no errors |
| `npx biome check . --diagnostic-level=error` | no errors after formatting |
| `npx vitest run --project a` | 1693 passed, 1 skipped, before the last edits to tests and `protocol.md` |
| `npx vitest run packages/prompts packages/meta` | 369 passed, 1 skipped |
| Bundle, prompts-API and planner tests in `apps/desktop` | 60 passed, 2 skipped |
| `server`, `release`, `delivery` serially | 102 passed |
| `pause-attempts`, `delivery-flow` alone | 9 passed |
| `pnpm test:screens` subset, under the lock: `delivery`, `work`, `next` | 206 passed, existing baselines unchanged |
| `pnpm test:screens` subset, under the lock: `a11y`, `limits`, `keyboard`, `delivery` | 646 passed |

`delivery.screens.playwright.ts` runs 24 cells: 3 widths, 2 themes and 4 surfaces. Each cell checks that the content is present, nothing scrolls sideways and axe is clean on the shell.

## Not settled

`apps/desktop/test/recovery.test.ts` is intermittent here. Failures are `att_1 reaching work_complete never held` or a timeout.

| Tree | Result |
| --- | --- |
| This branch, inside a large parallel run | 5 of the file's tests shown failing, 11 failed across that run |
| This branch, alone | 3 failed |
| This branch, alone | 14 failed |
| `origin/main`, alone | 43 passed |
| This branch, alone | 43 passed |

`pause-attempts` and `delivery-flow` failed in the same parallel run and passed alone. Nothing here shows a cause in this change, and nothing rules one out: `origin/main` was run once. CI is the gate.

Full `pnpm check` did not run: load stayed at or above 8 when it could have started.

## Mutants

`python3 tools/mutants/run.py tools/mutants/delivery-surfaces.json`: 40 mutants, 40 killed, with the last one rerun after a test was added. `--self-check` reports SURVIVED for the no-op and INVALID for the syntax error, as it should.

The first run was 39 of 41:

- **`inspection: an integration record is not coverage` survived.** That was a real gap, and a new test kills it.
- **`diff: a stored diff is overwritten` survived and was removed as equivalent.** `taskDetail` prefers a stored diff anyway, so that guard only saves a `git` call and changes no answer.

## Not proven

- No real engine or real GitHub. Merge goes through a fake `gh`. The prompt change to `protocol.md` has not been seen with a real model, and an owner's edited copy under `~/.mec/prompts` keeps its old text.
- No browser run against a real server. Screens run on the harness, and the routes run in vitest against a real server.
- No separate verifier has run this.
