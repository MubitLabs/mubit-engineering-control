# M3.2 Stage B: the work surfaces on live data

5 November 2026. Handoff `docs/changes/2026-11-05-meta-agent-journeys/handoffs/31-m3.2-observable-work-ui.md`, Stage B. Decisions #10, #11, #20, #22, #28, #36. Base: local branch `feat/durable-commands`, as the coordinator directed.

## What

`?ui=next` now shows Conversation, Work and Needs you with real data, and can search. The classic shell, `ui-flag.ts` and every classic baseline are untouched.

- `apps/web/src/api-inspect.ts`: the reads and owner commands, each read through `inspection-decode.ts`. `api.ts` gains one word, `export` on `request`.
- `apps/web/src/live/inspection.ts`: the store behind Work, Needs and search. Plain objects, so its races run in vitest.
- `apps/web/src/live/events.ts`: `subscribeResumable`, one merged SSE connection that survives a failure.
- `apps/web/src/live/workspace.tsx`: a snapshot gives the first cursors, a reset takes one new snapshot, and `onRefresh` lets the inspection reads share the feed's triggers.
- `apps/web/src/live/LiveApp.tsx`: the `chat`, `work` and `needs` entries bind the Stage A views. `WorkSurface`, `ConversationSurface` and `workScope` are gone.
- `next/NextApp.tsx`: the `needs` placeholder is gone. The other three stay for `32`.

## Behaviour worth stating

- **Scope.** Reads are unfiltered and `work-model` filters what was read, so a filter cannot reach a request. Work and Needs start on All repositories, because the first question is whether anything needs you. Moving between repositories moves the filter; a reload does not. The sidebar count is the filtered list's own.
- **Lists are whole before they are counted.** `/api/inspect/work` is oldest first and a page holds 100, so a first page alone would hide the newest work. `walk` follows `nextCursor` to the end, up to 20 pages. Past that the list says so and `count` is `null`. Each group shows newest first.
- **Search never moves the composer.** A choice keeps the active repository, and widens the filter to All if it would hide the row. A message in another repository opens its work, because reaching its thread would change the send target. `SearchHit` has no `repoId`, so "another repository" compares the served label from the snapshot. Two repositories with one label would read as the same one.
- **Discuss uses the item's own repository**, sets M1.3's intent there and moves to it. The button names the repository under All. It is not offered on ended or unassigned work.
- **Evidence.** Open cards' evidence is read one at a time on each refresh. `{absent: true}` (the 404 placeholder from `api.decisionDetail`) and a failed read both mean nothing to approve on; deny stays. Evidence that can no longer be read is dropped rather than kept as if current.
- **Outcomes.** A deny is `DENIED`, never `describeApproval`'s fall-through. A 409 on a card is "Already handled". An approve that got no answer stays open and says it may not have landed, because it might have.
- **Freshness.** Every surface keeps content on failure, shows when it was last read and offers Retry. A kept delivery or task is labelled stale. `response_too_large` has its own words and a Retry, which the docs say answers the same until the record changes.
- **Events.** On `error` the source closes and reopens from applied cursors, backing off from 1 s to 30 s. A replayed event is applied once. On `event: reset` the connection closes, one snapshot replaces the cursors even if they are lower, everything is re-read, and the page says so. Nothing on this base sends `reset` yet; that arrives with M3.1 Stage 2.

## Stage A faults found by the real shapes

Both are fixed here, and each has a test and a mutant.

1. **The real conversation was empty.** `conversationView` dropped any line whose `kind` was not listed, and stored messages have no `kind`. It also lost `ackText` and `secretGuard`, which live on the stored message. Fixtures had a `kind` on every line, so nothing showed it. `storedLines` now has the real shape and `inspection-contract.test.ts` reads a real message.
2. **`canApprove` trusted the placeholder.** See Evidence above.

Stage A's assumptions now hold against a real server: stage keys land in the expected groups, and `needs` and `search` are `Page<T>`.

## Outside the handoff's file table

- `next/address.ts` has no work or task on `#chat`, so a task opened from Conversation is local state and does not survive a reload. Work's does.
- `live/live.css` hides the breadcrumb's repository at 360 px and under, because the Search button overflowed 320 by 45 px. The drawer still names it.
- `inspection-wire.ts` gains the truncation fields and `Snapshot`. Each `*Truncated` is shown wherever its list is, so a cut list never reads as whole.

## Intended test changes

- `shell-split.test.ts`: `/api/` is no longer refused in the entry chunk, because the decoder and `api-inspect` now live there, as the handoff expected. The mock names stay refused.
- `next.screens.playwright.ts`: the live mock serves the inspection routes. `.task-list` became `.work-group` and `Follow up on this work` became `Discuss this work`, because the surface was replaced. The behaviour asserted is the same.
- `workspace.test.ts`: the rigs gain `snapshot`. `work-model.test.ts`: three check objects gain `truncated: 0`. No assertion moved.
- `m3.2-work.json`: three Stage A mutants retargeted, because the line they mutate changed. `fixture string reaches the bundle` pointed at a constant M1.3 removed, so it now mutates `routes.ts`.

## Costs and risks

- A refresh reads every page of work and needs. At 1,000 deliveries that is 10 pages every 10 s, each 30-54 ms by #38's figures. Most repositories are one page.
- Default-off flag, so nothing here reaches an install on its default. Rollback is a revert.

## Left for later

- Stage C: activity pages, artifacts, compact events.
- Request-to-PR traceability with real attempts and checks stays unproven until `33` repeats it with M2 evidence.

## After verification

The verifier's run found seven defects and a flaky test. All are fixed here.

| Defect | Fix |
| --- | --- |
| Conversation lost its thread when `GET /api/repositories` failed | `resolveActive` treats rows kept from a failed read as still known, and `chatRead` feeds that failure into the kept-content path. Rows from a failed read cannot prove a repository has gone: no "no longer registered" notice, and the stored choice stands. |
| An open `pr_create` or `pr_merge` card vanished under a repository filter | The release routes store only `payload.repo`, so the card has a label and no id. An open card like that now stays under every filter, labelled as itself. A settled one still follows the filter, so audit item 11 holds. |
| Focus fell to the body after hold, lift, stop, keep it, answer and approve | A delivery acted on takes focus back, onto its next action or its own row, on every commit until a pointer goes elsewhere. Opening stop lands on the confirm's heading, not a button, so a held Enter cannot walk through a stop. Keep it and confirm return to the Stop button. A card filed under Settled claims focus as it remounts. |
| Answering in the thread removed the card, and a 409 there said nothing | `threadQuestions` keeps a question this page answered, so the answer and "Already answered" both show. |
| A settled card said its evidence had not loaded, permanently | Needs you reads the evidence of the settled cards on show, each once and one at a time. A failed read offers Retry, and a card with none served says so. `refresh` still rereads only open cards. |
| A time carried no date | `timeLabel` names the day, and the year if it differs, for anything not today. |
| The reset notice outlived a later failure | A failed read withdraws it. |

The sidebar count test now waits for evidence. The flake was the test's: it counted while a card was still `.decision-missing`, which matches neither selector.

### Pending the coordinator's choice

The filter rule for label-only cards is the client side of a decision the verifier left open. It keeps an open card visible, at the cost of showing another repository's card under a filter, with its own repository named on it. The server join in handoff 30 would be the better fix: with a `repoId` on the card, `needInFilter` goes back to `inFilter`. Nothing else depends on the rule.

### Intended test change

`work.screens.playwright.ts` now pins the clock to the fixtures' morning. A date on another day is intended behaviour, so without the pin the baselines and `Last read 10:00` would change at midnight. No assertion and no baseline changed.
