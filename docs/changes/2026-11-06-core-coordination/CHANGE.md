# Core coordination

Six defects proven on real Claude in journey runs A, B, C1 and C2, on `fix/core-coordination` from `origin/main` at `07000f2`. No real engine ran for this change, so each fix is proven on fakes against what those runs recorded. No SQL migration. `packages/contracts` is unchanged.

## What changed

1. **Answers reach the chat (§6, §12.2).** Run A's question got "I'll answer it from the recorded work", and its answer went into a `result_reported` event that nothing in the apps reads. `#ackOnlyTurn` now speaks the turn's report: it becomes the message's `ackText`, redacted, whichever stream the event went to. A turn that asked a question or opened a card keeps its acknowledgement, because the card is what the person acts on. A report fenced out of the repository is not spoken.
2. **A reported turn ends its own work.** A `planning` item with no tasks and a report, waiting on nobody and not held, moves to `done` by a new `planning --answered--> done` transition, with a `work_answered` event. A new event keeps delivery's `work_done` from ever finishing a planning item. Left in `planning`, the item read as Working, and it counted as live work, so later messages without a reference became conversation (§12.1).
3. **`blocked` and `failed` settle on `checks_failed` (§10).** `settleOnReport` no longer returns early on a red head. In C2 this is what opened `att_3` after `att_2` reported that a person must act. `dropped` on a red head still goes to the checks.
4. **Delivery cards name their work.** `openPushCard` and `createPrBehindCard` take an optional `workItemId`, and delivery passes it. Stage then reads "Needs your approval" and Needs you lists the card under that work. Cards opened by the manual release routes have no work to name, as before.
5. **Used-up repairs wake once (§6).** This is "work parked with no automatic resolution". The wake is keyed `used-up:<root task>`, so a task and its repair tasks share one. A block a specialist reported is its report's wake, not a second one. Dependents add none, and a failed check with a repair left adds none.
6. **Same decision once, no unchanged status (§12.6, §12.7), in code.** `#withoutRepeats` drops a planner question whose words match an open or answered one, or, on stuck work, any question asked since the work last moved (no new plan revision or attempt). It records `question_repeat_refused`. A wake that plans and asks nothing stays off the chat when its reason is `report ready`, `report dropped` or `specialist question`, or when it is a block wake on a block already told (`toldBlock`). The message keeps its receipt with `quiet: true`, so a replay runs nothing, and `GET /api/chat/messages` leaves it out. A wake a person caused always speaks. An unknown reason speaks too.
7. **Protocol.** A question is answered by `report_result`, not acknowledged. `completed` in `brain.ts` accepts a report alone with no plan, so that does not cost a corrective retry. New rules: never name a remedy, setting or panel the turn context does not show, the Slots panel takes engine keys only, never ask the same decision twice, say nothing new when nothing changed. The fallback in `brain.ts` carries the same rules.

## Choices

- **A plain question still opens a work item.** §12.2 says a quick question is answered directly with no acknowledgement. It does not say no work item. The planner is the only classifier and it runs after admission, and resume after a crash finds the message through its `planning` item (§20). Skipping the item would move that ordering for no gain, so the item stays and ends with the turn.
- **Only a turn with a report ends its work.** A turn that stopped at its acknowledgement reaches here only after the protocol failed twice. Its words stay visible and its item stays open, which keeps `feat/meta-visibility`'s "No answer" state honest. Six existing tests also rest on this.
- **Reply in `ackText`, not a new field.** It shows in today's web with no web change, and the receipt, replay and `Acknowledger` paths already carry it.
- **`quiet` is filtered in the server.** The web renders every wake's `ackText`. A receipt must stay, because `enqueueResumes` and replay read it.
- **Why "stuck and not moved", not similar text.** C2's three questions shared no reliable wording. The rule applies only to stuck work, so a second real clarifying question during planning still reaches the person.

## Coordination with `feat/meta-visibility`

Read from its worktree at 19:14, uncommitted. It renders replies in the web and adds `replyOf` in `inspection.ts`. This change stays in server, scheduler and prompts. Three things to reconcile at landing:

- `protocol.md` and the `report_result` step in `brain.ts`: the report sentence here is word for word the sibling's, so those lines should merge. Step 1 is new here.
- `GET /api/chat/messages` in `server.ts`: both edit this handler. Keep the `quiet` filter, then its `replyText` map.
- `#turnOutcome` in its `inspection.ts` reads only `state === 'planning'`. An answered item is now `done`, so it gets the "Done" label and a null `answer`, not "Answered". It needs `done` with zero tasks as well. Its `replyOf` matches the item's own stream only, which is harmless: a report aimed elsewhere is already in `ackText`.

## Risks

- A `report ready` wake's planner words no longer reach the chat. They stay on the record as `result_reported`. Delivery's cards remain the person's signal.
- Dedupe compares at commit, after the planner has written its turn, so its acknowledgement can say it asked when the repeat was dropped. The report is what shows in that case.
- A stuck item's second, genuinely different question is dropped until the work moves.
- `toldBlock` and `progressMark` are new fields on stored documents. Older rows lack them and behave as never told and never matched.

## Not changed

- `blockTask` from a wall clock or a failed launch still wakes nobody. The brief scoped this to used-up repairs.
- The merge card has no `workItemId`: it opens from a route that has only a PR number.
- With live work and neither a reference nor a New request, a question is still "Noted as context" with no turn (§12.1).
- `real-brain.ts`'s v0 protocol text.
