# Verification

No real engine ran (0 of the budget). Fakes prove the logic. Whether real Claude now follows the new protocol is not proven here.

## Failing first

Each was seen red for the intended reason, then green.

| Item | Test | Red |
| --- | --- | --- |
| 1 | `turn-replies.test.ts` "speaks the report", "the answer lands on the message when the report names the work" | `expected 'You are asking a question, so I will …' to be 'It returns hello-world.md.'` |
| 1 | `durable.test.ts` "a question answered by its report alone is a whole turn" | timed out at 60 s waiting on the corrective retry |
| 2 | `scheduler.test.ts` "a repair reporting blocked on a red head ends the repairs", and `failed` | `expected [ { attemptId: 'att_2', … } ] to deeply equal []` |
| 3 | `inspection.test.ts` "a push card opened for work reads Needs your approval" | `expected { key: 'working', … } to match object { key: 'person/decision', … }` |
| 3 | `delivery.test.ts` "both delivery cards name their work" | `expected undefined to be 'wi_abcdef12'` |
| 4 | `scheduler.test.ts` "a task that used up its repairs wakes one turn" | `expected [] to have a length of 1 but got +0` |
| 5 | `turn-replies.test.ts` protocol rules | the rule text was absent |
| 6 | `turn-replies.test.ts` "the same decision is asked once", "a wake with nothing new" | no `quiet`, and every question stored |
| 6 | `inspection.test.ts` "a wake kept quiet stays off the chat" | `expected [ 'msg_wake_quiet', 'msg_wake_spoken' ] to deeply equal [ 'msg_wake_spoken' ]` |

The first focused run showed 33 red. "an integration repair past the cap" was first red as a `TypeError`, from the new `openRepairTask` signature, then for the right reason once the signature landed.

## Changed assertions

One: `states.test.ts` gains the row `planning --answered--> done`, an intended behaviour change. No existing assertion was weakened or removed.

## Mutants

`tools/mutants/core-coordination.json`, 43. Self-check passed. The first run killed 41. Both survivors were real gaps, and each got a test:

- "a repair task and its root wake separately": nothing proved one family shares a wake. `scheduler.test.ts` "a repair task and its root are one family".
- "a person's own message can go quiet": nothing asserted it. Added to "speaks the report".

The whole spec was then rerun on the final code: 43 of 43 killed.

## Gate

`pnpm check` at `edb736f` reached the tests, so typecheck and lint passed. It exited 1: 3244 passed, 47 failed, 11 skipped, 9 of 195 files failed.

All 47 are in spawn-heavy suites, with stalled launches, `pid file never appeared` and `Failed to start forks worker`. `packages/runtime` is not in this diff. Other sessions shared the machine, and `syspolicyd` ran at about 85 %.

| Step | Files | Passed | Failed |
| --- | --- | --- | --- |
| Serial rerun of the 9 failed files on the branch | 9 | 254 | 13 |
| Base `07000f2`, serial, the 4 files still failing | 4 | 131 | 0 |
| Branch, serial, the same 4 files | 4 | 131 | 0 |

The 5 files that passed in the first serial rerun were not repeated, and neither were the 4 on the base. No single `pnpm check` run has been green on this branch. **The landing must run it on a quiet machine.** Load is the supported cause, not a proven one: `syspolicyd` load was seen, but it was not isolated as the cause.

After the gate only test code and these records changed. The final commit reruns typecheck, lint and the touched suites.

## Not proven

- That real Claude answers a question through `report_result` and stops acknowledging it.
- That the remedy rule stops an invented fix. It is a prompt rule, not a code gate.
- Runs A and C2 end to end through the fixed code. Each fix has its own test, and no test composes the whole of C2.
- The answer's rendering in the live web UI.
