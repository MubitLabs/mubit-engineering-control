# Verification

Branch `fix/stop-confirm`, base 9385a34. The builder ran these checks on 9 November 2026. No real engine was used. Nothing touched `~/.mec` or the server on port 61610. Nothing was pushed. `pnpm check` was not run, as the brief asked.

## Reproduction

All reproduction runs used `apps/web/test/journey.real.playwright.ts` as an uncommitted probe, on a built tree (`pnpm build:desktop && pnpm --dir apps/web build`). The journey rig provided a scratch HOME and data dir, a fake `claude` and fake `gh`, and a worker scenario `[{init}, {exit: 1}]` that leaves the delivery `blocked`.

| Probe | Result |
| --- | --- |
| Blocked delivery: Stop, arm, confirm at once (locator click, inspector open, raw mouse click) | `POST /api/work/:id/stop` sent each time |
| Blocked delivery, stable in its group: arm, ticks every 500 ms | `data-armed` stayed `true` through a refresh and turned `false` at 8 s. The next press armed again, and `SENT []` (the reported symptom) |
| Stop opened while the row is under Working, then the delivery blocks | The row moved to Open, the section was removed 5 ms after the refresh, and `.decision` count went to 0 (card lost) |
| The same regroup probe after the fix | Groups went from `["Working 1"]` to `["Open 1"]`, the card stayed, the confirm was sent, and the row read Stopped |

## Failing first (`apps/web/test/work-live.screens.playwright.ts`, both new)

| Test | Red on base |
| --- | --- |
| "an open stop survives the row changing group under a refresh, and still stops" | `getByRole('heading', { name: /^Stop / })`: element(s) not found after the regroup |
| "a stop whose confirm lapsed says so, and arming again still stops" | `.armed-note` expected the lapse text, received `""` |

Both pass after the fix. The vitest file `apps/web/test/stop-confirm.test.ts` was written after the pure helpers it tests existed. Its ability to fail is shown by the mutants below, not by a red run on base.

No existing test was changed.

## Mutants

- `python3 tools/mutants/run.py tools/mutants/stop-confirm.json`: 6 of 6 killed.
- `--self-check`: the no-op reported SURVIVED and the syntax error reported INVALID, as expected.
- Run by hand, because the runner only drives vitest:
  - **W2:** dropping `setLapsed(true)` from the timer makes the lapse screens test fail. The file was then restored.
  - **The regroup:** its mutant is the base code itself, which is the red run above.

## Suites

- `vitest run apps/web`: 33 files, 607 passed.
- `tsc --noEmit -p apps/web`: clean.
- `pnpm exec biome check .`: 0 errors. The 138 warnings are all in files this change does not touch.
- `pnpm test:screens` (under `/tmp/mec-screens.lock`): 1039 passed, 0 failed.

## Not verified

- **The user's own store and browser.** This run did not touch the reporter's installed server or Chrome session. The cause there (a press after the 8 s window) is inferred from the reproduction.
- **Selection reset.** Clearing `stopping` when the selection changes and comes back has no test of its own.
