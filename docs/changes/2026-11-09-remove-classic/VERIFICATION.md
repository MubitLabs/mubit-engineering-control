# Verification: the classic shell is gone, and the card shortcuts

Run by the builder on 9 November 2026, on `chore/remove-classic-032` from `origin/main` at `7a7dd82`, on a loaded machine. No review and no separate verifier. No engine run, no package built, no real server started. Only the runs below happened. The 6 November record of the held branch follows at the end, unchanged.

## Failing first

The new tests, run against `origin/main`'s `apps/web/src` (checked out into this tree for the run, then restored):

| Test | Before | After |
| --- | --- | --- |
| `test/next-only.test.ts` | 5 failed: 67 imports of deleted modules, 9 deleted modules on disk, `src/ui-flag.ts` reads `mec-ui-shell`, the bundle carries `classic-entry-*.css` with `@font-face` Instrument Sans | passes |
| `test/next-keyboard.test.ts`, the J, A and G then W block | 2 failed: `expected null to be 'next-card'`, `expected null to be 'go-work'` | passes |
| `test/bootstrap.test.ts` (new here), against the held branch's `main.tsx` (`c22ffde`), which dropped main's `startApproval()` | 1 failed: `expected [ 'mount' ] to deeply equal [ 'approval', 'mount' ]` | 2 passed on the resolved `main.tsx` |

## Unit tests, types, lint

| Command | Result |
| --- | --- |
| `pnpm exec vitest run apps/web` | 31 files, 582 tests passed |
| `pnpm exec vitest run apps/web apps/desktop` (in parallel) | 33 failed, all in `apps/desktop`, all timeouts or "never held" waits on spawned servers |
| the 12 failing desktop files again, `--no-file-parallelism` | 7 failed, in `approval-key.test.ts` and `host-run-agreement.test.ts` |
| those 2 files alone, this branch | 39 of 39 passed |
| those 2 files alone, a clean `origin/main` worktree | 39 of 39 passed |
| `pnpm exec tsc --noEmit -p apps/web`, `-p apps/desktop` | both pass |
| `pnpm exec biome check apps/web/src apps/web/test apps/web/playwright.config.ts` and the three mutant specs | 0 errors, 18 warnings, 1 info, all in files this branch does not touch except `next.screens.playwright.ts:281` (`useDomNodeTextContent`) |

This branch changes nothing under `apps/desktop` or `packages` (`git diff origin/main --stat` is empty there). The desktop failures follow load and pass alone on both trees. That they are flakes in general is not proven.

## Screens

`pnpm test:screens` in `apps/web` under `/tmp/mec-screens.lock`, port 4173 free when the lock was taken: 1023 passed, 0 failed, in 1.5 minutes. No `--update-snapshots`. Main's six `live-*` baselines held without the "Return to the classic workbench" link, inside the suite's tolerance, so they were not redrawn.

## Mutants

| Spec | Result |
| --- | --- |
| `tools/mutants/remove-classic.json` (new: no approval read, a mount before the code is redeemed, a blank page on a failed load) | 3 of 3 killed |
| `tools/mutants/next-shortcuts.json` | 6 of 6 killed |
| `tools/mutants/m3.4-release.json` | 13 of 13 killed |

The hand mutant on `ViewBoundary.componentDidUpdate` from 6 November was not repeated. The full screens run above passes `a view that throws while drawing is contained to its pane` unmutated.

## Not proven

- `pnpm check` and CI. Not run here; CI is the gate.
- The installed product, and decision #48's gate (a real pull request and merge on the installed build).
- The desktop suite in one parallel run on this machine.

## 6 November 2026, on the held branch

Run by the builder's follow-up on 6 November 2026, on top of `b2c10b4`. No separate verifier and no review (coordinator's note). No engine run. Only the checks below were run, and this file records only those runs.

### Static checks and unit tests

| Command | Result |
| --- | --- |
| `pnpm --dir apps/web typecheck` | passes |
| `pnpm exec biome check apps/web tools/mutants` | 0 errors, 13 warnings, 104 files |
| `pnpm exec vitest run apps/web` | 24 files, 389 tests passed |

Biome first reported 2 errors, both formatting: `test/work-live.screens.playwright.ts` and `tools/mutants/m3.4-release.json`. Both are fixed here, layout only. The 2 reformatted statements in `work-live` belong to `§23 worked example` and `an open card whose evidence did not load…`, and both pass after it (see below).

The 13 warnings stay: 1 unused `useMemo` import in `live/config.tsx`, 11 in `next/base.css` and `next/shell.css`, 1 in `next.screens`. The `useMemo` import has no other use on the base either. The other warnings were not compared with the base.

### Mutants

`python3 tools/mutants/run.py tools/mutants/m3.4-release.json`: 12 of 12 killed, before and after the format fix.

`a deleted module still imported` and `a deleted module imported dynamically` were already in the spec at `b2c10b4`. Nothing needed adding, and both are killed. For the first, by hand, the failing test is `no src file imports a deleted module`, naming `src/live/entry.tsx imports ../ui-flag`. The failed build also stops `the production build` block, so its 2 tests skip. The run still counts as a kill because a test failed.

`--self-check` exited 1 on this spec: its no-op case gave SURVIVED as expected, but its syntax-error case gave KILLED, not INVALID. The check uses the spec's first mutant, in `scripts/lighthouse.mjs`, and `a11y-gate.test.ts` spawns that script as a child, so a syntax error fails a test rather than a suite. Neither file changed on this branch. This says nothing about the kills above, but the runner's INVALID verdict is not proven on this spec.

### Hand mutant: the route-change clear

`ViewBoundary.componentDidUpdate` with its one line removed, run with Playwright under `/tmp/mec-screens.lock`, with port 4173 free when the lock was taken, so the server was this tree's.

| Run | Result |
| --- | --- |
| Control: `a view that throws…`, `§23 worked example`, `an open card whose evidence did not load…` | 3 passed |
| Mutant: `a view that throws while drawing is contained to its pane` | 1 failed |

The failure is at `next.screens.playwright.ts:964`, the check that `Needs you` shows after leaving the route. The failure stayed on screen. The mutant was reverted and the tree is clean. This is by hand because `tools/mutants/run.py` only runs vitest.

### Not proven

- **The full screens suite on this branch.** Only the 3 tests above ran here, so the redrawn `live-*` baselines and the ported tests in `CHANGE.md` were not rerun.
- **`pnpm check`.** Not run: the landing runs it once.
- **Failing-first for the ported tests.** `CHANGE.md` says they were seen against the next shell before the deletion. No output from that survives, so this file can't confirm it.
- **The installed product.** No package was built and no real server was started. This branch stays unmerged until 0.3.0 is verified installed.
