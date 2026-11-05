# M3.2 Stage A verification

5 November 2026, darwin, base `c25484e`. Run by the builder in an isolated worktree. No server ran, no real engine ran, nothing was pushed. Behaviour verification by a separate agent is still to do.

## Failing first

| Test | Red | Green |
| --- | --- | --- |
| `apps/web/test/inspection-decode.test.ts`, `work-model.test.ts` | Modules missing: 2 files failed, no tests ran | 58 passed |
| `apps/web/test/next-boundary.test.ts`, on the first build | Three fixture sentences were in `src/next` | Wording changed |
| `apps/web/test/work.screens.playwright.ts`, functional tests, first run | 6 of 30 failed | 30 passed |

The red evidence is thin in two places, stated plainly. The unit red is a missing module, so the mutants below are what prove those tests see the behaviour. The six Playwright failures were all in the test file (a label locator, an aria-hidden `?` in `toHaveText`, a name also matching a row, and a scroller measure); none was a product bug. The components were written before that file first ran, so no named Playwright test was seen red for its intended reason until its hand mutant.

## After the change

| Command | Result |
| --- | --- |
| `pnpm exec vitest run --project a apps/web/test` | 11 files, 135 tests passed |
| `pnpm test:screens` equivalent, `pnpm exec playwright test` in `apps/web`, under the lock | 184 passed |
| `pnpm check` | 1 failed, 1814 passed, 16 skipped. The failure is the permitted `login-cards.test.ts` node-pty case, `posix_spawnp failed` |

Classic and next baselines ran without `--update-snapshots` and show no diff against `origin/main`. New baselines: 30 files, five scenes at 1440, 1024 and 390 in both themes, all synthetic. Five were read by eye: work at 390 light, inspector at 1440 dark, needs at 1024 light, search at 390 dark, conversation at 1440 light.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.2-work.json`: 18 of 18 killed. `--self-check` gave SURVIVED for the no-op and INVALID for the syntax error, as expected.

| Mutant | Gate | Result |
| --- | --- | --- |
| group held as working | `work-model.test.ts` | Killed |
| group dropped as working | `work-model.test.ts` | Killed |
| a hold outranks a person stage | `work-model.test.ts` | Killed |
| count from a different list | `work-model.test.ts` | Killed |
| read failure gives needs count 0 | `work-model.test.ts` | Killed |
| action uses the selected filter's repo | `work-model.test.ts` | Killed |
| unassigned work offers actions | `work-model.test.ts` | Killed |
| coverage false maps to passed | `work-model.test.ts` | Killed |
| checks fall back to the card's checks | `work-model.test.ts` | Killed |
| a running task inherits checks | `work-model.test.ts` | Killed |
| a running card check passes the card | `work-model.test.ts` | Killed |
| a hold closes the card | `work-model.test.ts` | Killed |
| delegation inferred from dependencies | `work-model.test.ts` | Killed |
| actual model borrows the requested one | `work-model.test.ts` | Killed |
| tool activity reaches the chat | `work-model.test.ts` | Killed |
| a failed read with nothing kept reads as empty | `work-model.test.ts` | Killed |
| decoder accepts a missing cursor | `inspection-decode.test.ts` | Killed |
| fixture string reaches the bundle | `shell-split.test.ts`, real build | Killed |

Playwright gates, applied by a script and restored after each, under the lock:

| Mutant | Gate | Result |
| --- | --- | --- |
| selected row not marked | `selected row not marked: exactly one work row is current` | Killed |
| amber kept on settled | `12 amber leaves a settled item` | Killed |
| inspector keeps a stale scope on repo switch | `inspector drops a task from another repository` | Killed |
| search result sets composer intent | `search keeps composer intent` | Killed |

The fourth is a Playwright gate because `searchTarget` has no composer field for a model mutant to set. It mutates the harness, which is where the binding lives until Stage B. `reopen uses the original after` needs Stage B's `sse-resume.test.ts`, so it is not in this spec.

## Not proven here

- Nothing here ran against a server. Every payload is a fixture, and the contract test is Stage B.
- Axe and Lighthouse are `33`'s.
- At 390 on Work the scroller's `scrollWidth` exceeded its `clientWidth` by 16px on one measure, while no element's right edge passed the window and the document stays bounded. The cause was not found.
- `shell.css` adds two `noDescendingSpecificity` lint warnings, against unrelated selectors.
