# Verification: M3.1 Stage 2 trace access and freshness

Base: local `feat/m2.3-delivery` at `53b6992` (unlanded, coordinator waiver). All runs are local, in the builder's worktree. No real engine, `~/.mec` or live server was used. The coordinator waived the separate verifier, so the handoff's verifier steps were not run as such. The blockers-only review the handoff requires for Stage 2 has not run.

## Failing first

The four new test files were written first and run once: 80 of 94 tests failed, 13 passed and 1 was skipped. The failures were missing routes, fields and exports. `packages/meta/test/context-stage.test.ts` was written before the projector was wired, but it was not run red on its own.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.1-live.json`, 54 mutants: the first run killed 46, 7 survived and 1 was invalid.

| Mutant | First run | Fix | Now |
| --- | --- | --- | --- |
| let .. through | survived | test pins 400, even for a ref that stays inside | killed |
| serve the control directories | invalid | none; it killed on rerun, and the first run's cause is unknown | killed |
| cut a page inside a character | survived | test's file put no character across the cut | killed |
| serve a binary file as text | survived | test now has a NUL in valid UTF-8 | killed |
| no page limit on artifacts | survived | it changed nothing a client sees, so it now removes the page bound itself | killed |
| activity pages without the byte cap | survived | test uses a detail that doubles when encoded again | killed |
| ignore the socket pushing back | survived | test reads `bytesWritten`, and a resumed client gets the whole backlog | killed |
| no next pass after a capped flush | survived | test's backlog now outruns the poll alone | killed |

Those eight were rerun on their own: 8 of 8 killed. A later fix added `a failed tick takes the server down`; it and `restore the identical-text skip` were rerun: 2 of 2 killed. The spec now holds 55 mutants. The other 45 were not rerun after the last two commits, which changed only the health tick and one test file's timeouts.

`tools/mutants/m3.1-queries.json`: 51 of 51 killed on the final code, with one `find` updated to follow the code.

## Gate

`pnpm typecheck` and `biome check .` pass.

`pnpm check` did **not** pass as a whole on this machine. Three parallel `vitest run` passes had 11, 8 and 9 failures, with load averages of about 7 to 20 from other work.

- **Run 2 found a real bug of mine.** The health timer now writes every tick, and a test that removed its data dir got an uncaught `ENOENT`, which took vitest workers down. The tick is now guarded, with a test and a mutant. Those 10 errors did not come back.
- **Run 3's failures were timeouts and "condition never held" on real-process tests.** The set changed from run to run and included `packages/git/test/exec.test.ts`, which this change doesn't touch.
- **`--no-file-parallelism` over the 12 files that matched those failures: 12 passed, 229 tests,** at a load average of about 11. `login-cards.test.ts` was left out because it is the known baseline failure (`posix_spawnp failed`).

No full parallel run was green after the fix, and the same load was not measured on the base, so "load, not this change" is inferred from the above. Run the gate again on a quiet machine or in CI before landing.

`pnpm test:screens` was not run: no web file changed.

## Checked against `origin/main`

The decoders in `apps/web/src/inspection-decode.ts` pick fields by name, so `usage.coverage` and `outcome` are safe. `api.ts` sends `x-mec-client: 1` on `request`. `live/events.ts` listens for `reset`. These were read, not run: this base doesn't hold #38.

## Artifact secrets: three blockers

Tests were written first. 7 of the new artifact tests failed on the old code, for the case-sensitive control directories, a cursor inside a key, and a token or slot key with no pattern.

- `--no-file-parallelism` over `apps/desktop` and `packages/slots`: 724 passed, 6 skipped, 1 failed. The failure is `login-cards.test.ts`, the known baseline (`posix_spawnp failed`).
- `pnpm -r --parallel typecheck` and `biome check` on both packages report no errors.
- Ten mutants were killed by a named test: no lowercase compare, no start cut, no end cut, no read behind the cursor, no exacts on the page, no fingerprints on the page, the wrong attempt's exacts, no composition wiring, no exact spans, no last-four spans.
- `next` relative to the window hung the paging test's loop, which never ends. It was stopped by hand, so it has no clean result.
- `realpathSync.native` for the path, swapped for the JavaScript one, survives: the lowercase compare covers it on this volume. It stays for any folding `toLowerCase` does not match, and that is not proven by a test.
- No engine ran. The launch test uses the fake CLI.
