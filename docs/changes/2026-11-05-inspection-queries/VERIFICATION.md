# Verification: M3.1 Stage 1 inspection queries

Base: local `feat/repo-identity` (unlanded, coordinator waiver). All runs are local, in the builder's worktree. No real engine, `~/.mec` or live server was used. No separate verifier has run yet: the handoff's verifier steps (two scratch repositories on the built product, restart, 50,000-doc scratch database, counts against SQLite) are still to do.

## Failing first

Each test file was written before its code and run once to see it fail for the right reason.

| Test file | Before | Reason observed |
| --- | --- | --- |
| `packages/store/test/inspection.test.ts` | suite failed to load | `../src/inspection` did not exist |
| the newest-first, dotted-path and `getDoc` additions | 3 of 17 failed | `order: 'desc'` ignored, `mandate.id` refused as a field name, `getDoc` absent |
| `packages/domain/test/stages.test.ts` | 13 of 13 failed | old table: `held` first, string stages, no `key`/`label` |
| `apps/desktop/test/inspection.test.ts` | 17 of 17 failed | `/api/inspect/*` returned the JSON 404, so `items` was undefined |

After the implementation the first full run of the desktop file had 3 failures, all from the build (not weakened tests): a text search for a message id also matched a work item and a task because `Repository.get(id)` answers any kind's id (fixed with `InspectionReads.getDoc(kind, id)`, and the test now also asserts `/work/<message id>` is a 404), a wrong status list in my own `needs?recent=1` expectation, and a byte-cap test that wrongly expected one page.

## Gate

`pnpm check`: typecheck passes, `biome check` clean on the touched files, then `vitest run`: 1832 tests, 1815 passed, 1 failed, 16 skipped. The one failure is the known baseline `apps/desktop/test/login-cards.test.ts > drives a real interactive shell through the seam (no vendor command)` (`posix_spawnp failed`, the node-pty execute bit). `pnpm test:screens` was not run: no web file changed.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.1-queries.json`: 14 of 14 killed after the fix wave (six added: open walk stopped at 200, needs cursor, recent filtered after its cap, and the three task-detail caps).

| Mutant | Verdict |
| --- | --- |
| remove repo predicate | KILLED |
| drop the page limit | KILLED |
| skip cursor validation | KILLED |
| serve task text without redact | KILLED |
| restore held-first stage order | KILLED |
| make a missing record coverage true | KILLED |
| join a card by branch name | KILLED |
| treat absent repoId as readOnly false | KILLED |

## Migration trip wire (100 ms at 50,000 docs): FIRED

Measured once on this machine (Node, real better-sqlite3, in-memory database, run inside vitest), with 50,000 each of work item, task, attempt, message and confirmation docs of about 700 bytes. The measuring test was deleted afterwards; this is the record.

Single store reads:

| Read | Time |
| --- | --- |
| `pageDocs('work_item', {limit: 50})`, with or without a `repoId` predicate | 0.1 ms |
| `countByField('task', 'workItemId', 'status', 50 ids)` | 30 ms |
| `docsByField('attempt', 'workItemId', 50 ids)` | 32 ms |
| `docsByField('task', 'workItemId', 1 id)` | 28 ms |
| `searchDocs('message', ['text'], …)` | 31 ms |
| `lastEventAt(50 streams)` | under 0.1 ms |

Whole routes (two rounds, warm):

| Route | Time |
| --- | --- |
| `work?limit=50`, all or one repo | 99 to 112 ms |
| `work?limit=100` | 103 to 123 ms |
| `work/:id` | 181 to 218 ms |
| `tasks/:id` | 60 to 73 ms |
| `needs`, `needs?recent=1`, `snapshot` | 29 to 43 ms |
| `search` by text, by SHA | 128 to 179 ms |

The keyset itself is instant. The cost is each JSON-field equality (task and attempt by `workItemId`, a pending confirmation by `status`, a text search), which scans the kind at about 30 ms per 50,000 docs. A work page does about three of them; a work detail about six. The handoff says that if any page read exceeds 100 ms at 50,000 docs of its kind, stop and report. Whole-route work pages and details exceed it, searches exceed it, though no single store read does. The fix is an expression index (for example on `json_extract(json,'$.workItemId')` for kinds `task` and `attempt`) and on confirmation `status`, which is a SQL migration and is not authorized here. Nothing was worked around: no table, projection or file was added. The owner decides whether a migration is wanted, or whether 50,000 docs per kind is a realistic target for a local single-user store.

## Not verified

- The verifier steps listed at the top.
- Behaviour on the built product (the tests drive `buildServer` over a real `SqliteStore`, not the packaged binary).
- A restart: the routes keep no state of their own, so links should hold, but it was not run.

## Fix wave

Failing tests first (5 red): 230 heavy open questions paged under 1 MiB at 50 rows; a fresh beta question behind 235 older ones; 200 expired cards plus one fresh; recent needs scoped to a repository; a 20,000-file task under 1 MiB. Then green. The migration trip wire stays fired and awaits the owner decision: approve the expression-index migration, or rule that 50,000 per kind is not a target. Open needs now walk the whole pending set, which is the cost that decision bears on.

The needs byte-cap mutant (drop the 1 MiB break) survives and is an equivalent mutant today: one need item is at most about 6.5 KB, so 100 rows never reach 1 MiB. The byte guard stays as defence against a future larger item; the 230-heavy-question test proves the row limit and cursor.
