# Verification: core ship

Builder's record, on a shared machine: load about 3 for the first runs, 15 to 22 for the last. No real engine ran. `~/.mec` and port 61610 were not touched. Nothing was pushed.

## Final tree

`pnpm check`, once, at load 19: exit 1. 54 failed, 3319 passed, 16 skipped, in 13 of 198 files. Under that load the vitest pool also failed to start 23 test files, so the run did not cover them.

| Set | Alone, one at a time, load 14 to 22 |
| --- | --- |
| The 13 files that failed | All passed, 325 tests: `approval-key` 16, `attempt-launch` 58, `bundle-defaults` 18, `coordination` 18, `delivery-flow` 7, `engine-registry` 53, `host-run-agreement` 20, `loopback-probe` 11, `recovery` 51, `claude-input` 17, `attempt-runner` 28, `codex-client` 18, `shims` 10 |
| The 23 files the pool never started | All passed, 445 tests |

So no failure repeated alone, but the whole suite has not passed in one run. Load is the likely cause, not a proven one. `pnpm check` has not passed clean on this branch.

`pnpm -r --parallel typecheck`: no errors. `biome check . --diagnostic-level=error`: no errors.

Fake journey (`playwright.journey.config.ts`, with `--approval-key-fd`, scratch `HOME` and data dir): 7 passed. The first run failed 2 of 7 because Work showed the delivery label twice; that was a product defect, and it is fixed.

Screens under the lock: 1032 passed. The four `work-inspector` 1024 and 1440 baselines were regenerated after the label fix, and one was viewed.

## Intermittent

| Test | Seen |
| --- | --- |
| `coordination`: the timer's pass places work a slot change freed | Failed alone once (`condition never held`), then passed alone twice |
| `bundle-defaults`: fails a package with no workbench | Timed out twice, passed since |
| `recovery` | Passes alone here. Intermittent on a clean `origin/main`, per the coordinator: 2 and 7 failures alone |

## Earlier full run

`pnpm check` on `812300a`, before the agreement and the review: 45 failed, 3398 passed. Two real collisions came from it: `real-runner`, where slot choice shows launchable slots with the runner on or off, and `attempt-launch`, where a bootstrap's file stays out of the commit. A test defect came from it too: a read from node in `delivery-flow` needs `x-mec-client`.

## Mutants

Every string in `tools/mutants/*.json` matches exactly once.

| Spec | Result |
| --- | --- |
| `core-ship.json`, before the review | 35 killed, 2 survived. Tests added for both; both then killed |
| The review's and neighbouring mutants | 18 of 19 killed. `waiting checks keep their slot` became equivalent: `occupies` and `inUse` already leave an unjudged check out. Retired |
| `host-run-agreement.json` | 45 of 46 killed. `agreeing leaves rows asleep` survived on the wide run; the branch's narrower test and a route test now hold it, killed |
| Repointed after the agreement | 7 of 7 |
| `delivery-surfaces.json` | 37 of 37, before the agreement |
| `meta-visibility.json` | 17 of 17, before the agreement |
| `core-coordination.json` | 42 of 43 before the agreement; the INVALID one is killed alone |

The whole of `core-ship.json` did not run again on the final tree: the mutants named above did.

## Not proved

- No real engine has run the question turn, the No answer path or the agreement.
- The caps at the gates are proved by unit tests and one handler test, not a real four-attempt run.
- The link's failure path has no real `osascript` failure behind it, and the notice's wording has no screen test.
- The capacity gate reads `DEFAULT_CAPS`, as the scheduler does.
