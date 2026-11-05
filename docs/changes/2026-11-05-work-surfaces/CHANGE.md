# M3.2 Stage A: observable work surfaces, on fixtures

5 November 2026. Handoff `docs/changes/2026-11-05-meta-agent-journeys/handoffs/31-m3.2-observable-work-ui.md`, Stage A. Decisions #10, #11, #20, #22, #36.

## What

Conversation, Work and Needs you, their inspector mapping, search and the glossary, built against typed fixtures. Nothing here reaches the production entry: `NextApp.tsx`, `ui-flag.ts` and `next-boundary.test.ts` are unchanged, and `?ui=next` behaves as it did. Stage B swaps the data source only.

- `apps/web/src/next/inspection-wire.ts`: a types-only copy of the M3.1 wire shape, plus `CardEvidence` and `ChatLine`, because `next/*` cannot import `api.ts`.
- `apps/web/src/inspection-decode.ts`: pure decoders that throw M1.1's `DecodeError`.
- `apps/web/src/next/work-model.ts`: every grouping, count, scope and evidence rule, with no React.
- `WorkView.tsx`, `NeedsView.tsx`, `ConversationView.tsx`, `SearchSheet.tsx`, `GlossarySheet.tsx`: props only.
- `apps/web/test/fixtures/inspection-fixtures.ts` and `work-harness.*`: fixture, decoder, model, components. Every title carries `SAMPLE-ONLY`, and `shell-split.test.ts` proves no asset holds that string.

## Behaviour worth stating

- **Groups.** §18.3's six, by the served stage: an ended state or `ended*` key, then a `held` key, then `waitingOn: person` (Open, §18.2), then `state: held`, then `queued`, then waiting, then working. An unknown key lands by `waitingOn` and keeps its label. Classic's mistakes are gone: held and dropped are not Working, a blocked item shows its own label, and quota comes from the stage, never from `parked`.
- **Open questions (#36).** One question record shows in the thread and on Needs you and settles once. Needs order is tasks not yet finished in the delivery, then oldest first; a card has only `expiresAt` to age by. The glossary is added as a small sheet. §18's stage groups are used in the new list form.
- **Approved is not executed.** A stored `approved` card says the answer is recorded and nothing about the result. `describeApproval`'s words settle a card only when `closes` is true; a hold keeps it open and names why.
- **Stop** reuses `Approval`, so its two steps and disarm are the existing ones. Hold and lift are one click.
- **Counts.** `needsList` returns the list and its count from one array, and `null` unless the last read succeeded. Kept content from a failed read is shown as stale and does not produce a count.

## Outside the handoff's file table

Two additions, both additive and neither listed:

1. `apps/web/src/next/Inspector.tsx`: an optional `technical` field on `InspectorScope`, rendered as a folded `<details>` on Overview. Requirement 3 needs internal ids folded, and the scope had nowhere to put them. No other handoff owns this file.
2. `apps/web/src/next/GlossarySheet.tsx`: the (?) button. It sits in each view's `PageHeader` action, so `Toolbar.tsx` gains only the one `search` prop the table allows.

## Assumptions Stage B must check

M3.1 is not on `origin/main`, so these are unproven until `inspection-contract.test.ts` exists:

- Stage keys. The handoff fixes `key: string`, not its values. Fixtures use the §10 row names (`person/decision`, `held`, `waiting/quota`, `working/queued`) and `ended/*`. The grouping matches on `held` and `queued` as substrings and on the `ended` prefix.
- `/api/inspect/needs` and `/api/inspect/search` are decoded as `Page<T>`. The wire block types their items, not their envelope.

## Left for Stage B

Live fetches, the `sse-resume` tests and the `reopen uses the original after` mutant, and M1.4's routes behind hold, lift and stop. `shell-split.test.ts` refuses `/api/` in the entry chunk today, and `inspection-decode.ts` holds such paths, so that assertion will need an intended change when this reaches the entry.

`describeApproval` has no `denied` branch: `{status: 'denied'}` falls through to "Approved". `work-model.ts` exports `DENIED` for a deny, and Stage B must use it. Changing `describeApproval` is out of scope here.

## Risks

Default-off flag and no entry import, so nothing here can affect a running install. Rollback is a revert.
