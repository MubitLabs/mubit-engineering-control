# Verification: M1.2 Repo and canonical identity

Base a102313. All runs are local, in the builder's worktree. No real engine, canary, `~/.mec` or live server was used.

## Failing first

`pnpm exec vitest run packages/meta/test/admission.test.ts packages/store/test/store.test.ts apps/desktop/test/server.test.ts`, before any implementation: 31 failed, 23 passed. Observed reasons include:

- `expected [ { id: 'task_1', … } ] to have a length of 2 but got 1`: the overwrite itself.
- `expected 'adhoc_tytt7ow8l' to match /^task_[A-Za-z0-9_-]+$/`.
- `expected 'conversation' to be 'new_work'`: one repo's live work routing another's request.
- `expected [ 'att_2' ] to deeply equal []`: a replan launching a reused key again.
- `expected 'wi_…' to be undefined`: a wake creating work.

## Gate

`pnpm check` on the final code: exit 1, from the one baseline failure only.

| Step | Result |
| --- | --- |
| Typecheck | Passes |
| `biome check .` | 324 files, 12 warnings, 1 info, the same warning and info counts as baseline |
| `vitest run` | 1627 tests: 1610 passed, 1 failed, 16 skipped |
| The failure | `apps/desktop/test/login-cards.test.ts > drives a real interactive shell through the seam`, the known environment problem |

`pnpm test:screens` was not run: no web file changed.

## Mutants

Applied by hand, since `tools/mutants/run.py` is not on this base. Each patched one string, ran the named test files with vitest's JSON reporter, and counted KILLED only on `numFailedTests > 0`. Every file was restored afterwards. 21 of 21 killed on the final code.

| Mutant | Failed tests |
| --- | --- |
| Routing repo filter removed (service) | 8 |
| Routing repo filter removed (server) | 2 |
| Local key used as the id | 1 |
| Dependency rewrite skipped | 2 |
| Kind guard dropped | 1 |
| Planner reaches across repos (context scope removed) | 2 |
| Service fence removed | 1 |
| Replan resets status | 3 |
| Replan mints a new id for a reused key | 4 |
| Reused key with an attempt relaunches | 1 |
| Reused non-ready key relaunches | 1 |
| Unassigned launches | 1 |
| Wake past a missing work item | 1 |
| Legacy row writable | 1 |
| Pin rewritten by a replan | 1 |
| Unknown repo admitted | 3 |
| Crossing reference admitted | 2 |
| Repo check skipped for key-shaped text | 1 |
| Idempotency replay ignores the repo | 1 |
| Spawn mints `adhoc_` ids | 1 |
| `report_result` reaches any work item | 1 |

"Reused non-ready key relaunches" survived the first run. The attempt check was hiding it, so `a replan does not launch a cancelled key that never had an attempt` was added, and it is killed.

## Kind guard

`SqliteStore` ids have a fixed shape per collection, and the source's `save` calls were listed by repository: `repo_`, `settings/`, `plan/` and `question/` in engines, and `wi_`, `task_`, `att_`, `msg_`, `conf_` elsewhere. No source path saving one id through two repositories was found. That was a source reading, plus the suite staying green; `release.ts` `flow.id` and the slot ids were not traced to their prefixes, and the guard was not run against a real store's existing rows. `MemoryRepositories` keeps separate maps, so it has no such collision and no guard.
