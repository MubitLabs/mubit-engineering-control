# Verification

Branch `fix/moved-head`, base 29f1588 (v0.3.5). The builder ran these checks on 9 November 2026. No real engine was used. Nothing touched `~/.mec`, the installed server on port 61610 or MubitLabs/mec-sandbox, and nothing was pushed.

## Failing first

| Item | Test | Red |
| --- | --- | --- |
| (a) to (d) | `apps/desktop/test/delivery.test.ts` "a pull request head that moved on GitHub …": 15 tests on real git, with a local bare repository standing in for GitHub and a fake `gh` | All 15 failed: no `prHead`, `headMoved`, `behind`, `update` or `ciSince` on the record, and the retry was `refused` |
| (a), (d) | `packages/domain/test/stages.test.ts`: table order, the new fixtures and 4 new tests | 6 failed (`deliveryWaiting` was missing, and so were both rows) |
| (a), (d) | `apps/desktop/test/delivery-surfaces.test.ts` "an open pull request that waits on GitHub reads in words …" | 3 of 4 failed (stage, reason, Next line, live line, `movedTo`, `ciSince`). The behind test passed once `retryOffer` was in, because it was written after it |
| (a), (d) | `packages/meta/test/context-stage.test.ts`: 2 new tests | Seen red with the `deliveryWaiting` line removed, and green with it back |
| (b), (d) | `apps/web/test/inspection-decode.test.ts` and `delivery-surfaces.test.ts`: 3 new tests | 3 failed (the `update` kind was rejected, and there was no since line or *Bring up to date* label) |

Two tests were added after the first green run to make mutants killable: "a rebase onto main is not adopted …", and the side-branch merge switched to an empty commit. A third tightening made the (d) test deterministic: an earlier `ciSince` is put on record, and the test checks that it stands. The (b) fast-forward test also checks that `prHead` clears and that the adopted head is not judged again. One existing rig line changed: the fake `gh pr view` now lets a test set `mergeStateStatus` (its default stays `CLEAN`). No existing assertion was changed.

## Mutants

`python3 tools/mutants/run.py tools/mutants/moved-head.json`: 23 of 23 killed. They cover all three adoption rules, the file-content comparison, judging each head once, clearing a put-back head, the start from the adopted head, the gates for failing checks and interrupted updates, the agreement gate, `behind`, the push card's diff base, the CI-wait start and queued flag, the domain rows, the inspection reason, Next line, live line and facts, the meta context, the web decoder and the web since line.

## Suites

- `pnpm test:a`: 111 files passed, 1 skipped; 1942 tests passed, 1 skipped.
- Desktop, on 9 files together (`delivery`, `delivery-surfaces`, `delivery-flow`, `inspection`, `inspection-trace`, `meta-visibility`, `release`, `release-cards`, `host-run-agreement`): 453 passed, 7 failed. All 7 failures were "condition never held" timeouts (60 s and 120 s) in `host-run-agreement` (4) and `delivery-flow` (3). Run alone, each file passed: `host-run-agreement` 20 of 20, `delivery-flow` 7 of 7. The same `delivery-flow` timeouts appeared on the first baseline run, before any source change on this branch (2 or 3 failures, which tests depended on machine load).
- `tsc --noEmit` for `apps/desktop`, `apps/web`, `packages/domain` and `packages/meta`: clean.
- `biome check .`: 0 errors (141 warnings and 2 infos, the same count as before this change).
- Screens, under `/tmp/mec-screens.lock`: `playwright test delivery.screens work.screens work-live.screens`, 177 passed. No screens test was added for the new stages: the web change is in the model and the decoder, which the vitest tests above cover.

## Not verified

- The installed build. PR #7 on mec-sandbox (head 63865a9, an Update branch of c4a7ebd) stays open so that (c) can be proven on the real repository. Expected: `head_adopted`, then *Ready for review* and a merge card that pins 63865a9.
- A real GitHub fetch. The tests fetch from a local bare repository through `url.<path>.insteadOf`. The production fetch uses `pushTarget`'s `remoteUrl` and the user's ambient git credentials, the same as the push.
