# Core ship: the fixes for 0.3.1 on one branch

`feat/core-ship`, from `origin/main` at `07000f2`. Replayed by cherry-pick, in this order: `fix/core-coordination` (to `4aa7434`), `fix/integration-bootstrap`, `fix/slot-choice`, `fix/runtime-defaults`, `fix/host-run-agreement` as committed at `c477d1a`, `feat/meta-visibility` (to `b3416da`), `fix/delivery-surfaces`, `fix/walkthrough-polish`. `chore/remove-classic-final` is not on this branch. Each branch keeps its own record under `docs/changes/`. This one covers what they did to each other.

## Where they overlapped

| Overlap | Resolution |
| --- | --- |
| Three answer paths | Core's stands. The report is the message's `ackText` and it ends the work. `replyText` is gone from the service, the chat route, the decoder and the page. The time join is gone too: Work's `answer` is the receipt of the message `work_answered` names |
| `plannerTurnEnded` read *Waiting for a trigger* | One stage for a person: `turnOutcome`. `plannerTurnEnded` only says the turn is over, so a row reads No answer and never Waiting. The planner's own context still reads the stage |
| Answered on ended work | A `done` item with no task and no merged delivery reads Answered. Held work keeps its held stage, so Lift stays offered |
| `protocolIncomplete` was never read | The service records `turn_incomplete`, and the item keeps core's rule: it finished nothing, so it stays open. The row says No answer and the chat adds the note |
| The protocol sentence | Two branches wrote the same instruction. One copy, core's, in `protocol.md` and `brain.ts` |
| Wake reports | Core's: a wake with something new speaks its report, and one with nothing new stays off the chat. `delivery-surfaces` kept every wake's report out, so its test changed |
| Retry and merge | Both are `WorkAction` kinds. `workActions` takes the retry, then the delivery |
| The live line and Needs you | Work needs joined `openNeeds`, so the meta line read a blocked row as a card. It reads decisions now |
| Title length | One `TITLE_CAP` of 500. The live line cuts a title to 80, or a request filled it |
| Activity labels | One `activitySummary`. Delegation's last step reuses it |
| Repository dropdown | Only `meta-visibility` hides it, so nothing was removed twice. Shown for two repositories or with Unassigned history (`repoScopeApplies`) |
| Delivery failure wording | The block patterns differed. A block that retry answers (`checks failed on`, `could not run`) is now a delivery failure too |

## Other changes

- Unassigned blocked work stays listed and leaves every count, on the server and the page: it cannot be cleared there. This replaces the `delivery-surfaces` decision that it counts.
- Every string in `tools/mutants/*.json` matches exactly once. Three chat mutants of the dropped reply path are gone; core's cover the same lines. `tools/mutants/core-ship.json` holds the mutants for what was resolved by hand.

## §12.1 amended by the owner

A question sent while work is running in that repository gets a real planner turn and its answer in chat, not "Noted as context". A note beside live work stays context, as before. `isQuestion` in `packages/meta/src/routing.ts` is the test: a `?` anywhere, or a sentence opening with an asking word. It leans to a turn, so a note like "Do the rest later" costs a turn and changes nothing.

The turn runs on its own work item, marked `questionOnly` so a resume after a crash keeps it. It keeps only its words, its reports and what it asks the person: a plan, stop, cancel, spawn, route or card from it is dropped before anything is written, and a report aimed at the running work lands on the question's item. `docs/plan/spec.md` §12.1 and `docs/DECISIONS.md` are not edited here; the decision record is the coordinator's.

## Limits

- An item from before this build, whose answer sits only in `result_reported`, reads No answer: nothing joins that report to a message but its time. The report is still in the stored events.
- A No answer item stays `planning` in the store, so the planner still sees it as live work.
- The host-run agreement is not on this branch: `fix/host-run-agreement` has it uncommitted.
