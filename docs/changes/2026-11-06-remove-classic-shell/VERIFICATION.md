# Verification: the classic shell is gone

Run by the builder's follow-up on 6 November 2026, on top of `b2c10b4`. No separate verifier and no review (coordinator's note). No engine run. Only the checks below were run, and this file records only those runs.

## Static checks and unit tests

| Command | Result |
| --- | --- |
| `pnpm --dir apps/web typecheck` | passes |
| `pnpm exec biome check apps/web tools/mutants` | 0 errors, 13 warnings, 104 files |
| `pnpm exec vitest run apps/web` | 24 files, 389 tests passed |

Biome first reported 2 errors, both formatting: `test/work-live.screens.playwright.ts` and `tools/mutants/m3.4-release.json`. Both are fixed here, layout only. The 2 reformatted statements in `work-live` belong to `§23 worked example` and `an open card whose evidence did not load…`, and both pass after it (see below).

The 13 warnings stay: 1 unused `useMemo` import in `live/config.tsx`, 11 in `next/base.css` and `next/shell.css`, 1 in `next.screens`. The `useMemo` import has no other use on the base either. The other warnings were not compared with the base.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.4-release.json`: 12 of 12 killed, before and after the format fix.

`a deleted module still imported` and `a deleted module imported dynamically` were already in the spec at `b2c10b4`. Nothing needed adding, and both are killed. For the first, by hand, the failing test is `no src file imports a deleted module`, naming `src/live/entry.tsx imports ../ui-flag`. The failed build also stops `the production build` block, so its 2 tests skip. The run still counts as a kill because a test failed.

`--self-check` exited 1 on this spec: its no-op case gave SURVIVED as expected, but its syntax-error case gave KILLED, not INVALID. The check uses the spec's first mutant, in `scripts/lighthouse.mjs`, and `a11y-gate.test.ts` spawns that script as a child, so a syntax error fails a test rather than a suite. Neither file changed on this branch. This says nothing about the kills above, but the runner's INVALID verdict is not proven on this spec.

## Hand mutant: the route-change clear

`ViewBoundary.componentDidUpdate` with its one line removed, run with Playwright under `/tmp/mec-screens.lock`, with port 4173 free when the lock was taken, so the server was this tree's.

| Run | Result |
| --- | --- |
| Control: `a view that throws…`, `§23 worked example`, `an open card whose evidence did not load…` | 3 passed |
| Mutant: `a view that throws while drawing is contained to its pane` | 1 failed |

The failure is at `next.screens.playwright.ts:964`, the check that `Needs you` shows after leaving the route. The failure stayed on screen. The mutant was reverted and the tree is clean. This is by hand because `tools/mutants/run.py` only runs vitest.

## Not proven

- **The full screens suite on this branch.** Only the 3 tests above ran here, so the redrawn `live-*` baselines and the ported tests in `CHANGE.md` were not rerun.
- **`pnpm check`.** Not run: the landing runs it once.
- **Failing-first for the ported tests.** `CHANGE.md` says they were seen against the next shell before the deletion. No output from that survives, so this file can't confirm it.
- **The installed product.** No package was built and no real server was started. This branch stays unmerged until 0.3.0 is verified installed.
