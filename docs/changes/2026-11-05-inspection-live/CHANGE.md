# M3.1 Stage 2: Trace access and freshness

Handoff: `docs/changes/2026-11-05-meta-agent-journeys/handoffs/30-m3.1-canonical-inspection.md`. Base: local `feat/m2.3-delivery`, by coordinator waiver. It holds M2.1 to M2.3 unmerged and does not hold #37 to #43 from `origin/main`.

## What

A client can go from a task to its attempts, exact-head checks, redacted activity and artifacts, stay current over one bounded connection, and tell a dead server from a quiet one. A clean process exit is never counted as delivered.

- **Read gate (`apps/desktop/src/inspection.ts`).** Every `/api/inspect/*` route has a `preHandler`: `Host` must be loopback, and a browser-shaped request must send `x-mec-client: 1`. `/api/events` checks `Host` only, because `EventSource` can't set a header. The global hook is unchanged.
- **Evidence.** The routes read what M2.1 to M2.3 wrote: `head_sha`, `base_sha`, `resolved_model`, `exit_reason`, `check/<attempt>/<name>` and `delivery/<work>`. The Stage 1 camelCase reads stay as a fallback, because the Stage 1 tests seed that shape.
- **Activity.** `GET /api/inspect/attempts/:id/activity`, allow-listed to the ten contract event types.
- **Artifacts.** `GET /api/inspect/artifacts`, under the attempt's pinned worktree only, by real path.
- **Bounded events.** At most 100 events per stream per pass, nothing while the socket pushes back, `compact=1`, one `event: reset` past 10,000 events behind, and redacted bodies. The store's tail read is now paged, so a flush no longer reads a whole stream.
- **Liveness.** `health.json` gains `instanceId`, `pid` and `heartbeatAt`, and is rewritten every tick by rename. `mec status` reads a missing, stale or future heartbeat as `not answering`, exit 1. `buildHealthSnapshot` gains `observedAt`.
- **Accounting (`packages/scorecards`).** `costUsd` and `spend` are one calculation, tokens are mode-aware, and a replayed event counts once. `spendCoverage` labels a subtotal. `validation` and `delivery` are separate from `result`.
- **One stage.** `workViewOf` in `packages/domain` is the one view of a work doc. `context.ts` and the inspector both use it.
- **Search** gains attempt ids and the merged delivery shapes.

## Intended behaviour changes

- **A snapshot with no heartbeat is `not answering`.** The handoff asks for this. `status.test.ts` and `mec.test.ts` seeded boards with no heartbeat and expected healthy, so their helpers now add a fresh one. An older server's file reads as not answering until it restarts.
- **`RoleSummary.completed` and `failed` became `processCompleted` and `processFailed`,** with a new `validated`. `aggregate.test.ts` follows the rename. No production code reads them.
- **`TierCell.successRate` now reads validation, not a clean exit.** Rows with no checks leave the divisor, and a cell with none has a null rate. The row helper in `tiers.test.ts` now gives each row a validation matching its exit, so the old rates hold.
- **Delta tokens are summed.** They read the last event before.
- **`usage` on the task route has a new `coverage` field.** The `toEqual` in `inspection.test.ts` gains it. Additive: the web decoder picks its fields by name.
- **The planner's `stage` is now the §10 label,** not a raw state such as `executing`.

## Decisions made inside the brief

- **Cumulative restart.** `project.test.ts` pins "the freshest running total" across a falling reading, and the handoff asks only not to double count. So `spend` stays the last reading, and a counter that fell makes it a labelled `subtotal`. No arithmetic is invented to rebuild the lost part.
- **`delivered`** needs validation passed on the exact head and a delivery stage of `ready` or `merged`. A failed check is `not-delivered` whatever the stage. No checks on the head is `unknown`.
- **Usage mode.** No attempt stores `usage_mode`. All three adapters declare `cumulative`, so the task route uses that default. If an adapter ever goes delta, the attempt must record its mode.
- **Billing mode** comes from the slot's kind: `*-sub` is subscription, `*-api` is API, and the rest is unknown.
- **`actual.model`** is `resolved_model` only once an engine is pinned. The scheduler writes that field before launch, so a queued attempt has not run it.
- **Skipped checks** show one `not-run` row with the stored note, and `coverage.checks` stays false.
- **Control files.** `.mec/` and `.git` are refused, including through a symlink. The handoff says "allow-listed root"; a token lives under `.mec/`.
- **A page never ends inside a key.** A key cut in two matches no pattern on either page, so the page end moves back to the key's start. It also moves back to a character boundary.
- **Delivery stage mapping.** `moved`, `declined` and `failed` read `local-complete`, the last true place. `no_change`, `dropped` and `closed` read `none`, with any PR number kept.
- **Wake rows** (`msg_wake_*`) are left out of message search in the query, so they can't use up the 20 slots. An exact id finds nothing either.
- **A held reason** reads `Held by you since 09:07`, with the day when it isn't today, in the server's local time. `hold.since` stays exact.
- **`@mec/scorecards`** is a new workspace dependency of `apps/desktop`, three lines of lockfile. No third-party package changed.

## Not recorded by M2, left empty

- **`diff`:** nothing stores one. `diff` stays empty and `coverage.diff` false. A diff could be read from git, but the handoff says to fill from records.
- **`delegation`:** nothing stores parent and child attempts. It stays `[]`.
- **Latest report in the stage:** report docs exist now, but `workViewOf` does not read them, so `person/review` and the report rows of §10 stay unreachable. Reading them is a stage change the handoff doesn't list.

## Known limits

- **Classic shell and `reset`.** The classic `subscribeMerged` has no `reset` listener and can open with `after=0`. On a stream over 10,000 events, native `EventSource` reopens every few seconds, gets `reset` each time, and that shell has no live refresh until `33` removes it. `live/events.ts` on `origin/main` handles `reset`.
- **Artifact redaction has edges.** Artifacts get patterns, slot fingerprints and the attempt's exact token, and no page starts or ends inside one, but the search for a key reaches 4 KiB either side of a cut, so a key-shaped string longer than that can still be cut. The fingerprint sweep is `redact`'s: it only sees a key that ends a run of non-space characters, so `"key"` in quotes is not caught. A key of no known shape and no fingerprint is served as it stands. The other inspection routes stay patterns only, because their records were redacted before they were stored.
- **The write-side gap in `packages/meta`** and the `#appendEvent` stream read stay as the handoff says: unowned, reported.
- **`/api/events` with no `inspection` dep** falls back to a full `events.read`. Only tests build a server that way.
