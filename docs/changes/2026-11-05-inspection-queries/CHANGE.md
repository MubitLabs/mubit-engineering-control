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
- **Open needs are not capped.** The pending set is walked whole by keyset; expiry and repo filters run before any limit, and the work stage and every count read the same uncapped list, so a live need cannot vanish behind older ones. (The earlier 200 cap dropped live needs and turned person stages into Working.) `needsCount` is the length of that list.
- **`needs` is paged by rowid** (`cursor`, `limit` default 50, max 100, 1 MiB), ending early with a valid cursor. Docs share one rowid space, so questions and cards merge into one oldest-first order and the open-phase cursor is exactly `{v:1,r:<rowid>}`. A position cursor skipped a row when the set changed between pages. With `recent=1` the recent items follow the open ones, latest settled first: `answeredAt` or `resolvedAt`, the expiry of a card that lapsed unanswered, else the time asked or created, with rowid as tiebreak. Rowid alone is creation order, so a just-answered old question was missing. The cursor there is `{v:1,r:<rowid>,p:'recent',t:<settle time>,n:<served>}`: `t` and `r` are the stable key, and `n` keeps the cap of 20 on the walk, because the cursor applies before the cap and a per-page cap would serve every settled row. The whole of each kind is read on a `recent=1` request (the 2,000-row scan cap is gone, since an old row can settle today); see VERIFICATION.md for the cost. Scope and cursor both apply before the cap, and the cap applies after questions and cards merge, so twenty settled questions cannot push out a newer card. An item that settles while the walk is still on the open rows can appear again under `recent=1` with its new status: that is new information, not a repeat.
- **Detail lists are bounded.** Task detail: newest 50 attempts, 200 checks, 500 diff files, 100 `dependsOn` ids. Work detail: 200 tasks, and cursors for the work stream plus the newest 200 attempts. A count cap cannot hold bytes (JSON spends up to 6 bytes on a character), so each list also has a byte budget, measured on the JSON that leaves. `attemptsTruncated`, `checks.truncated`, `diff.truncated`, `dependsOnTruncated`, `tasksTruncated` and `cursorsTruncated` count what was left out (additive fields). `tasksTruncated` was not in the wire shape; it was added because the 200 cap on tasks was silent.
- **Oversized strings.** A card's `cls` is cut to 4,000 characters and `payload.repo` to the 80 of any label. Many ids, times, names and states are cut to 200 and `prUrl` to 500. A cut id no longer links; a real id is far shorter than that. These cuts do not cover every field (a repository id, for one, is served whole), so they cannot by themselves hold a response to 1 MiB. Earlier text here said they could; that was false.
- **The hard ceiling is in one place.** `serve` in `apps/desktop/src/inspection.ts` measures `Buffer.byteLength` of the finished JSON and sends those exact bytes, or, over 1,048,576, sends none of them and answers 500 `response_too_large`. Oversized records are pathological and nothing writes them, so one of them makes its route fail loudly rather than each field being chased. The page caps, list budgets and cuts stay as the normal path that keeps real answers well under it.
- **Snapshot cursors** cover `repositories` and the newest 100 `work:<id>` streams in scope.
- **Snapshot repositories** are the oldest 100; `repositoriesTruncated` counts the rest (additive, `0` when nothing was left out).
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
