# Verification

Branch `feat/ui-evidence`, base `3844b0a`. The builder ran these checks on 10 November 2026, on a heavily loaded machine (load average 5 to 6, with other sessions' mutant runs alongside). No real engine ran and no `MEC_REAL_*` canary was used. Nothing touched `~/.mec`, the installed server on port 61610 or MubitLabs/mec-sandbox. Nothing was pushed. Every capture test uses real git, a real loopback server and real Chromium (Playwright's `chromium-1248`, from `playwright-core` 1.64.1).

## Failing first

- `packages/domain/test/ui-evidence.test.ts`, written before `ui-evidence.ts` and the acceptance and stage changes: **18 failed, 5 passed**. The 5 that passed were the flag-off and red-checks-first tests, which assert behaviour that was already right.
- `packages/meta/test/ui-evidence.test.ts`, run with the scheduler's `uiEvidence` line taken out and before the planner-context fact: **4 failed, 7 passed**. The failures: a user-visible change was accepted with no screenshots ("expected 'accepted' to be 'active'") in three tests, and the planner read `Working`.
- `apps/desktop/test/repository-edit.test.ts`, with the new `UI evidence required` block written before the PATCH and GET changes: **4 failed, 10 passed**.
- Written after the code, and proved instead by the mutants below: `apps/desktop/test/ui-evidence.test.ts` (the capture service on a real repository), `apps/desktop/test/ui-evidence-surfaces.test.ts` (Work, Needs you, the retry route, the PR body) and `apps/web/test/ui-evidence.test.ts`. The first mutant run found 4 survivors, all in tests written after the code: a review attempt judged on itself, a retake that kept the failed capture, one side captured counted as taken, and an encoded `..%2F` out of the served tree. A test was added for each, and one redundant guard in `capturesOf` was removed. The second run killed all 27.

One existing test was extended, not weakened: `packages/domain/test/stages.test.ts` now lists the two new rows (`person/screenshots`, `waiting/screenshots`), with a fixture for each in the table's exhaustiveness check.

## Green

- `packages/domain/test/ui-evidence.test.ts`: 23 passed. Whole `packages/domain`: 232 passed.
- `packages/meta/test/ui-evidence.test.ts`: 12 passed. With `scheduler.test.ts` and `context-stage.test.ts`: 101 passed (before the 12th test was added).
- `apps/desktop/test/ui-evidence.test.ts`: 12 passed, real Chromium. `ui-evidence-surfaces.test.ts`: 6 passed. `repository-edit.test.ts`: 14 passed.
- `apps/web/test/ui-evidence.test.ts`: 9 passed.
- `pnpm test:a` (`vitest run --project a`): **2042 passed, 1 skipped**, 118 files.
- `pnpm test:b` (`vitest run --project b`), full run: 1632 passed, **44 failed**, in 10 spawn-heavy files. The errors were `Test timed out`, `condition never held`, `pid file never appeared` and `[vitest-pool]: Failed to start forks worker`, with files taking 400 to 660 s. Each of the 10 files was rerun alone and passed in full: approval-key 19/19, attempt-launch 60/60, composition 28/28, coordination 18/18, delivery-flow 8/8, engine-registry 62/62, login-cards 17/17, recovery 51/51, runtime attempt-runner 28/28, runtime supervisor 19/19. These failures are attributed to machine load. They are not hidden, and they are not proved to be unrelated beyond those reruns.
- `pnpm typecheck` (`pnpm -r --parallel typecheck`): clean.
- `biome check .`: **0 errors**. The 150 warnings are mostly existing ones; the three new ones are `noExplicitAny` in `ui-evidence-surfaces.test.ts`, the same pattern as `delivery-surfaces.test.ts`.
- Web screens, under `/tmp/mec-screens.lock` (`lockf`), port 4173: `pnpm exec playwright test` in `apps/web`, **1044 passed**, 0 failed, no `--update-snapshots`. This includes the new `config.screens` test "screenshots before review: off by default, turned on in plain words, and saved".
- `pnpm build:desktop`: bundles, with `playwright-core` external (a single `import('playwright-core')` reference in `dist/mec.mjs`).

## Mutants

`python3 tools/mutants/run.py --self-check tools/mutants/ui-evidence.json`: the no-op SURVIVED and the syntax error was INVALID, as expected (exit 0).

`python3 tools/mutants/run.py tools/mutants/ui-evidence.json`: **27 of 27 killed**. They cover:

- acceptance: the evidence ignored, waiting read as accepted, could-not read as a pass;
- the verdict: another commit's capture counted, after-only counted, every change user-visible;
- the globs: `*` crossing directories, a prefix match;
- the scheduler dropping the input; the flag ignored; a review judged on itself; a retake keeping the failed capture; waiting outranking could-not; the could-not stage matching waiting;
- the flag joining the pinned profile; the stale-edit base ignoring it; the PATCH dropping it;
- one side counted as taken; the page reaching other origins; the static server serving outside its tree; a PNG the record doesn't name being served;
- no retry offer; a retry that retakes nothing; Work not reading the fact; the PR body leaving it out;
- the web decoder loading any image URL; a save dropping the repository's globs.

## Not run

- `pnpm pack:internal` and `scripts/smoke-package.mjs`. The tarball's `package.json` now lists `playwright-core`, but the install of it was not exercised.
- No live proof. The open items in the report say what one on mec-sandbox should look like.
