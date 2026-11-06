# M2.3 verification

Builder's evidence only. Behaviour verification, the one real Claude run and the blockers-only review of the `pushTarget` change and the card hook belong to other agents. This builder spent no engine run.

## Gate

| Command | Outcome |
| --- | --- |
| `pnpm typecheck`, `biome check` | clean of errors |
| `pnpm test`, full | 2463 passed, 17 skipped, 11 failed |
| The seven failed files but one, rerun alone with `--pool=forks --maxWorkers=1` | 129 of 129 passed |
| `login-cards.test.ts` "drives a real interactive shell through the seam" | fails, `posix_spawnp`: the pre-existing failure |
| `python3 tools/mutants/run.py tools/mutants/m2.3.json` | first run 36 of 37 killed; see below |
| `python3 tools/mutants/run.py --self-check tools/mutants/m2.3.json` | no-op SURVIVED, syntax error INVALID, as it should |

The full run was on a shared machine with other agents at work. The ten load failures were worker-start and process-start timeouts (`Failed to start forks worker`, `condition never held`), several in packages this change does not touch (`packages/engines`, the `attempt-runner` shim test). A first `pnpm check` also overlapped this builder's own self-check, so it counts for nothing. No green full run was had here: a rerun on a quiet machine should confirm.

`pnpm --dir apps/web test:screens` was not run: nothing under `apps/web` changed.

## Failing first

- `packages/domain/test/{acceptance,work-result,caps}.test.ts`: 21 failed, 9 passed before the source, 30 passed after.
- `packages/integration/test/controller.test.ts`: 8 failed, then 8 passed.
- `packages/meta/test/repair.test.ts`: 9 failed, 2 passed, then all passed. One assertion of mine was wrong and changed: a task with a repair queued is `ready`, because it turns `active` only when the attempt starts.
- `packages/meta/test/check-profiles.test.ts`: 6 failed, 1 passed, then all passed. The test that passed before only proved `made-up` refused, so it now also proves a real name is not refused.
- `apps/desktop/test/delivery.test.ts`: failed to load before `delivery.ts` existed, then green. Tests written after that point, such as the conflict and reviewer flows, passed on their first run, so they have no red of their own. The mutants below are their evidence.
- Pinned profile: failed with `expected { id: 'integration/wi_abcdef12', … } to be undefined`, then passed.

## Mutants

`tools/mutants/m2.3.json`: the handoff's twelve, plus 26 for gates this change added.

The first run, 37 mutants: 36 killed, and `error reads as failed` survived. Without that branch an error still blocked, but as "no verdict", so `error` and a missing verdict could not be told apart. The test now pins the reason. A later commit added the pinned-profile guard. `error reads as failed`, `held work integrates` and the new `delivery ignores the pinned profile` were then run again: 3 of 3 killed. So all 38 have been killed, but the other 35 ran before that last commit, which touched only `Delivery.#work`, `DeliveryDeps` and the composition call. A final full run is the verifier's to take if wanted.

## Through the real server

`apps/desktop/test/delivery-flow.test.ts` runs a real store, queue, processes and git, with the fake CLI, a fake `gh` script first on `PATH`, and a scripted planner:

- Three `integration` tasks, one message: each dependent's `base_sha` is its prerequisite's integrated commit, then a push card, a real push to a local bare repository, then a PR card, and no `pr create`.
- Conflict: a repair task in the integration worktree, the result has two parents, and combined checks pass on that SHA.
- A sensitive task: a `code_reviewer` attempt on the same worktree, integrated only after it.
- Failed checks: a `repair_agent` attempt in the same worktree and branch.

## For the verifier

- The record to read is `delivery/<work>` and `integration/<work>` in `store.engines`, plus events on `work:<id>` and `release:<slug>:<branch>`. `/api/work` does not show the stage yet: that is M3.2.
- A fake CLI step reaches this through `MEC_REAL_RUNNER=1`. With `MEC_FAKE_ENGINE=1` nothing is accepted, so nothing delivers.
- A local path is refused as an origin, so a `file://` remote needs the `insteadOf` arrangement in `delivery-flow.test.ts`: origin `git@github.com:owner/repo.git`, with `url.<bare>.insteadOf` for the https URL in `GIT_CONFIG_GLOBAL`.
- After a declined card, `POST /api/release/push {repoId, branch}` opens the new card, and its answer continues the flow the same way.
- `gh` is read once per 30 s per open PR, so step 5 takes up to that long to move.
- Delivery follows `MEC_REAL_RUNNER=1`, so check that nothing else on the scratch server has a real origin.

## Stops, holds and foreign cards

- An approve reads `cardBlocked` with no await before the settle. Stopped or withdrawn work settles a push, PR or merge card `stale` by policy, reason `mandate_withdrawn`, with `card_withdrawn` on the release stream. Held work leaves it pending, reason `held`. A deny settles as given.
- The card still shows as pending until someone answers it. Nothing at stop time settles it, and it carries no `mandateId`.
- A merge card reaches its work by repository and PR number, so a PR that is not the delivery's own is neither blocked nor recorded as this delivery.
- `onCardSettled` needs `pushCardId`, `prCardId` or `prNumber` to match. A card opened by hand moves no stage.

## What remains for the real `mec-sandbox` pass

- A real `gh pr checks --required` on a repository with required checks, and with none.
- A real push from the bare cache through the user's credential helper, and how soon `git/ref/heads/<branch>` answers afterwards. A miss retries after 30 s.
- A real `mergeStateStatus` after a target branch moves.
- A real model's `ready` report: whether it omits `head_sha` or names the pre-commit head. Both are bound to MEC's commit.
- A real reviewer listing findings as artifacts.

## Owner questions

1. **§15, rounds at the cap.** §15 says that after the cap a task is delivered with material unresolved findings stated. The handoff says it blocks with what remains, and this follows the handoff. Recommendation: keep the block for sensitive tasks, the only ones reviewed today, and amend §15 to say so.
2. **§6, a local result is not on the wake list.** It is a note, so the planner speaks of it on its next turn, and the owner's first sign is the push card. Recommendation: leave it until M3.2 shows the stage.
3. **§14, a repair for combined checks.** §14 says a repair worktree starts mid-merge in both cases. A clean merge whose checks failed is already committed, so its repair commits on top. Recommendation: amend §14.
