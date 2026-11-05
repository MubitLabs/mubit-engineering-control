# VF0 verification

5 November 2026, darwin, base `a102313`. Everything here was run by the builder in an isolated worktree. No server ran against `~/.mec`, no real engine ran, and nothing was pushed.

## Baseline

| Command | Result |
| --- | --- |
| `pnpm exec playwright test` in `apps/web`, before any change | 21 passed |
| `pnpm check` at `a102313` | One known failure, as recorded for this wave: `apps/desktop/test/login-cards.test.ts`, `drives a real interactive shell through the seam` |

## Failing first

| Test | Red | Green |
| --- | --- | --- |
| `apps/web/test/ui-flag.test.ts` | Module missing | 10 passed |
| `apps/web/test/next-keyboard.test.ts`, `next-boundary.test.ts` | Modules and files missing | Passed |
| `apps/web/test/next.screens.playwright.ts`, flag and honesty groups, before `main.tsx` was wired | 9 failed: `?ui=next` still rendered classic | Passed |
| `apps/web/test/shell-split.test.ts`, against a conditional of imports | `expected [...classic files...] to contain 'entry-*.css'` | 3 passed |

The screen suite also found two real bugs on its first full run. Closing the palette from the scrim passed the click event as a callback and crashed the tree. `.sr-only` text outside a positioned ancestor extended the page to 1003px on Needs you.

## After the change

| Command | Result |
| --- | --- |
| `pnpm exec vitest run --project a apps/web/test` | 5 files, 48 tests passed |
| `pnpm exec playwright test` in `apps/web` | 121 passed: 100 next, 21 classic. Classic ran without `--update-snapshots` and its 16 baselines are untouched |
| `pnpm check` | Only the baseline failure above |
| `pnpm --dir apps/web build`, then `vite preview` driven by a one-off chromium script | Classic loads only `classic-entry-*.css`. Next loads only `entry-*.css`, with the system font. Blocking the entry chunk shows the reload message. No `Sample console` or `sample search` text in `dist/assets` |

Screenshots for the next shell: six scenes at 1440, 1024 and 390 in light and dark, plus the drawer in both themes, 38 files, all synthetic. Reviewed by eye against the prototype screenshots.

## Mutants

Applied by hand, because `tools/mutants/run.py` is not on this base. Each mutant was reverted after its gate ran.

| Mutant | Gate | Result |
| --- | --- | --- |
| Default flips to next | `ui-flag.test.ts` | Killed |
| Throwing store gives next | `ui-flag.test.ts` | Killed |
| Next imports a mock | `next-boundary.test.ts` | Killed |
| Next imports `api.ts` | `next-boundary.test.ts` | Killed |
| Next calls fetch | `next-boundary.test.ts` | Killed |
| Fixture sentence in `src/next` | `next-boundary.test.ts` | Killed |
| Secondary token regresses | `next-boundary.test.ts` | Killed |
| Control line back to hairline | `next-boundary.test.ts` | Killed |
| Auto dark drifts from dark | `next-boundary.test.ts` | Killed |
| Text under 12px | `next-boundary.test.ts` | Killed |
| Slash escapes a modal | `next-keyboard.test.ts` | Killed |
| Enter ignores IME | `next-keyboard.test.ts` | Killed |
| Conditional of imports | `shell-split.test.ts` | Killed |
| Scrim-less modal | next screens | Killed |
| Scrim that does not close | next screens | Killed |
| Page stays live under a modal | next screens | Killed |
| No Tab trap | next screens | Killed |
| No focus return | next screens | Killed |
| Focus may rest on body | next screens | Killed |
| Unbounded shell rows | next screens | Killed |
| No disarm on the timer | next screens | Killed |
| No armed announcement | next screens | Killed |
| Settled decision keeps amber | next screens | Killed |
| Script boundary drifts from 1150 | next screens | Killed |
| No `aria-current` | next screens | Killed |

## Not verified

- Axe and Lighthouse: not installed, so no score is claimed. Semantics are checked by role queries and the sweeps in the screen suite.
- Linux or Windows rendering: screenshots are darwin only, and `pnpm test:screens` is outside CI.
- The real server and packaged tarball: the build was served by `vite preview`, not `apps/desktop/src/server.ts`.
- A real IME: composition is simulated with a dispatched `isComposing` event.
- Screen readers: no assistive technology was run.
- Live truthfulness: nothing is wired, so the components are proven only against synthetic props.
