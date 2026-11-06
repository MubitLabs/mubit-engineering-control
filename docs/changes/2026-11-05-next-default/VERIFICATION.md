# Verification: the new shell is the default

Run by the builder on 6 November 2026, base `7ec7476`. No separate verifier (coordinator's note). No engine run.

## Failing first

`npx vitest run test/ui-flag.test.ts` before the change: 6 failed, 5 passed. After: 11 passed.

The axe matrix before any fix: 70 tests failed on violations and 6 on a wrong `ready` selector in the test. Rules: `label-content-name-mismatch`, `heading-order`, and `color-contrast` in dark only.

The `color-contrast` failures were not a palette defect: they were sporadic, and axe was reading mid-transition. The gate now waits for animations to finish, and after that wait no contrast failure remained.

## Screens

`pnpm --dir apps/web test:screens` under the lock, darwin: 413 passed, 1 failed, of 414. All baselines held, classic's included, and every axe test passed.

The one failure was `the reset notice does not outlast a failure it would contradict` (`work-live.screens.playwright.ts:693`). Alone it passed 8 of 8 with `--repeat-each=8`. It uses `?ui=next`, so the flip does not reach it. It reads as a timing flake under load: it sets its flag and waits for the next stream reconnect. Not fixed here. Cause not proven.

## Lighthouse

`scripts/lighthouse.mjs` on the harness over Vite, system theme (light): 100 on all six surfaces.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.4-release.json`: 9 of 9 killed. The five flag mutants: `default stays classic`, `stored classic ignored`, `a throwing read falls to classic`, `a classic that cannot be kept half-applies`, `an unknown param overrides a stored classic`.

By hand, each failing for the expected reason:

| Mutant | Caught by |
| --- | --- |
| Open Setup back to `?ui=classic#setup` | `the empty state opens Setup here` |
| secondary text below contrast | axe `color-contrast` |
| the drawer close button loses its name | axe `button-name` |
| notice heading back to `h3` | axe `heading-order` |
| surface-present check removed | `an absent surface fails rather than passes` |

Not run by hand: `remove focus return` and `disarm timer removed`. Their code is untouched here.

## Not proven

- Lighthouse on the real packaged server, and axe on it. The scratch server needs a scratch `HOME`, which this session's worktree guard refused. Nothing was run with the real `HOME`.
- Lighthouse in dark. The script has no theme option and `--force-dark-mode` did not reach the page. Dark is covered by axe, on the harness.
- Assistive technology beyond axe, Lighthouse and keyboard: not claimed.
- The Lighthouse and axe gates are not in `pnpm check` or CI.

## `pnpm check`: not green

Typecheck and lint pass. Tests: 2535 passed, 8 failed, 15 skipped, on a machine shared with parallel builders.

- All 8 are in `apps/desktop` and `packages/runtime`: `attempt-launch`, `bundle`, `login-cards`, `attempt-runner`, `shims`. None is in `apps/web`.
- `login-cards` "drives a real interactive shell" is the known baseline failure.
- The other 7 are not baseline, and not explained. A rerun of the five files alone also failed 8, but a different mix of tests, with `condition never held` timeouts and a missing pid file.
- This change touches none of those packages, and none of those test files names `apps/web`.
- A comparison run on the base did not finish in 500 s and was stopped, so there is no base result. Treat these as unresolved until `pnpm check` runs on a quiet machine.
