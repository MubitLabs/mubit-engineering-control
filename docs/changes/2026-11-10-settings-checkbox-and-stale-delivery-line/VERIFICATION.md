# Verification

Branch `fix/settings-checkbox-and-stale-delivery-line`, base `8584ac1` (0.3.10). The builder ran these checks on 10 November 2026, on a loaded machine (load average about 4.7). No real engine ran and no `MEC_REAL_*` canary was used. `~/.mec/mec.db` was read only, with `sqlite3 -readonly` queries. Nothing was written under `~/.mec`, the installed server on port 61610 was not touched, and nothing was pushed.

## Failing first

- `apps/web/test/ui-evidence.test.ts`, the new test "the checkbox sits on its label’s line at checkbox size, not as a full-width field", run before the CSS: **1 failed, 9 passed**. The failure: `expected '' to contain 'display: flex'`, because no `.field-check` rule existed.
- `apps/web/test/config.screens.playwright.ts`, the new test "screenshots before review: the checkbox sits at the start of its label’s line, at checkbox size", run under `/tmp/mec-screens.lock` (`lockf`) on port 4173 before the CSS: **1 failed, 1 passed**. The failure: `checkbox width: Expected <= 20, Received: 560`.

## Passing after

- `pnpm exec vitest run apps/web/test/ui-evidence.test.ts`: 10 passed.
- The same two Playwright tests, under the lock: 2 passed.
- The whole screen suite, under the lock: `pnpm exec playwright test` in `apps/web`, **1045 passed**, 0 failed, no `--update-snapshots`. No screenshot baseline covers this checkbox.
- `pnpm exec vitest run apps/web`: 35 files, **627 passed**.
- `pnpm typecheck`: every package Done, 0 errors.
- `pnpm exec biome check .`: **0 errors** (150 warnings and 2 infos, none in the files this change touches).
- An after screenshot of the setting in Chromium shows a 16 px checkbox at the start of the line, followed by its words.

## Mutants

`tools/mutants/settings-checkbox-and-stale-delivery-line.json`, run against committed files:

- `python3 tools/mutants/run.py tools/mutants/settings-checkbox-and-stale-delivery-line.json`: **5 of 5 killed** (the label loses `field-check`; the row is a grid again; the box takes the field width; the box keeps the 36 px minimum height; the `.field-check input` rule is dropped).
- `--self-check`: the no-op SURVIVED and the syntax error was INVALID, as expected. The first mutant's `find` sits inside the JSX tag so the self-check's appended `((((` breaks the module. In an earlier order, with a CSS mutant first, the syntax error SURVIVED, since a test reads CSS as text. With the find in JSX text, the self-check came back KILLED. Both orders were fixed before this run.

## Part 2: what was checked, and no change made

Read-only queries of `~/.mec/mec.db` (`docs` and `events`, work item `wi_…597y`; identifiers shortened here):

- The `work:` stream has 45 events. The last are `pr_ready` (seq 44, 2026-11-10 00:02:15 UTC) and then `work_blocked` with reason `integration: git rev-parse timed out after 60000 ms` (seq 45, 10:28:28 UTC). No `retry_requested` event exists.
- The work item doc: `state: 'blocked'`, `blockedReason` the same text.
- `delivery/…`: `stage: 'ready'`, PR #10, `ci: 'green'`, `ciAt` 10:27:06, `pollAt` 10:27:34. It has not been polled since.
- `integration/…`: no `failed`. The combined checks passed on head `56a1bd2`, the same head as the delivery.

So the failure line reports a block that is current. The brief's sequence (failure, retry, `pr_ready`) does not match this item, and no test was written on it.

## Open

- **Owner decision: should a transient git failure block a delivered item?** Today `Delivery.#pass` blocks on any error, including a 60 s `git` timeout under load on a pass that had nothing new to integrate. Options, smallest first:
  1. Treat a `git … timed out` error from `#work` as `Later`, so the next pass retries it and the item is not blocked. This changes delivery behaviour, and spec §11 ("never as a loop") and §14 bear on it.
  2. Make the Open work row agree with the store: put `person/blocked` (`state === 'blocked'`) before `person/review` in `STAGE_TABLE`, so a blocked item with a ready PR reads Blocked with Try again, not "Ready for review". This is a §10 stage-order question.
  3. Neither, and the owner presses Try again on the horse tinder item. That is a live action on the installed server, outside this brief.
- Hiding the footer line was not done, because it would hide a real block and the stopped CI polling.
