# M3.1 Stage 1: Canonical inspection queries

## What

Read-only, bounded `GET /api/inspect/*` routes. A client can read any repository's work, tasks, open decisions and search results through keyset pages. No SQL migration, no change to `packages/contracts`, and the existing routes keep their shapes.

- **Store reads (`packages/store/src/inspection.ts`).** `InspectionReads`, built from `SqliteStore.db`. Documents page by `WHERE kind = ? AND rowid > ? ORDER BY rowid LIMIT ?` (newest first with `rowid <`), events by `(stream, seq)`. The plan on the current schema is `SEARCH docs USING INDEX doc_kind_idx (kind=? AND rowid>?)` in both directions, and a test pins it. Helpers read a kind by a JSON field, count by status without loading docs, search text with escaped wildcards, give event cursors and last event times, and run reads in one consistent transaction. `getDoc(kind, id)` exists because `Repository.get` answers any kind's id.
- **Bounds.** Default limit 50, maximum 100 (a larger request is held to 100), and a page ends early at 1 MiB with a valid cursor. The cursor is opaque base64url of `{v:1,r:<rowid>}`. A malformed cursor or limit is a 400 before any query.
- **One stage from facts (`packages/domain/src/stages.ts`).** The spec §10 table in the spec's order, with its labels: decision, login, review, blocked or failed, held, quota, queued, idle, Working. `stageOf` now returns `{key, label, waitingOn}`. An ended item shows its outcome (merged, done, closed, stopped by you, dropped). A fact that is not recorded (a report, a login failure, queue capacity) is absent from the view and cannot match its row.
- **DTOs and joins (`apps/desktop/src/inspection.ts`).** The wire shapes of handoff 30. Title is the stored one, else the first line of the origin message, redacted and cut to 80, else `null`. A row with no `repoId` is `repoId: null`, `repoLabel: null`, `readOnly: true`. A card joins to work only through a stored `workItemId` or a `mandateId` a work item carries; a release card's payload repo is shown as a label and its `repoId`, when present, attributes the repository, never the work. Never a branch name. `needsCount` and the `needs` list come from the same `openNeeds()`. An unrecorded record is `null`, `[]` or `coverage: false`. Checks and diff are served only for the exact head the latest attempt names.
- **Redaction.** Every string in every response passes through `redact(text, [], [])` from `@mec/slots` on the way out, and any text that is cut is redacted first so a cut cannot leave half a key.
- **Wiring.** One optional `ServerDeps.inspection`, one import and one block appended after `/api/prompts/changes` in `server.ts`; one field in the `buildServer` call in `composition.ts`; one export block in `packages/store/src/index.ts`.
- **Docs.** The routes are in `docs/reference.md`.

## Intended behaviour change

`packages/domain/test/stages.test.ts` pinned the old order (`held` first, a 12 row table of lowercase labels). The spec puts the person stages before `held`, so the test is rewritten to the spec: `matches the reviewed order of stages` became `matches the spec order of stages (§10)`, and `held outranks questions, confirmations and blocked` became its opposite (`a pending confirmation outranks a hold`, `an open question outranks a hold`). `stageOf` had no production caller, so nothing else moves.

## Decisions made inside the brief

- **A work item whose own state is `blocked`** maps to the person/blocked row ("Blocked"). The spec words that row by report ("the latest report is blocked or failed"), but §10's states table has `blocked` as a parked state that needs a person, and no report is recorded yet. Easy to drop if the owner wants reports only.
- **Open needs are capped at 200** per kind, not paged: an open set is small (cards expire, questions get answered). `needsCount` is the length of the same list. A pending card past its `expiresAt` reads as `expired` and is not counted.
- **`needs` has no cursor** (`nextCursor` is always null) for that reason.
- **Snapshot cursors** cover `repositories` and the newest 100 `work:<id>` streams in scope.
- **Reset time** in the quota label is shown in the server's local time (it is the user's own machine).

## Not done, on purpose

- **Stage 2** (trace access, read gate, bounded events, liveness, accounting, one stage in chat, attempt-id search).
- **A write-side redaction fix.** Only `POST /api/chat/messages` and the release cards redact before write, and `packages/meta/src` has no `redact` call, so planner-written task text reaches the store unfiltered. This PR is a second line at the boundary, not the fix.
- **The `#appendEvent` whole-stream read** (`service.ts`): unowned hot-file write path.
- **Any index or generated column** (see VERIFICATION.md, the migration trip wire).

## Compatibility

- **Storage:** no migration; reads only.
- **Contracts:** unchanged.
- **Web:** unchanged; the routes are additive and `31` builds against the wire shape.
