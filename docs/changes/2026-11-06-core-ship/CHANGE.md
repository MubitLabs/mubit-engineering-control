# Core ship: the fixes for 0.3.1 on one branch

`feat/core-ship`, from `origin/main` at `07000f2`. Replayed by cherry-pick, in this order: `fix/core-coordination`, `fix/integration-bootstrap`, `fix/slot-choice`, `fix/runtime-defaults`, `fix/host-run-agreement` as committed at `c477d1a`, `feat/meta-visibility`, `fix/delivery-surfaces`, `fix/walkthrough-polish`. `chore/remove-classic-final` is not on this branch. Each branch keeps its own record under `docs/changes/`. This one covers what they did to each other.

## Where they overlapped

| Overlap | Resolution |
| --- | --- |
| Three answer paths | Core's stands. The report is the message's `ackText` and it ends the work. `replyText` is gone from the service, the chat route, the decoder and the page. Work detail's `answer` reads the stored report, so nothing new is written |
| `plannerTurnEnded` read *Waiting for a trigger* | It now decides whether an ended turn may read as Answered or No answer. A row never shows that stage, because nothing would ever move it. The planner's own context still reads it |
| Answered on ended work | A `done` item with no task and no merged delivery reads Answered. Held work keeps its held stage, so Lift stays offered |
| Wake reports | Core's: a wake with something new speaks its report, and one with nothing new stays off the chat. `delivery-surfaces` kept every wake's report out, so its test changed |
| Retry and merge | Both are `WorkAction` kinds. `workActions` takes the retry, then the delivery |
| The live line and Needs you | Work needs joined `openNeeds`, so the meta line read a blocked row as a card. It reads decisions now |
| Title length | One `TITLE_CAP` of 500. The live line cuts a title to 80, or a request filled it |
| Activity labels | One `activitySummary`. Delegation's last step reuses it |
| Repository dropdown | Only `meta-visibility` hides it (`RepoScope`). Nothing to remove twice |
| Delivery failure wording | The block patterns differed. A block that retry answers (`checks failed on`, `could not run`) is now a delivery failure too |

## Other changes

- Unassigned blocked work stays listed and leaves every count, on the server and the page: it cannot be cleared there. This replaces the `delivery-surfaces` decision that it counts.
- Every string in `tools/mutants/*.json` matches exactly once. Three chat mutants of the dropped reply path are gone; core's cover the same lines. `tools/mutants/core-ship.json` holds the mutants for what was resolved by hand.

## Limits

- An item from before this build, whose answer sits only in `result_reported`, reads Answered and shows the answer in Work. Its chat line stays the acknowledgement.
- `#answerOf` on `done` work returns the last report on the work stream.
- The host-run agreement is not on this branch: `fix/host-run-agreement` has it uncommitted.
