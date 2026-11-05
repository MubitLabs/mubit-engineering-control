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

`pnpm check` at the second fix round: typecheck passes, `biome check .` passes, then `vitest run`: 1852 tests, 1836 passed, 1 failed, 15 skipped (136 files: 129 passed, 1 failed, 6 skipped). The one failure is the known baseline `apps/desktop/test/login-cards.test.ts > drives a real interactive shell through the seam (no vendor command)` (`posix_spawnp failed`, the node-pty execute bit). `pnpm test:screens` was not run: no web file changed.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.1-queries.json`: 30 of 30 killed at the second fix round (exit 0; 51 of 51 at the final fix round, below), and `--self-check` gave SURVIVED for the no-op and INVALID for the syntax error, as it should.

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
| stop the open walk at 200 | KILLED |
| needs never returns a cursor | KILLED |
| recent ignores its repo scope (was: recent filters by repo after the cap) | KILLED |
| diff files uncapped | KILLED |
| checks uncapped | KILLED |
| attempts uncapped | KILLED |
| needs page ignores the byte cap | KILLED |
| needs cursor loses a row | KILLED |
| needs cursor ignores the rowid | KILLED |
| recent keyset ignored | KILLED |
| recent cursor loses its phase | KILLED |
| recent rows not merged newest first | KILLED |
| open rows not merged by rowid | KILLED |
| dependsOn uncapped | KILLED |
| cursors uncapped | KILLED |
| tasks truncated count dropped | KILLED |
| list byte budget ignored | KILLED |
| card cls uncut | KILLED |
| card payload repo uncut | KILLED |
| card expiry uncut | KILLED |
| work scalars uncut | KILLED |
| cursor phase unchecked | KILLED |

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

Failing tests first (5 red): 230 heavy open questions paged under 1 MiB at 50 rows; a fresh beta question behind 235 older ones; 200 expired cards plus one fresh; recent needs scoped to a repository; a 20,000-file task under 1 MiB. Then green. Open needs now walk the whole pending set.

## Second fix round

**Correction.** The first fix wave said the needs byte-cap mutant was equivalent because one need item is at most about 6.5 KB. That was false. The cuts alone allow 8,000 characters in a question, its options and its answer, a character can take 3 bytes in UTF-8 or 6 as a JSON escape, and a card's `cls` and `payload.repo` were not cut at all, so one card could exceed 1 MiB alone. The byte cap is live, and its mutant is back and killed.

Failing tests first: 13 red, each for the expected reason. responses over 1 MiB on `tasks/:id`, `work/:id`, `work` and `needs` (the seven size failures ranged from 1.86 MB to 116 MB), missing truncated counts, a row skipped after an earlier one was answered, a recent row skipped after a newer one settled, questions and cards not sharing one order, a newer card pushed out by settled questions, one oversized card over 1 MiB, and an unknown cursor phase accepted. Then green. Two new tests passed before the fix because they pin behaviour that already held: `100 cards with long wide cls` (it exists to kill the byte-cap mutant) and `recent=1 pages the open rows`. Sizes are `Buffer.byteLength`; the older tests' `res.body.length` counts UTF-16 units, not bytes.

**Mutant run.** The first run was 27 of 30: three cursor mutants showed SURVIVED. Applying one by hand showed why: the mutant made a cursor repeat forever, the test's page loop never ended, and vitest stopped with 7 tests pending, 0 failed, and exit 1. The tests were not passing. Both page loops in the test file now fail past 50 pages, and all three are killed. `tools/mutants/run.py` reads pending tests with zero failures as SURVIVED; that is safe, since it never reads as killed, but it is misleading. The runner is unchanged here.

## Final fix round

**Correction.** The second fix round and CHANGE.md said the cuts and budgets hold every response to 1 MiB. They do not: `repositories[].id` and other fields are served whole, so a snapshot with one oversized repository id went out at over 1 MiB with a 200. The ceiling is now one check in `serve`.

Failing tests first: 10 red, each for the expected reason. A 1.2 MB answer of 400,000 wide characters served with a 200; an answer one byte over the limit not refused; `repositoriesTruncated` undefined; `done24` ahead of a just-answered old question; the same with 2,100 newer rows; questions and cards in rowid order, not settle order; a walk of 15 instead of 20 when five rows settled mid-walk; a row served as open then served again in the recent phase; a recent cursor with no settle key; and in the store, a cursor that dropped `t` and `n`. Then green. `a key-shaped settle time cannot leave through the recent cursor` passed before the fix because there was no time in the cursor; it pins the change and kills `settle time leaves unredacted`.

**The cap stays 20 per walk.** Applied before a plain cap of 20, the cursor lets every page offer 20 more, so a walk would serve all the settled rows; the existing `recent=1 pages` test pins 20, and the mutant `recent cap is per page` proves it fails. The recent cursor therefore carries `n`, the rows the walk has served, and each page's room is `20 - n`. The existing tests are unchanged.

**Mutant run.** 21 added, 5 repointed at the rewritten lines (`recent filters by repo after the cap` became `recent ignores its repo scope`, since the check moved). The first run was 46 of 51, and all five were test gaps: the 2,100-row test's old row sat on the first page of the now ascending walk, so a walk that stopped early still found it; the settled card's time and the lapsed card's expiry sat in the same order as the `createdAt` fallback; and a spent cursor had too few rows left to show a negative slice. The tests were tightened and the run is 51 of 51 (exit 0).

**`pnpm check`:** typecheck and lint clean; 1,847 tests passed, 15 skipped, 1 failed: `login-cards` "drives a real interactive shell through the seam", the one permitted failure, pre-existing and unrelated.

**Cost of `recent=1`.** The whole of both kinds is now read on each `recent=1` request. Measured once on this machine (a throwaway test, Node, real better-sqlite3, in-memory database, every row settled, on `/api/inspect/needs?recent=1`, with plain `/api/inspect/needs` beside it):

| Questions + cards | `recent=1` | plain |
| --- | --- | --- |
| 2,000 + 2,000 | 30 ms | 6 ms |
| 10,000 + 10,000 | 132 ms | 7 ms |
| 50,000 + 50,000 | 667 ms | 36 ms |

A walk repeats that per page, and it runs inside one read transaction per request. By interpolation it crosses the 100 ms bar at about 8,000 of each kind. An index on settle time would be a migration, which this branch's ruling excludes, so it stays an owner question with the one below.

## Trip wire: coordinator ruling for this branch

Add no index, table, column or migration. By that ruling the handoff's own scenario (50,000 task docs, 1,000 work items) is under 100 ms; that scenario was not measured in this record. The over-100 ms numbers above, with 50,000 docs in every kind, stay here as an open owner question. They were not re-measured in the second fix round, which adds no query but does add sizing work to the detail routes.
