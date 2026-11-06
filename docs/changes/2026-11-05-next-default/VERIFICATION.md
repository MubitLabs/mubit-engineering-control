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

## The checks after the flip

Run by the builder on 6 November 2026, on `feat/next-default-checks`. No separate verifier (coordinator's note). No engine run.

### The flaky screen test

`the reset notice does not outlast a failure it would contradict` was a test race, not a product defect. 10 of 40 failed at the first `toBeVisible` with `--repeat-each=40 --workers=8`. An instrumented copy showed why: the mock served its one reset to `es1`, and the page closed `es1` 2ms later while re-subscribing with the work streams (`net::ERR_ABORTED`). The reset was spent and every later connection was empty. The real server repeats a reset until the cursor moves, so the mock now does too. After: 60 of 60 under the same load. Removing `clearReset` from the failure path still fails it, at the same assertion.

One small window stays: the 10-second refresh could land between recovering and the click on Retry, which would take the button away. The streams are held open past the reset, so the 1-second reconnect refresh no longer does this. Not seen in 60 runs.

### The matrix

`limits.screens.playwright.ts` over `matrix-cells.ts`: 6 surfaces, 18 states, 4 sheets, plus the inspector sheet at 1024 and 390 and the drawer at 390, at 1440, 1024 and 390, light and dark. Each cell is checked for sizes, field edges, clipping and motion, then a Tab walk reads the ring at every stop. Reduced motion runs at 1440 and 390, light.

Failing first: 89 of 411 failed on the first run. Two groups were the gate's own errors and were corrected, not waived: the 12px byline is secondary text in the preview too, and the repository sheet at 390 sits on the drawer, so there are two dialogs. The rest are the fixes in `CHANGE.md`.

`limits-broken.html` proves each limit can fail: small text, short and narrow targets, a short primary, a faint edge, off-page, clipped control, clipped label, sideways scroll, no ring, thin ring, faint ring, clipped ring, slow transition, long animation, and a reduced-motion run that is not on.

How the numbers were read, where the record leaves room:

- Body 14px is checked on conversation message text. 13px text elsewhere matches the preview's own secondary sizes. 12px is the floor everywhere.
- Text contrast is axe's. This gate measures field edges and the focus ring at 3:1. Native radios and checkboxes are not measured, and buttons with a text label have no edge requirement.
- Width targets apply to buttons. Links inside running text are exempt.
- A textarea brings its caret into view on focus, not itself, so a tall one can start in view and run past the fold. Measured on Settings at 1440: 66px below the fold, top and caret visible. The ring check allows that.

### Axe, keyboard

Axe reads the same cells, so the sheets, working, resolved and expired are now covered. It found one more defect: the glossary list was a scrollable region with no keyboard route (`scrollable-region-focusable`), at 1024 and 390.

`keyboard.screens.playwright.ts`: 8 journeys at each of 3 widths, plus the drawer, by keys alone. Nothing clicks, fills or calls `focus()`. 9 of the 25 failed on the first run, and later ones failed as each earlier block was fixed and the journey got further.

### Against the preview

Viewed side by side, light: Work at 1440, Connections at 1024, Settings at 390. Dark: Work at phone width, from Lighthouse's own report. Typography, rhythm, rail, breadcrumb, rows and status dots match. Two differences, left as they are:

- Settings uses a section list where the preview has underlined tabs. M3.3 has five real sections and two columns at 390.
- Add connection is a primary button, where the preview's is a default one.

The screenshot baselines are the rest of the comparison, and all of them held. This is a sample, not every cell by eye.

### Screens, lint

`pnpm --dir apps/web test:screens` under the lock, darwin: 927 passed of 927, including the flaky test. No baseline changed. `biome check .`: no errors.

### Lighthouse

`scripts/lighthouse.mjs --theme light|dark` on the three harnesses over Vite: 100 on all six surfaces in both themes. `--force-dark-mode` never reached the page, so `--theme` stores the shell's own choice in a lasting profile. A page that does not take the theme fails the run, and so does an unknown theme. The screenshot inside a dark report shows Lighthouse's own tab was dark.

### Mutants

By hand, each one edit, the named tests, then restored. All killed:

| Mutant | Caught by |
| --- | --- |
| a redrawn heading not followed | `Setup`, `Connections` journeys |
| no focus return from a form | `Connections`, `Settings` journeys |
| focus not moved into a form | `Connections` journey |
| save bar with no focus return | `Settings` journey |
| a retired row's focus not moved | `Connections` journey |
| Send can shrink | limits, Conversation 390 |
| tab loses its minimum width | limits, inspector 1440 |
| palette edge on the hairline | limits, palette 1440 |
| status `nowrap` again | limits, Work 390 |
| no scroll padding | ring, Work 1024 |
| task ring outside the clip | ring, work delivery 1440 |
| search ring outside the clip | ring, search sheet 1440 |
| glossary not focusable | axe, glossary sheet 1024 |
| focus ring below 2px | ring, Work 1440 |
| motion over the limit | limits, Conversation 1440 |
| reduced-motion block removed | reduced motion, Conversation 1440 |
| `disarm timer removed` | `14: eight seconds disarm` |
| `remove focus return` | `Work` journey, drawer |

## Not proven

- Lighthouse and axe on the real packaged server. Tried again: the worktree guard refused a command that sets `HOME`. Exact text: "this command sets HOME, injecting git configuration whose effect on where git writes can't be verified. Refusing to run it". Stopped there. Nothing was run with the real `HOME`, and the guard was not worked around.
- The harness states on a real server. All of the above is the harness or `page.route`.
- Assistive technology beyond axe, Lighthouse and keyboard: not claimed.
- The Lighthouse and axe gates are not in `pnpm check` or CI.

## `pnpm check`: not green

Typecheck and lint pass. Tests: 2535 passed, 8 failed, 15 skipped, on a machine shared with parallel builders.

- All 8 are in `apps/desktop` and `packages/runtime`: `attempt-launch`, `bundle`, `login-cards`, `attempt-runner`, `shims`. None is in `apps/web`.
- `login-cards` "drives a real interactive shell" is the known baseline failure.
- The other 7 are not baseline, and not explained. A rerun of the five files alone also failed 8, but a different mix of tests, with `condition never held` timeouts and a missing pid file.
- This change touches none of those packages, and none of those test files names `apps/web`.
- A comparison run on the base did not finish in 500 s and was stopped, so there is no base result. Treat these as unresolved until `pnpm check` runs on a quiet machine.
