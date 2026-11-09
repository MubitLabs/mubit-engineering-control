# Verification

Branch `fix/ui-leftovers`, base 77bcdb4 (0.3.4). The builder ran these checks on 9 November 2026. No real engine or real sign-in was used: the login card ran on the fake pty seam, and the probe ran on the `probeCmd` seam. Nothing touched `~/.mec` or the running server, and nothing was pushed. `pnpm check` was not run, as the brief asked.

## Failing first

| Item | Test | Red |
| --- | --- | --- |
| 1 | `apps/desktop/test/login-cards.test.ts` "a Codex sign-in that exits turns its new connection Healthy with no Check again" | `expected [] to include 'codex login status'`: nothing probed when the card exited |
| 1 | `apps/web/test/config.screens.playwright.ts` "a sign-in that finishes reads Healthy with no Check again" | the `sample-new` row did not contain "Healthy" after the card's `exit`, because the page never read the connections again |
| 2 | `apps/web/test/work-live.screens.playwright.ts` "a send refused unlinked says linked and Retry once the tab is linked" | `Received "This browser is not linked, so the message was not sent. … then Retry.Retry"` after linking. The "cannot send yet" notice had already gone, which matches the report |

These tests were added with the fix and were not first seen red: `login-cards.test.ts` "a sign-in that is cancelled checks nothing" (the old code also passes it, so it guards against a regression) and "reports exit only once the after-exit check settles …" (it tests the new `afterExit` argument, and the mutants below cover it). No existing test was changed.

## Mutants

- `python3 tools/mutants/run.py tools/mutants/ui-leftovers.json`: 5 of 5 killed (no probe, the wrong home, `exit` before the check, a failed check never ending, the machine kept busy).
- The runner drives vitest only, so the two web mutants were run by hand with Playwright under the screens lock:
  - `failureText(submission, linked)` changed to `failureText(submission, false)`: the linked/Retry test failed (killed).
  - The `onChanged()` on `exit` removed: the Healthy test failed (killed).

## Suites

- `vitest run` of `apps/desktop/test/{login-cards,connections-route,wizard,api-slots}.test.ts` and `apps/web/test`: 37 files, 660 passed.
- `tsc --noEmit` for `apps/desktop` and `apps/web`: clean.
- `pnpm exec biome check .`: 0 errors.
- `pnpm test:screens` (apps/web, under `/tmp/mec-screens.lock`): 1041 passed, 0 failed.

## Unverified

- No real `codex login` was run, and nothing was checked on the installed app. The cause is read from the code: `POST /api/slots/login` passed a no-op listener, and only the card's own button probed.
- A sign-in the server answered `busy` (attached to a card already running) checks only that card's slot, not the second request's slot.
