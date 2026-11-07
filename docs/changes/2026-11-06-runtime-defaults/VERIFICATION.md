# Runtime defaults: verification

Base `origin/main` at `07000f2`, on macOS. No verifier or review, by the owner's order: focused tests and mutants, and CI is the gate. The capacity fix's own evidence is in `docs/changes/2026-11-06-hold-capacity-stuck-group/VERIFICATION.md`.

## Failing first

Real runner, before the change:

```text
pnpm exec vitest run --project b apps/desktop/test/attempt-launch.test.ts -t 'no flag at all'
with no flag at all a launch is real: Error: attempt settled failed: no_runner

pnpm exec vitest run --project b apps/desktop/test/real-runner.test.ts
TypeError: realRunnerOn is not a function (7 failed, 4 passed)
```

`pr_ready`, before the change:

```text
pnpm exec vitest run --project b apps/desktop/test/delivery.test.ts -t 'going ready'
AssertionError: expected [] to deeply equal [ 'ready' ]
```

After: `real-runner.test.ts`, `attempt-launch.test.ts`, `composition.test.ts` and `delivery.test.ts` pass.

## Mutants

`python3 tools/mutants/run.py tools/mutants/real-runner-default.json`: 9 of 9 killed. That run first requires the unmutated tests green.

| Mutant | Verdict |
| --- | --- |
| the default is off again | killed |
| zero no longer turns it off | killed |
| the fake flag no longer wins | killed |
| the planner keeps the old default | killed |
| the server keeps the old default | killed |
| going ready does not reach the work stream | killed |
| every ready pass tells the page again | killed |
| the page is told before the stage moves | killed |
| the event lands on the wrong stream | killed |

A tenth, `the server ignores the fake flag` (`realRunnerOn()` in `composition.ts` replaced by `MEC_REAL_RUNNER !== '0'`), survived and is not in the spec. Under `MEC_FAKE_ENGINE=1` the launch and resume handlers return before they ask for the launcher, so no launch differs. What differs is that a `Delivery` and slot probing would exist under the fake flag, and no test looks at that. The rule itself is covered by the unit mutants above.

`tools/mutants/m2.1.json`'s `launch unbound by flag` was updated to the new line and was not run.

## Journey

`pnpm --dir apps/web exec playwright test --config playwright.journey.config.ts`, fake CLI, built from this tree:

| Test | Run 1 (mutants running at once) | Run 2 | Run 3 |
| --- | --- | --- | --- |
| one request reaches a tested PR | pass | fail | pass |
| a server killed during pr create | pass | fail | pass |
| a delivery ready for review, at the 5 s bound | fail | pass | pass |
| declining keeps the local result | pass | fail | fail |
| hold survives restart | fail | fail | pass |
| stop launches nothing later | fail | fail | pass |
| an approve made offline is not spent | fail | fail | pass |

Every test passed in at least one run, and the 5 s bound passed twice. No single run was all green. The failures were `no server in 60 s`, `engine_missing` from the slot probe, and a push card that never came. See the next section.

## The machine, and `pnpm check`

`pnpm typecheck` and `pnpm lint` pass. Lint's warnings include `heldLook` at `composition.ts:431`, a false positive, and an unused import in `serve.ts` from before this work.

`pnpm check` was stopped by hand, with 37 failures so far and nearly all at a timeout. `syspolicyd` and `CoreServices` were using 80-150 % CPU, and the first exec of a fresh two-line shell script took 79.81 s, then 2.93 s and 0.44 s. The first failures were on spawn-heavy tests, such as `pid file never appeared`.

A focused run of `delivery-flow`, `coordination`, `recovery`, `engine-registry` and `supervisor` gave 135 passed and 9 failed with two workers. Each of the 9 then passed serially on this tree: `supervisor.test.ts` 19 of 19, and the other five failures' names, 6 tests.

So there is no full green `pnpm check` for this branch. CI is the gate for it.

## Not proven

- A real engine launching with no flag at all: the default is proven on the fake CLI, and no real engine ran.
- An installed package. Nothing was packed or installed.
