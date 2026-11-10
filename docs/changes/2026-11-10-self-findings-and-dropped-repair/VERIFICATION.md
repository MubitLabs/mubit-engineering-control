# Verification

Branch `fix/self-findings-and-dropped-repair`, base 8584ac1 (v0.3.10). The builder ran all of this on 10 November 2026.

- `~/.mec/mec.db` was read only, with `sqlite3 -readonly`. Nothing was written under `~/.mec`, and nothing touched the server on 61610.
- No credential was read. No real engine ran (no `MEC_REAL_*`). Nothing was pushed.

## The failure, from the store (read only)

`sqlite3 -readonly ~/.mec/mec.db "select id,json from docs where id like 'report/att_16%' or id like 'report/att_17%' or id in ('att_16','att_17', '<task>', '<work>')"`, plus the `work:`, `attempt:att_16` and `attempt:att_17` event streams:

| Record | What it holds |
| --- | --- |
| `att_16` | role `implementer`, state `succeeded`, head `da335fc…`, checks `npm-test` |
| `report/att_16/1` | `kind: ready`, artifacts: two of kind `finding`, each describing a file it made |
| `att_17` | role `repair_agent`, continuation `{ kind: repair, evidence: "Finding on da335fc…: index.html — new home page markup …" }`, state `succeeded`, head `da335fc…` |
| `report/att_17/1` | `kind: dropped`, "Neither finding reproduces as a defect. …" |
| task | status `cancelled`, `cancelledReason: "attempt att_17 dropped it: …"` |
| work item | state `reviewing` |
| `work:` stream, last event | `task_cancelled` (attemptId att_17) |

No attempt with a `review` continuation or a reviewing role exists for this task.

## Red, then green

`pnpm exec vitest run packages/meta/test/repair.test.ts`, with the new tests and no fix: **5 failed, 32 passed (37)**.

- the implementer's own finding artifacts start no repair: `expected [ { id: 'att_2', … } ] to deeply equal []` (a repair was queued)
- the live replay: `expected { … } to match object { status: 'accepted', … }` (cancelled)
- declined with one factual sentence: same, cancelled
- sensitive work, declined repair: `expected 'cancelled' not to be 'cancelled'`
- every task ended: `expected 'reviewing' to be 'blocked'`

The other 4 new tests pass before the fix, as they should: they pin what already held (a planned reviewer still finds, a fixed finding stays fixed, an implementer's own `dropped` still cancels, and work with an attempt still in place waits). After the fix: **38 passed (38)**, including one more test added for the per-review ordering.

- `apps/desktop/test/inspection.test.ts -t "every task ended"`: red, `Expected: "Stop this work and ask again"`, `Received: "Resolve what blocks it"`. Green after.
- `apps/desktop/test/delivery.test.ts -t "finding's line"`: red, `TypeError: findingLine is not a function`. Green after.

## Mutants

`python3 tools/mutants/run.py --self-check tools/mutants/self-findings-and-dropped-repair.json`: the no-op reads SURVIVED and the syntax error reads INVALID, as expected. Then **11 of 11 killed**:

- an implementer's own finding artifacts count as review findings again
- a planned reviewer role no longer finds
- a repair's dropped report cancels the task again
- a declined finding is recorded as fixed
- a declined finding carries the whole summary, not one sentence
- a finding is answered by any repair, not the one after its review
- work whose every task ended is no longer blocked
- work whose every task ended blocks while an attempt still holds its place
- reviewing work whose every task ended is left at reviewing
- the ended block's next action is vague again
- a declined finding's sentence is left out of the pull request body

## Gates and suites

- `pnpm typecheck`: every package Done.
- `npx biome check .`: 0 errors. The 150 warnings and 2 infos are all in files this change does not touch. The touched files report none.
- `pnpm exec vitest run packages/meta packages/domain`: 38 files passed, 1 skipped; **721 passed, 1 skipped (722)**.
- `pnpm exec vitest run apps/desktop`, the whole suite at once (load average 7.1): 44 failed, 972 passed, 2 skipped. Every failure is a time bound: 20 s, 40 s, 60 s or 120 s timeouts, or waits that ran out ("no announce after 40000ms"). They are in 9 files: approval-key, attempt-launch, bundle-defaults, composition, coordination, delivery-flow, engine-registry, recovery and ui-evidence. None of these touches the changed code paths.
- Those 9 files rerun alone, with `--no-file-parallelism`: **9 files passed, 282 passed (282)**.
