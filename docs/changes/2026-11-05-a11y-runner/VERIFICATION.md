# Verification: Stage A runner

All observed on the builder's machine (darwin, Playwright chromium). No independent verifier has run yet.

## Failing first

- `pnpm --dir apps/web exec vitest run test/a11y-gate.test.ts` before `scripts/lighthouse.mjs` existed: 2 failed, 4 passed. The two that fail are the ones expecting exit zero; the four "non-zero" tests pass vacuously while the script is absent. Their strength comes from the mutants below.
- After the script: 6 passed.
- The Playwright tests were written together with their fixture and helper, so they were not seen red before the implementation. Their guards were proven by the hand mutant below.

## Playwright (`pnpm --dir apps/web exec playwright test a11y.screens`, under the screens lock)

4 passed: axe reports violations on the broken page (`color-contrast`, `label`, `button-name`); an absent surface fails; an empty page fails; the lighthouse script exits non-zero on the broken page.

## Lighthouse, driven by Playwright's chromium

- Broken page: accessibility 46, FAIL, exit 1.
- Next harness (`next-harness.html?state=working`, served by vite on a scratch port) routes `#chat`, `#work`, `#needs-you`: 100, 100, 100, exit 0. Whether the harness renders a distinct surface for `#work` and `#needs-you` was not checked.

## Failures found for Stage B (not fixed here)

- axe on the harness conversation (`?state=working#chat`, `.shell`): 1 violation, `label-content-name-mismatch` (serious) on `.repo-switch`. A harness axe test was written, failed for that reason, and was left out of the suite rather than committed red. Only the `working` state at one width and theme was run.

## Mutants (`python3 tools/mutants/run.py tools/mutants/m3.4-release.json`): 4 of 4 killed

- lighthouse threshold ignored: KILLED
- unreadable report counts as a pass: KILLED
- missing score counts as a pass: KILLED
- one passing route hides a failing one: KILLED

`--self-check`: the no-op reported SURVIVED as expected; the syntax-error mutant reported KILLED, not INVALID, because the script runs in a child process, so the suite still loads and the exit-zero tests fail.

By hand: `remove the surface-present check` (`if (count === 0)` made `if (false)`): `an absent surface fails rather than passes` and `an empty page fails rather than passes` failed, so killed. Restored afterwards.

Not run (belong to later stages or need the other handoffs): sheet close-button name, secondary text contrast, focus return, disarm timer.

## Not claimed

Assistive technology beyond axe and Lighthouse; Lighthouse on the packaged server; the six-surface matrix.

## pnpm check

Typecheck and lint pass. Tests: 1 failed, 1761 passed, 16 skipped; the one failure is the known baseline login-cards node-pty test (posix_spawnp failed).
