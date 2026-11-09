# Verification

Branch `fix/approval-cards` on base 7a7dd82. Run by the builder on 9 November 2026. No real engine, no `~/.mec`, no running server touched, no push. The full `pnpm check` was not run (shared, loaded machine; CI is the gate).

## Failing first

Each test was written before its fix and seen red for the intended reason, then green.

| Finding | Test | Red |
| --- | --- | --- |
| 1 | `apps/web/test/work.screens.playwright.ts` "arming never puts the other answer under the pointer" at 1440, 1024, 390 | the armed Approve box was `width: 230.42`, not the resting `77.73`; Deny moved |
| 1 | same file, "one click on Deny arms it and settles nothing; the second denies" | no `Confirm: deny in sample-console` button: one click had already denied |
| 1 | `apps/web/test/decision-card.test.ts` "a release card asks for a second click on Deny too", "both buttons hold their armed label from the start" | `denyConfirmLabel` undefined; the Approve markup held only `Approve` |
| 2 | `apps/desktop/test/release-cards.test.ts` "a delivery card serves the checks and diff of its own commit" (3 of 4 red) | `checks: []`, `files: []`, summary `not served for this card` |
| 2 | `decision-card.test.ts` "the card face shows the short commit" | no `Commit` fact on the face |
| 3 | `decision-card.test.ts` "a multi-line fact keeps its lines" | the body's `<dd>` had no `fact-text` class |
| 4 | `apps/web/test/inspection-feed.test.ts` "a notice about a card lasts only while that card is open" (2 of 3 red) | the notice was still `{ kind: 'done', … }` after the card settled, both here and elsewhere |

Written with the fix, green from the start, as guards: "serves no checks from another commit", "a cancel with no confirm label keeps one label and one click", "a notice about something else stays when a card settles", "arming Deny disarms Approve, and Escape disarms Deny", and the CSS rule check for `white-space: pre-wrap`.

Assertions changed on purpose, each to the new two-step behaviour, none loosened:
- `work.screens.playwright.ts` "12 amber leaves a settled item" and `work-live.screens.playwright.ts` "deny says denied, not approved" now click Deny and then `Confirm: deny in sample-console`. The live one also asserts that nothing is posted after the first click, and that exactly one deny is posted after the second.
- `delivery-surfaces.test.ts` "opens the card and says nothing merged" now also expects `cardId: 'conf_1'` on the notice.
- `journey.real.playwright.ts` "declining keeps the local result" now clicks Deny and then `Confirm: deny in …`. This is the gated real journey: it was edited, not run.

## Mutants

`python3 tools/mutants/run.py tools/mutants/approval-cards.json`: **12 of 12 killed**. They cover: a check from another head served, `error` read as not run, the route serving no record, the diff read from the wrong base, Deny losing its confirm label, the face losing its commit, Approve going back to one label, a multi-line fact collapsing, the style losing `pre-wrap`, and three ways the card notice can go wrong.

By hand, in the browser (the runner is vitest only): Deny made one-click again (`if (false)` in `onDenyClick`). Three screens tests failed: "one click on Deny…", "12 amber…" and "deny says denied…". The file was restored with `git checkout`.

## Suites

- `pnpm exec vitest run apps/web/test` and the desktop release, delivery, inspection and login-card files: 898 of 901 passed in one parallel run. The 3 failures were timeouts: `a11y-gate.test.ts` (lighthouse, 60 s), and `delivery-flow.test.ts` (2 cases at 120 s "condition never held"). Run alone, both files passed on this branch (15 of 15), and on the base too.
- Desktop files that read card detail (`coordination`, `inspection`, `release-cards`, `slot-switch`): 223 of 223 passed.
- `pnpm test:screens` (under `/tmp/mec-screens.lock`): **1039 of 1039 passed**, screenshot baselines included. No baseline was updated.
- `pnpm exec tsc --noEmit` in `apps/web` and `apps/desktop`: clean.
- `biome check` on every touched file: no errors. `shell.css` has 11 warnings, the same as on the base.

## Not verified

- The installed app was not re-run against a real store. The walkthrough's exact misclick was not replayed by hand. The geometry test pins its mechanism: the armed button stays the same size, and Deny does not move.
- A real integration record's check list and a real delivery's `git_dir` were not read. The test uses a real git repository with a stored integration record in the shape `Delivery` writes (`combined: { sha, passed, checks: [{ name, status, logTail }] }`).
- The merge card's diff, when the PR head is missing from the local clone, was reasoned about (it reports that the changes could not be read) but not tested.
