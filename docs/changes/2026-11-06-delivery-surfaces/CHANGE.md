# Delivery surfaces

The installed real journey found eight places where the new shell said less than the store knew, or said something untrue. This change makes each surface say what is recorded. Stored data gains additive fields only: no SQL migration, and `packages/contracts` is untouched.

| # | Gap | Cause | Change | Spec |
| --- | --- | --- | --- | --- |
| 1 | No UI opened a merge card | Nothing called `POST /api/release/merge`, and CI verdicts were read and dropped | Work offers **Merge pull request #n** on a `pr-ready` delivery, through that route. `Delivery.#observe` stores each CI reading (`ci`, `ciAt`), and Work shows it with its time | §13, §14 |
| 2 | A person stage with an empty Needs you | `#openRows` held questions and cards only | Work in a `person/*` stage with no question or card of its own is a `work` need, so the list and every count agree | §18.2, §18 principles |
| 3 | Conversation showed no block | Only the plan card's stage label carried it | Each blocked delivery in the repository has a notice in the thread | §18.1 |
| 4 | A question left a row Working / Planning | An ack-only turn leaves the item `planning`, and stage fell through to `working` | `plannerTurnEnded` is §10's `waiting`: the row reads *Waiting for a trigger* and says nothing runs | §10 |
| 5 | The ack promised an answer that stayed in a work event | The answer was the `report_result` summary, written only to `result_reported` | An ack-only user turn with no card stores it as `replyText`, redacted, and chat shows it. The planner prompt says the summary is the answer | §12.2, §12.7 |
| 6 | Diff said "Not recorded yet" on an accepted head | No writer stores `attempt.diff` | The route reads `git diff --numstat` between the attempt's base and head, or names the commit and says its changes could not be read | §15 |
| 7 | "Delivery is not recorded yet" beside a failure | Coverage ignored the integration record, and no view read `failed` | `delivery.failure` carries the integration failure, the record's `error` or an integration block | §14 |
| 8 | Raw ISO time, a late paused ack, a trailing comma | The banner printed the stored value. The paused ack lived only in the POST answer. The line joined an empty provider | `timeLabel`. `pausedAck` is stored and shown while paused, and a press shows the server's own answer at once. `connectionLine` | §20, decision #27 |

## Decisions where the spec is silent

Each takes the conservative option. The coordinator may want them in front of the owner.

- **A merge card on a repository with no required checks.** Decision #34 says the card stays held until the owner decides for that repository, and `answerMerge` holds on anything but green. Merge is still offered, because #34 says a card exists, and Work says it stays held. Nothing about the merge gate changed.
- **Held work is not in Needs you.** §18.2 lists `person` stages, and §10's table lists `held` separately. The owner chose it, and Work shows it.
- **Unassigned blocked work is listed and offers no action,** like an unassigned question (§18.2: nothing waiting on a person is hidden). It counts, and it cannot be cleared from the page.
- **A wake's report stays out of chat** (§12.7: no progress narration). Only a turn a person started shows one.
- **A report beside a card stays out of chat.** The card is the message.
- **Diff shows file names and line counts, not patch text.** File contents have not had a slot's exact-key redaction, and the Inspector's wire already carries counts.
- **Work that ends without a plan stays in `planning`.** The page shows the true stage. Ending the item would be a state write this change does not need.

## Delivered shape

- `POST /api/release/merge` takes an optional `workItemId`. The card then joins that work, so its stage and Needs you find it. That work's delivery must be ready on this same PR. An open card on the same head is returned, not doubled, and a settled, expired or stale one never is. `docs/reference.md` has the refusals.
- `GET /api/inspect/work/:id`: `delivery` gains `repo`, `ci`, `ciReadAt`, `failure` and `mergeCardId`, each left out until true.
- `GET /api/inspect/needs`: a third kind, `work`. The web decoder ships with it.
- `GET /api/inspect/tasks/:id`: git runs before the read's transaction, and only commit ids reach it.
- `POST /api/processing/pause` also answers `pausedAt`.

The retry lane's slot is `WorkAction` in `apps/web/src/next/work-model.ts`: one union member, one entry in `workActions`, and `DeliveryDetail` renders it beside Hold and Stop.
