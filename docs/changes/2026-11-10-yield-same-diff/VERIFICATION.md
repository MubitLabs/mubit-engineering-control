# Verification

Branch `fix/yield-same-diff`, base `b8e6b6a` (0.3.11). The builder ran these checks on 10 November 2026 on a loaded machine, with a load average of 5 to 7.

- No real engine and no `MEC_REAL_*` canary ran.
- `~/.mec/mec.db` was read only, through `sqlite3 -readonly`.
- The bare cache was read only (`git diff --raw`), and one GitHub read was made (`gh api …/pulls/10/files`).
- Nothing under `~/.mec` was written, the installed server was not touched, and nothing was pushed.

## The live premise

- `delivery/wi_mwav…` has `stage: 'dropped'`, `repo: 'MubitLabs/mec-sandbox'`, `yieldTo: 'mec/mw9kvv16/integration'`, and no `yieldPr` or `yieldRule`. The last work event is `delivery_dropped`. The work item is `integrating`.
- Our change, `d59fcce..7083832`: `index.html` (blob `1ba6e23…`, added) and `style.css` (blob `0cd1320…`, added).
- PR #10's files, `gh api repos/MubitLabs/mec-sandbox/pulls/10/files --paginate --jq '.[] | [.filename, .sha, .status] | @json'`, are `app.js`, `index.html` (blob `c3b256b…`) and `style.css` (blob `75dfdf2…`), all added. The output is one JSON array per line, the format `filesOf` parses.
- The paths overlap, but neither blob matches, so the new rule does not yield to PR #10. `7083832` was never pushed, so GitHub cannot report it as contained, and the same-commits check is no as well. On the first delivery pass after upgrade, the record has no `yieldRule`, so it is checked again and goes on to its push card.

## Failing first

Each new or changed test was run before the code it covers and seen failing:

- `packages/integration/test/yield.test.ts`, new `{path, blob}` rule: 2 failed and 6 passed against the old function. The path-only fixture also passed against the old code, because it compared objects by identity, so mutant Y1 below is the real proof for that rule.
- `apps/desktop/test/release.test.ts -t yieldCheck`: **5 failed**, 6 passed. They failed on the new gh reads, the PR number, deletions, the branch fallback and the same commits.
- `apps/desktop/test/delivery.test.ts`: **3 failed**, 89 passed. They failed on the dropped record with `yieldPr`/`yieldRule`/event `prNumber`, the old-rule re-check reaching the push card, and a marked drop not being re-checked.
- `packages/domain/test/stages.test.ts`: **5 failed**, 29 passed. They failed on the table order, the reachability fixture, `deliveryYielded`, the stage, and `yieldedWords`.
- `apps/desktop/test/delivery-surfaces.test.ts -t yielded`: **2 failed**.
- `apps/web/test/ui-evidence.test.ts` and `apps/web/test/delivery-surfaces.test.ts`: **4 failed**, 52 passed. They failed on the caption, both yielded Delivery labels and the link.
- `packages/meta/test/context-stage.test.ts`, the new case: written after the context wiring. Mutants Y8 and Y11 show that it sees both the stage and the delivery fact.

One existing case changed on purpose: in `apps/desktop/test/inspection-trace.test.ts`, the row `['dropped', 'none']` is now `['dropped', 'local-complete']`. That row recorded the fault this change removes. A yielded delivery is complete here and nothing left the machine, so it keeps the last true place, as `declined` and `failed` already do.

## Passing after

- The touched suites, each run alone, all pass:
  - `yield.test.ts`: 8
  - `release.test.ts`: 30
  - `delivery.test.ts`: 92
  - `stages.test.ts`: 34
  - `delivery-surfaces.test.ts` (desktop) together with `context-stage.test.ts`: 63
  - web `ui-evidence.test.ts` together with `delivery-surfaces.test.ts`: 56
  - `delivery-flow.test.ts` together with `server.test.ts`: 73
- `pnpm typecheck`: every package Done, with 0 errors.
- `pnpm exec biome check .`: **0 errors**, 151 warnings and 2 infos. The warnings are the existing `any` and non-null patterns. The touched test files follow the patterns already in them.
- Full `pnpm exec vitest run`, under load: 3847 passed, 50 failed, 19 skipped, in 13 files. **None of the 13 files is one this change touches.** They are timing tests: process groups, pid files, engine clients, and 20 to 60 s timeouts. Run alone, 12 of the 13 files passed: `delivery-flow` and `server` together, then the other 11 together. The exception is `packages/runtime/test/supervisor.test.ts`, which failed a different test on each run, each time a timing wait on a pid file ("pid file never appeared"). That package does not import anything this change touches. This is recorded as pre-existing flakiness under load, separate from this change.

## Mutants

`tools/mutants/yield-same-diff.json`, run against the committed files:

- `python3 tools/mutants/run.py tools/mutants/yield-same-diff.json`: **15 of 15 killed**.
  - Y1: the path-only rule is back.
  - Y2: `containsHead` is ignored.
  - Y3: a diverged head counts as contained.
  - Y4: a removal keeps its blob.
  - Y5: no re-check.
  - Y6: a re-check on every pass.
  - Y7: our blobs are lost.
  - Y8: the stage row never matches.
  - Y9: `dropped` reads `none` on the wire.
  - Y10: the live line is lost.
  - Y11: the planner fact is lost.
  - Y12: the Delivery label is lost.
  - Y13: any repository becomes a link.
  - Y14: the decode drops `yieldedTo`.
  - Y15: the doubled full stop is back.
- `--self-check`: the no-op SURVIVED and the syntax error was INVALID, as expected.

## Not covered by a test

- In `WorkView.tsx`, the call to `screenshotCaption(set)` is a one-line JSX change and has no render test. The caption text is tested on the model function.
- No real GitHub compare ran for a branch, only the PR files read above. The branch path uses the same row filter on `compare/{default}...{branch}`, and the existing code already used that endpoint.
