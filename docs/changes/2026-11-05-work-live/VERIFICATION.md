# M3.2 Stage B verification

5 November 2026, darwin, base `5be0ef8` (`feat/durable-commands`). Run by the builder in an isolated worktree. Nothing was pushed, no real engine ran, and `~/.mec` was not touched. Behaviour verification by a separate agent is still to do.

## Failing first

| Test | Red | Green |
| --- | --- | --- |
| `work-model.test.ts`, `inspection-decode.test.ts`, the new `live data` block and decoder cases | 18 failed, 59 passed | All pass |
| `sse-resume.test.ts`, `inspection-feed.test.ts`, `inspection-contract.test.ts` | Modules missing: 3 files failed, no tests ran | All pass |
| `work-live.screens.playwright.ts`, first run | 6 of its tests failed | All pass |
| `next.screens.playwright.ts`, first run on the new surfaces | 10 failed | All pass |

The module-missing red is thin, as in Stage A, so the mutants are what prove those tests see the behaviour. Of the Playwright reds, three were real: the placeholder route lost its children because the search sheet was one, a task chosen in search did not open the inspector, and the Search button overflowed 320. The rest were the test or its mock. `9 working state` and the other Stage A names stay on the harness; they pass unchanged.

## After the change

| Command | Result |
| --- | --- |
| `pnpm exec vitest run --project a apps/web/test` | 21 files, 307 tests passed |
| `pnpm exec playwright test` in `apps/web`, under the lock | 249 passed |
| `pnpm check` | 1 failed, 2254 passed, 15 skipped. The failure is the permitted `login-cards.test.ts` node-pty case |

One earlier `pnpm check` also timed out `packages/git/test/exec.test.ts` "maps a signal death" while other agents loaded the machine. It passed alone (7 of 7) and in the following full run, which is the row above.

No baseline changed: `git diff --stat 5be0ef8 -- apps/web/test/__screenshots__` is empty. The live tests take no screenshots; they assert no horizontal scroll on all three surfaces at 1440, 1024 and 390 in both themes. The surfaces' pixels are the Stage A baselines, through the same components.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.2-work.json`: 38 of 38 killed.

New for Stage B, all killed: reopen uses the original after, a failed connection stays closed, a replayed event is applied twice, native reconnect left running, each reset takes its own snapshot, a reset keeps the old cursors, a reset is not said, an absent card can be approved, a stored message is dropped from the thread, a part list is counted, a deny falls through to approved, a read stops at its first page, an older refresh wins, a failed read drops what it had, a 409 reads as a failed answer, a double confirm sends twice, over-large reads as a plain error, a cut list decodes as whole, a task from another delivery shows, unreadable evidence is kept as current.

`search result sets composer intent` is not in the file: the model has no field for it. It is a hand mutant below.

Playwright gates by hand. Each ran its test once clean as a control, then with the edit, then restored.

| Mutant | Edit | Test | Result |
| --- | --- | --- | --- |
| selected row not marked | `aria-current` undefined in `WorkView` | `8 each row opens its own task` | Killed |
| amber kept on settled | `attention-label` always in `Decision` | `deny says denied` | Killed |
| inspector keeps a stale scope on repo switch | `selectedWorkId` ignores the list | `a filter that hides the row` | Killed |
| search moves the active repository | `repoId: 'repo_a'` in `chooseResult` | `search keeps composer intent` | Killed |

The third survived its first test, `switching repository drops the inspector`, because the address is cleared too. The filter test was added for it. The first hand-mutant run was void: another agent had overwritten my script on the shared scratch path, so it ran in their worktree. All four were rerun from my own `mktemp -d`, and only those results are here.

## Real server

`inspection-contract.test.ts` holds the fixtures and decoders to the real `buildServer` over a real `SqliteStore`: `real work page decodes`, `real task detail decodes`, `real needs decodes`, `real search decodes`, plus work detail, snapshot, stored messages, a redacted key, hold, lift and stop, a second answer, a second resolve, an absent card and `response_too_large`.

The builder also drove the built product once, on a scratch `MEC_DATA_DIR` and `HOME` with `MEC_FAKE_ENGINE=1`, in Chromium. Two repositories, one request each: Work grouped both under All, a delivery expanded with its dependency, hold and lift worked, search labelled kind and repository, Conversation led with the title and showed the acknowledgement and plan, Needs was empty and took no space, no console errors, and the events URL carried the applied cursors. This is a smoke run, not the verifier's seven steps.

## Unproven

- The verifier's steps, including stop and restart while on Work, a card through the release route with a fake `gh`, the second-tab answer, direct SQLite comparison and keyboard-only passes.
- `event: reset` against a server, because nothing sends it until M3.1 Stage 2. It is proved with a fake `EventSource` only.
- Request-to-PR traceability with real attempts and checks, until `33` repeats it with M2 evidence.

## Fixes after verification

Run by the builder, so this is not itself a verification. Every browser result below is against `page.route` mocks: nothing here drove a real server.

### Failing first

| Test | Red | Green |
| --- | --- | --- |
| `work-model.test.ts`, `workspace.test.ts`, `inspection-feed.test.ts`, new cases | 26 failed, 118 passed | All pass |
| `work-live.screens.playwright.ts`, new cases on the unfixed source | 21 failed, 2 passed | All pass |

The two that passed red are the controls: a first read that fails has nothing to keep. Several unit reds were a missing function, so the mutants are what prove those tests see the behaviour. Three browser reds were faults in the new tests and were corrected before the green run: `body` cannot be Playwright-focused, a selector guessed a title, and a reset went to a connection already replaced.

The first fix for the settled card read its evidence in `refresh`, which failed `reads an open card’s evidence, and not a settled one’s`. That test stands unchanged. The read moved to Needs you instead.

### After the fixes

| Command | Result |
| --- | --- |
| `pnpm exec vitest run --project a apps/web/test` | 21 files, 338 tests passed |
| `pnpm exec playwright test` in `apps/web`, under the lock | 272 passed |
| `work-live.screens.playwright.ts --repeat-each=5`, before the last test was added | 315 passed |
| `the sidebar count is the waiting list --repeat-each=20` | 20 passed |
| `pnpm check` | 1 failed, 2285 passed, 15 skipped. The failure is the permitted `login-cards.test.ts` node-pty case |

No baseline changed.

### Mutants

`python3 tools/mutants/run.py tools/mutants/m3.2-work.json`: 56 of 56 killed, 18 of them new: a failed repositories read forgets the rows, a failed read reports a repository as gone, a failed repositories read leaves the thread current, an unresolved open card follows the filter, an unresolved settled card ignores the filter, legacy work ignores the filter, another day has no date, today carries a date, another year has no year, an answered question leaves the thread, a thread question ignores the repository, a card with no evidence served reads as not loaded, a settled card has no retry, an open card gets the settled retry, a failure still reads as current, settled evidence is reread, settled evidence held is read again, settled evidence reads all at once.

Playwright gates by hand, in this worktree, each restored afterwards. All killed:

| Mutant | Test |
| --- | --- |
| a settled card does not claim focus | answering, confirming |
| a remounted card ignores its claim | answering, denying |
| work row does not recover focus | hold and lift, stop |
| stop opens with no focus | stop |
| keep it does not return focus | stop |
| a pointer does not release the row | a click on the page |
| a failure keeps the reset notice | reset notice |
| a failed read cannot move scope | switching during the failure |
| Conversation ignores the failed repositories read | the repositories route alone |
| settled evidence is not read on show | shows its own evidence |
| a settled card shows no Retry | offers a retry that works |
| the count test does not wait for evidence | sidebar count, 7 of 20 failed, the verifier's flake |

Two pieces were removed because no test could tell them apart from their absence: a position-stable key on hold and lift, and a render gate on the reset notice. Focus recovery and the withdrawing effect already cover both.

### Still unobserved

- A real restart. `composition.ts:206` listens on port 0, so a restarted server gets a new port, and an open tab stays labelled stale until the owner opens the new URL.
- `event: reset` from a server, because nothing on this base sends it. The new test sends it through a mocked stream.
- Approving a push card, questions from a real `ask_user`, and a label-only card from the real release route with the new rule.
- Axe, Lighthouse and measured contrast, which are handoff 33's. Request-to-PR traceability with real attempts and checks stays unproven until `33`.
