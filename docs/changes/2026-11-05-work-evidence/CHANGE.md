# M3.2 Stage C: the evidence only inspection Stage 2 serves

6 November 2026. Handoff `docs/changes/2026-11-05-meta-agent-journeys/handoffs/31-m3.2-observable-work-ui.md`, Stage C.

## Base

The brief named `feat/inspection-live` as the base and said the dependencies were in it. `feat/work-live` is not: `feat/inspection-live` forked before it, and it holds no `live/events.ts`, `live/inspection.ts`, `api-inspect.ts` or `sse-resume.test.ts`, which Stage C binds to. Stage C therefore starts with a merge of `feat/work-live` (`d13a01a`, no conflicts). Stage C's own work is the commits after that merge, so they can be replayed on whichever tree holds both.

## What

`?ui=next` only. The classic shell, `ui-flag.ts` and the routes are untouched.

- **Activity tab.** Pages of `ActivityItem` for one attempt, through `decodeActivityPage` and `work-model`. Lines are oldest first, each with its detail folded. Several attempts get a chooser, and the latest is followed until one is chosen. `coverage.activity` false reads nothing and says "Not recorded yet".
- **Artifacts.** A check's `artifactRef` and a report's `artifacts[].ref` open in place through `GET /api/inspect/artifacts`, as React text in a `<pre>`. A binary file shows its size only. A 403 and a 404 have their own words.
- **Events.** The next shell's connection asks for `compact=1`. A frame on `attempt:<id>` rereads that attempt's activity if it is on show, and nothing else. Any other frame refreshes as before, because every list reads across work streams. Classic's `api.subscribe` is unchanged.

## Behaviour worth stating

- **Nothing here says what is running.** A line is the record's summary. The tab says lines appear once a step has finished. `Attempt n: <state>` comes from the attempt record, never from a `tool_call`.
- **The tail.** `nextCursor` is null at a stream's end, so new lines cannot be reached from it. The store keeps the cursor of the last page read and rereads that page, applying each `seq` once.
- **A frame during a read waits.** It does not cancel the read, so Show more cannot be lost to a busy attempt. One more read follows.
- **An attempt's stream joins the one connection.** Snapshots serve no attempt cursors, so the cursor comes from the delivery's `cursors`. A stream cut from those stays on the 10 s read. It is never followed from 0, because a stream more than 10,000 behind answers `reset`, and that would loop.
- **On `reset`** the attempt leaves the connection when the new snapshot lands, for the same reason. The next delivery read brings a new cursor.
- **A check's artifact opens under the attempt whose head it ran on**, not the newest attempt.
- **Only a report names artifacts**, and a report whose detail the server cut at 64 KiB names none. Its line still shows.

## Outside the handoff's file table

- `next/Inspector.tsx`: the tab rendered lines only, so paging, the chooser and artifacts need it. It stays props-only.
- `api.ts`: `requestResponse` split out of `request`, because an artifact's body is not always JSON. `request` behaves as before.
- `shell.css`: one labelled block at the end.

## Intended test changes

`inspection-feed.test.ts`: the rig gains `activity` and `artifact`. No assertion moved.

## Costs and risks

- At most one activity read per 250 ms of quiet per attempt, plus one on each refresh.
- One connection reopen when the attempt on show changes.
- Default-off flag. Rollback is a revert.

## Left open

- `/api/inspect/tasks/:id` emits `artifactRef: null` for every stored check document. Only an attempt's own `checks` list can carry one, so check links stay rare until a writer records a ref. The link is proven with that shape, and report artifacts do not depend on it.
- `tools/mutants/release-cards.json` `Approve opens with no evidence` and `repo-workspace.json` `skip the stale-repo guard on work rows` no longer match the source, in `release-cards.ts` (0 matches) and on two lines of `workspace.tsx`. Stage B or earlier caused both, and neither is fixed here.
