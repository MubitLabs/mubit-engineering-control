# Verification

Branch `fix/real-run-defects` on base 3b40f25. No real engine, no `~/.mec`, no port 61610, no push.

## Failing first

Each test below was written before its fix and seen red for the intended reason, then green.

| Item | Test | Red |
| --- | --- | --- |
| D1 | `packages/domain/test/acceptance.test.ts` "no change and owned paths": unchanged base with no report; a progress report is no word | `verdict: 'accepted'` where a `no_change` repair was expected |
| D1 | `packages/meta/test/repair.test.ts` "green checks on the unchanged base with no report go to a repair"; "a final message beginning Blocked: …" | the task was `accepted` |
| D1 | `packages/meta/test/check-profiles.test.ts` "a no-change allowance on a plan task survives the tool and the store" | `noChangeOk` undefined |
| D2 | `acceptance.test.ts` "a commit that changes files outside the owned paths"; `repair.test.ts` "a commit outside the task's owned paths" | accepted |
| D2 | `packages/git/test/repos.test.ts` "changedPaths"; `packages/runtime/test/attempt-runner.test.ts` "exit 0 with no checks stays work_complete"; `apps/desktop/test/core-facts.test.ts` "walks a clean attempt" | `changedPaths is not a function`; `changed` / `changed_paths` undefined |
| D2 | `apps/desktop/test/engine-registry.test.ts` "a Claude specialist loads no CLAUDE.md" | no `CLAUDE_CODE_DISABLE_CLAUDE_MDS` |
| D3 | `repair.test.ts` "the owner's Try again" (6 cases) | `ownerRepairOffer is not a function` |
| D3 | `apps/desktop/test/delivery.test.ts` "used-up repairs offer Try again" | `retryOffer` undefined |
| D3 | `apps/desktop/test/approval-key.test.ts` "Try again needs the key" | `expected 404 to be 403` |
| D3 | `apps/web/test/work-model.test.ts` retry labels; `apps/web/test/inspection-decode.test.ts` "Try again offer decodes" | label and decode refused `repair` |
| D3 | `packages/meta/test/turn-replies.test.ts` "describes only the re-run the product offers" | protocol had no such rule |
| D4 | `packages/meta/test/go-ahead.test.ts` (4 cases) | the work stayed `blocked` after the owner's answer and follow-up |
| D5 | `apps/desktop/test/meta-visibility.test.ts` "work whose pull request is ready"; `delivery-surfaces.test.ts` "a repair whose attempts are used up" | `Integrating …`; `A repair is open.` |
| D6 | `repair.test.ts` "carry the root task's model request" | no `modelRequest` on the repair task |
| D7 | `packages/meta/test/service.test.ts` "the note names the work by a short title" | `Noted on wi_live: …` |
| D7 | `meta-visibility.test.ts` waits in words, agreement wait, blocked never-started task, cut between words | `no_capacity`, `host_run_unagreed`, `null`, a mid-word cut |
| D7 | `apps/web/test/meta-visibility.test.ts` "a wait the server words as until" | `Waiting: until …` / `Waiting: prerequisite …` |
| D7 | `delivery.test.ts` "a failed setup command … one chat line" | `expected 0 to have a length of 1` |

One assertion changed on purpose: `meta-visibility.test.ts` "a task nothing has picked up" used to expect the raw `no_capacity`; it now seeds the real `capacity` defer and expects `until a slot unit comes free` (D7).

## Mutants

`python3 tools/mutants/run.py tools/mutants/real-run-defects.json`: 31 of 31 killed, exit 0.

## Suites

- `pnpm check` (typecheck, lint, both suites) at 8aa123f: typecheck and lint passed; tests 3532 passed, 39 failed, 13 skipped, in 11 files of the b project. Every failure was a timeout or a worker that did not start (`Timeout waiting for worker to respond`, `pid file never appeared`, `att_1 reaching work_complete never held`), with files taking 300 to 460 s on a shared, loaded machine.
- Those 11 files again with `--project b --maxWorkers=2`: 312 of 312 passed (`approval-key`, `attempt-launch`, `bundle-defaults`, `composition`, `coordination`, `delivery-flow`, `engine-registry`, `login-cards`, `recovery`, `attempt-runner`, `supervisor`).
- Screens: `pnpm test:screens` under `/tmp/mec-screens.lock`: 1032 passed, exit 0. No baseline changed: no fixture offers a `repair` retry or carries the reworded waits, so the new words are covered by the unit tests above, not by a screenshot.

## Not proven

- D2 rests on the 2.1.319 binary's text, not on a run: that `CLAUDE_CODE_DISABLE_CLAUDE_MDS` gates only the `CLAUDE.md` loaders, that the user source gates the user `CLAUDE.md`, and that the project `CLAUDE.md` loads only with the project or local source, which MEC never passes. A real specialist run on a linked slot would show whether the owner's instructions are gone and sign-in still works. None was spent.
- No real run of Try again, the go-ahead lift or the owned-paths repair.
