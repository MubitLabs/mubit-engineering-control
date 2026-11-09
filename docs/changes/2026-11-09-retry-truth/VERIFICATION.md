# Verification

Branch `fix/retry-truth`, base a2c2d7b. The builder ran these checks on 9 November 2026. No real engine was used. Nothing touched `~/.mec` or the server on port 61610. Nothing was pushed. `pnpm check` was not run, as the brief asked.

## Failing first

| Item | Test | Red |
| --- | --- | --- |
| 1 | `apps/web/test/next.screens.playwright.ts` "A arms the focused approval and never confirms it" (unchanged, already failing on 0250aa4) | `Expected "open"`, `Received "resolved"` after the second A. That second A had pressed the one-step Deny. |
| 1 | `apps/web/test/decision-card.test.ts` "only Approve carries the marker the A shortcut presses …" (new) | Red with `Decision.tsx` stashed: no `data-approve` on Approve |
| 2 | `apps/desktop/test/delivery.test.ts` "a retry is not offered once the repository commands changed …" (new) | `expected { kind: 'integration', … } to be undefined` |
| 2 | `delivery.test.ts` "Try again is not offered once the repository commands changed …" (new) | `expected { kind: 'repair', … } to be undefined` |
| 2 | `apps/desktop/test/delivery-surfaces.test.ts` "commands changed since admission: no retry on offer, and the row says why …" (new) | `expected { kind: 'integration', … } to be null` |

No existing test was changed.

## Mutants

`python3 tools/mutants/run.py tools/mutants/retry-truth.json`: 6 of 6 killed.

The runner only drives vitest, so the keyboard selector has no mutant in the spec. I ran that mutant by hand. Putting back `button[data-armed="false"]` without the armed check makes "A arms the focused approval and never confirms it" fail (`Received: "resolved"`). The file was then restored.

## Suites

- `vitest run apps/desktop/test/{delivery,delivery-surfaces,inspection,inspection-trace,attempt-launch}.test.ts packages/meta`: 718 passed and 2 failed. The 2 failures were `attempt-launch` 45 s timeouts while the suites ran side by side on a loaded machine. Run alone, `attempt-launch` passed 60 of 60.
- `vitest run apps/web/test packages/meta`: 1033 passed, 1 skipped.
- `tsc --noEmit` for `packages/meta`, `apps/desktop` and `apps/web`: clean.
- `pnpm exec biome check .`: 0 errors. There are 138 warnings against 136 at base. The 2 new ones are `(entry: any)` in the new surfaces test, the same idiom that file already uses.
- `pnpm test:screens` (under `/tmp/mec-screens.lock`): 1037 passed, 0 failed.

## Unverified

- Nothing was checked on the installed app.
- The release-card case of item 1 (a second A arming Deny) is covered by the fix but has no screens test of its own. The harness's first card has a one-step Deny.
