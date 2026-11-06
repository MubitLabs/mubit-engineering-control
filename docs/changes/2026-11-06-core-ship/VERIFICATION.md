# Verification: core ship

Builder's record, on a shared machine: load about 3 for the first runs, 15 to 17 for the last. No real engine ran. `~/.mec` and port 61610 were not touched. Nothing was pushed.

## Full gate, one run

`pnpm check` ran once, on `812300a`, before the later reconcile commits: 45 failed, 3398 passed, 25 skipped, in 11 of 193 files, with 24 `Timeout waiting for worker to respond` errors and 3 unhandled rejections.

| File | Failed in `pnpm check` | Alone, same tree | Cause |
| --- | --- | --- | --- |
| `real-runner` | 3 | 3, the same | A real collision: slot choice shows launchable slots with the runner on or off. Test changed |
| `delivery-flow` | 3 | 1 | A test defect: node's `fetch` needs `x-mec-client`. Fixed. The other 2 did not repeat |
| `attempt-launch` | 6 | 1 | The bootstrap's file stays out of the commit, so `ls-files` is empty. Assertion changed. The other 5 did not repeat |
| `web/delivery-surfaces` | 0, with 3 unhandled rejections | | Its fake client had no `meta`. Fixed |
| `bundle-defaults` | 1 file, hook timeout | 1 timeout, then 18 passed | Intermittent, `fails a package with no workbench` |
| `supervisor` | 4 | 19 passed | Load |
| `attempt-runner` | 5 | 28 passed | Load |
| `live-park` | 4 | 20 passed | Load |
| `engine-registry` | 1 | 53 passed | Load |
| `coordination` | 7 | 18 passed | Load |
| `composition` | 3 | 28 passed | Load |
| `recovery` | 8 | 50 passed | Load here. Also intermittent on a clean `origin/main`, per the coordinator: 2 and 7 failures alone. It stays open |

"Load" means failed in parallel and passed alone once. It is not a proven cause.

## Final tree

A focused parallel run at load 16: 22 failed, 1667 passed, 9 skipped, in `attempt-launch`, `bundle-defaults`, `delivery-flow`, `recovery` and `claude-input`. Each of those files then ran alone at load 10 to 17:

| File | Result |
| --- | --- |
| `claude-input` | 17 passed |
| `bundle-defaults` | 18 passed |
| `delivery-flow` | 7 passed |
| `attempt-launch` | 58 passed |
| `recovery` | 50 passed |

`pnpm -r --parallel typecheck`: no errors. `biome check . --diagnostic-level=error`: no errors.

## Mutants

Every string in `tools/mutants/*.json` matches exactly once: 1100 mutants, 31 stale after the replay, 0 now.

| Spec | Result |
| --- | --- |
| `core-ship.json` | 19 and the 9 question mutants killed, one surviving question mutant fixed by a test; the unfinished-protocol mutant rerun after its line moved, killed |
| The 27 repointed stale mutants | 27 killed |
| `delivery-surfaces.json` | 37 of 37 |
| `meta-visibility.json` | 17 of 17 |
| `core-coordination.json` | 42 of 43; the INVALID one came from an `else`, fixed, and is killed alone |

## Screens

`pnpm --dir apps/web test:screens` under the lock: 1031 passed. `work` and `next` baselines were then regenerated with `--update-snapshots=all`: 61 files changed and 186 passed. `work-conversation-1440-light`, `work-inspector-1024-light` and `needs-1024-light` were viewed: sample data, nothing from a live store. `needs-1024-light` did not change.

## Not proved

- The host-run agreement: it is not on this branch.
- `pnpm check` has not run on the final tree.
- No real engine has run the question turn or the No answer path.
