# M1.2 Repo and canonical identity

## What

A message, the work it starts and that work's tasks belong to one registered repository, or to none (Unassigned).

- **Admission (`packages/meta/src/admission.ts`).** `repoId` is optional on `POST /api/chat/messages` in this PR. Unknown (`unknown_repo`) or crossing (`repo_mismatch`) is a 400 before any write. Crossing covers a reference into another repository, a resent message id and a replayed idempotency key. Absent means Unassigned.
- **Conversation.** The conversation id is the `repoId`. There is no new table; messages carry the field.
- **Pin.** A new work item in a repository gets `pin {repoId, url, profileHash, policyHash, promptRevision}` once. A registry edit never changes it.
- **Canonical tasks.** Planner task ids are local keys (`localKey`). The stored id is a fresh `task_…`, so two plans can both say `task_1`. Dependencies are rewritten to canonical ids inside the commit transaction.
- **Replans (decision #19).** Within one work item a reused key keeps its canonical id, status and creation time. It takes the plan's new objective, dependencies and role. It does not launch again if it has moved on from `ready` or already has an attempt.
- **Plan snapshots.** Each accepted plan writes an immutable `plan/<wi>/<n>` doc in `store.engines`. The work item carries `planRevision`.
- **Isolation.** Routing, the brain's live work and the planner snapshot are per repository, so the tools refuse foreign targets (route, spawn, stop, cancel, read, report). The service also drops any foreign effect in a decision and records `cross_repo_refused`.
- **Unassigned.** Work with no repo plans, records `launch_withheld`, and never launches. A row with no repo that already has tasks or has left planning is read-only: a wake runs no planner and writes nothing to it. An Unassigned planner turn sees only its own work item. There is no backfill.
- **Wakes (correction 7).** A wake inherits the repo of its work item. A wake with no work item, or a missing one, records `wake_unbound` and creates nothing.
- **Spawns.** `spawn_agent` ids are `task_…` rather than `adhoc_…`, which also satisfies `TaskId`. The task inherits the repo.
- **Store guard.** A save whose id another kind already holds throws `DocKindCollisionError`.
- **Reads.** `GET /api/work` and `GET /api/chat/messages` take an optional `repoId` filter. `/api/work` rows show `repoId`.
- **Prompt text.** The planner protocol now says ids are local keys and what reusing one means.

## Why

Every plan said `task_1`, so a second plan overwrote the first plan's task row. Any live work routed every other request to conversation, across what should be separate repositories. Decision #10 makes conversation and history per repository, and #19 settles what a reused key means.

## Compatibility

- **Storage:** no SQL migration. New fields live in existing json docs, and old binaries ignore them.
- **Contracts:** `packages/contracts` is unchanged.
- **Web:** unchanged. It sends no `repoId`, so its chat stays Unassigned until M1.3 adds the selector and makes `repoId` required.

## Intended behaviour changes

- **A message without a `repoId` no longer launches anything.** This includes every message from the current web client until M1.3.
- **`packages/meta/test/service.test.ts`:** tests that expect a launch now send a `repoId`. Tests that read tasks by planner key now look them up by `{workItemId, localKey}`. Every assertion stays; `dependsOn`, `taskId` and `task_id` now expect the canonical id.

## Left for later

- **M1.3:** `repoId` becomes required.
- **M1.4a:** rejection and `#failTurn` still stop any work regardless of state, so a rejected replan stops executing work. The launch handler does not yet recheck the repo. `release` still lifts a hold from the planner.
- **M2.1:** `pin.promptRevision` is `unresolved`, because the bundle revision only exists once a turn runs. Each plan snapshot records the turn's revision when the brain reports one. The base SHA pin (§14) and `AttemptBrief` repo field are M2.1's.
- **M3.1:** reads are full scans. Indexes would be an additive numbered migration needing separate approval.
- **Attach on Unassigned rows:** a message referencing Unassigned work still appends `message_attached` to its stream, as before. The row itself is not written.
