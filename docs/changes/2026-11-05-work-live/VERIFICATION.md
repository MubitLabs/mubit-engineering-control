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
