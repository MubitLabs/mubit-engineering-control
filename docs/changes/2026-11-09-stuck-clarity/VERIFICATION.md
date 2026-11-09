# Verification

Branch `fix/integration-retry`, base 0250aa4 (v0.3.2). The builder ran these checks on 9 November 2026. No real engine was used. Nothing touched `~/.mec` or the running server, and nothing was pushed. `pnpm check` was not run, as the brief asked.

## Failing first

| Item | Test | Red |
| --- | --- | --- |
| 1 | `apps/desktop/test/delivery-surfaces.test.ts` "a retry on offer is the Next line, in the row and in Needs you" | `Expected "Retry integration"`, `Received "Resolve what blocks it"`. The detail already served `retry: {kind: 'integration'}` |
| 1 | `apps/web/test/work-model.test.ts` "a retry on offer leads the detail …" | `view.lead` undefined |
| 2 | `apps/web/test/inspection-feed.test.ts` "a keyed command an unlinked browser sent …", "an answer an unlinked browser sent …", "a known refusal reads in words" (2) | `"The workbench refused this: approval_required."`, and no `link` |
| 2 | `apps/web/test/config-contract.test.ts` "an agreement an unlinked browser sent …" | `expected 'approval_required' to contain 'This browser is not linked yet'` |
| 3 | `delivery-surfaces.test.ts` "changed repository commands say so in words …" and "a coded reason reads in words" (7) | `Received "Blocked: repo_profile_changed: this work was admitted under other commands"` (and the same for each code) |
| 4 | `apps/web/test/submission.test.ts` "a send a reload interrupted that the server stored is done …", "a send still in flight is not settled by the thread" | `landed is not a function` |
| 5 | `work-model.test.ts` "a card answered while inspected follows to its settled state …" | `expected 'approval:card_pending' not to be 'approval:card_pending'` |

These screens tests were added with the fix and were not first seen red: `delivery.screens.playwright.ts` "a retry on offer leads the detail …" (6 cells), and in `work-live.screens.playwright.ts` "a retry an unlinked tab sent …", "a request sent yesterday …" and "a card answered while its Diff is open …". The last one failed on its first run against the fix. The Shell kept the tab the Inspect had asked for (`initialTab`) across the id change. `Shell.tsx` now ties that tab to the subject it was asked for.

I changed two existing assertions on purpose, both in `delivery-surfaces.test.ts` and both because of finding 3. They expected raw codes as the delivery failure: `bootstrap_failed: …` now reads "The repository’s setup command failed: …", and `remote_unreadable: origin. …` now reads "The repository’s remote could not be read: origin. …". Each assertion is still an exact match.

## Mutants

`python3 tools/mutants/run.py tools/mutants/stuck-clarity.json`: 17 of 17 killed. The `Shell.tsx` tab reset has no mutant, because the runner only drives vitest. The screens test above covers it.

## Suites

- `npx vitest run apps/web/test`: 32 files, 601 passed.
- Desktop: `delivery-surfaces`, `inspection`, `inspection-trace`, `delivery`, `meta-visibility`, `events-bounded`, `delivery-flow` and `host-run-agreement` all passed. `attempt-launch` (60) and `approval-key` (19) passed run alone. Run beside other suites on this loaded machine, they failed with "condition never held" and a 60 s timeout. Their paths do not touch this change.
- `tsc --noEmit` for `apps/web` and `apps/desktop`: clean.
- `pnpm exec biome check .`: 0 errors (136 warnings and 2 infos, none from this change's files beyond what was there before).
- `pnpm test:screens`: 1036 passed, 1 failed. The failure is `next.screens.playwright.ts` "A arms the focused approval and never confirms it". It is **pre-existing**: it fails the same way on a clean origin/main 0250aa4 worktree (`Expected "open"`, `Received "resolved"`). It was not changed here.

## Unverified

- Finding 4's cause is inferred from the code: the tab closed or reloaded while the chat POST was held open by the planner turn. I did not read the owner's store or browser storage.
- Nothing was checked on the installed app. Every check above ran against fixtures or a real server over an in-memory store.
