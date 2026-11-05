# Verification: M1.4a authority fence

Base: `feat/repo-identity` at `c827da8`, not `origin/main`. The coordinator waived the handoff's "Start when" line for this run.

## Failing first

| Command | Before | After |
| --- | --- | --- |
| `pnpm vitest run packages/meta/test/authority.test.ts` | 42 failed, 2 passed (`service.stopWork is not a function`, stub `not implemented`) | all pass |
| `pnpm vitest run packages/meta packages/store apps/desktop/test/server.test.ts apps/desktop/test/composition.test.ts` | 19 failed, 204 passed (the new server and composition tests) | all pass |

## Mutants

`python3 tools/mutants/run.py tools/mutants/authority-fence.json`: 34 of 34 killed. Mutants 1-15 are the handoff's list. Mutants 16-34 cover the gates added beyond it.

## Full gate

`pnpm test`: 1860 passed, 15 skipped, 1 failed. The one failure is the README baseline (`login-cards.test.ts`, "drives a real interactive shell through the seam").

`pnpm check` on the same tree, while other agents were using the machine, failed two more tests, both outside this change: `packages/git` "maps a signal death to code -1" and `writeShimDir / verifyShimDir` "a blocked command fails by name". Neither failed on the rerun above. Typecheck and lint pass; lint reports 17 warnings and no errors.

`pnpm --dir apps/web test:screens`, under the shared lock: exit 0.

## Builder smoke

This is the builder's own run, not the separate verification the handoff requires. Scratch server from the built tree, `MEC_FAKE_ENGINE=1`, scratch `HOME` and `MEC_DATA_DIR`, one registered scratch repository.

| Step | Observed |
| --- | --- |
| Request, hold, restart | `state: executing, held: true`; attempts unchanged, `att_1` still `queued` |
| Lift, then lift again | `lifted` with `launches: 0`, because the only ready task already had `att_1`; then `free` |
| Attempt 3 s after the lift | still `queued`: its row waits out the 30 s deferral, see the `§17` note in `CHANGE.md` |
| Stop twice, restart | `stopped` both times; `att_1` `interrupted`; still `stopped` after restart |
| Pause twice | `paused` both times |
| Request while paused, 4 s later | launch row still in `effects`, `/api/status` says `paused` |
| Stop the server while paused | rows still there after exit |
| Restart while paused, 3 s later | still paused, same `pausedAt`, rows untouched |
| Resume twice | `running` both times; the due row ran and `att_2` reached `succeeded` with its `taskId` |

## Notes for the verifier

- **Lift step.** With the fake brain only one task has no dependencies, and it gets its attempt before a hold can land, so step 2 of the verifier instructions shows `launches: 0` and that queued launch restarting within 30 s. A plan saved with zero launches needs a brain held open, which only the unit test can do.
- **`mec status` on a scratch server.** With no slot it printed `waiting for setup: no slot` (exit 3), because §21.2's first match wins in `status.ts`. It prints `paused` only with a slot and a repository. `/api/status` and `health.json` say `paused` either way. Seed a slot, or read `health.json`.
- **Planner race.** The unit test `stop during awaited planning launches nothing` uses a real held promise. It cannot be timed over HTTP with the fake brain.

## Not verified

- Separate behaviour verification (README rule 6) and the blockers-only review the handoff requires. Both need a different agent.
- The classic UI by hand: Lift in place of Hold, the two-step Stop, the palette's Resume, and `Runtime paused` at startup. `test:screens` has no case for them, and `api.test.ts` covers only the client calls.
