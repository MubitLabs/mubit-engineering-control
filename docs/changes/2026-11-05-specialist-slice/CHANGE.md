# M2.1: Real specialist vertical slice

Handoff: `docs/changes/2026-11-05-meta-agent-journeys/handoffs/20-m2.1-real-specialist-slice.md`. Base: `feat/durable-commands` at `5be0ef8`, a local branch, by coordinator waiver.

## What it does

With `MEC_REAL_RUNNER=1`, a launch effect starts one Claude specialist on a registered repo. The attempt runs in its own worktree under a real journal, reports through scoped tools, and ends with a commit, a head SHA and repo check results on that SHA. With the flag off nothing changes from M1.4b: the attempt fails with `no_runner`, the work blocks with that reason and no process starts. `MEC_FAKE_ENGINE=1` keeps priority.

## Design

- **`AttemptRunner` (`packages/runtime/src/attempt-runner.ts`)** implements the contracts `Runtime`. It starts the engine, returns, and a monitor owns the attempt, so a long attempt does not hold one of the launch kind's two queue places. `deliver` and `replay` throw `NotWiredError`.
- **The adapter and git are injected.** `@mec/engines` depends on `@mec/runtime`, so the reverse import is a cycle. Domain state stays out of runtime too: the runner reports through `AttemptFacts`, and `StoreFacts` (`apps/desktop/src/core-facts.ts`) moves state only through the machines. A fact the machine has no row for moves nothing, so a stopped attempt's late `session_started` cannot revive it.
- **`AttemptLauncher` (`apps/desktop/src/attempt-launch.ts`)** is the launch order: load and agree, cache, pinned base, worktree, `.mec/` files, bootstrap, model, bundle, gate again, token, env, start. What a brief cannot carry goes to the runner in an `AttemptPlan`.
- **`specialistTools` (`apps/desktop/src/specialist-tools.ts`)** replaces the `onCall` stub. `confirm` answers by rule, so §9's card path is narrowed to deny until M2.2.

## Defects fixed from the handoff

| | Defect | Fix |
| --- | --- | --- |
| a | The engine ran its own shim | `ClaudeAdapterDeps.binary`, resolved from the user's PATH before the attempt's PATH exists |
| b | `ensure` deleted task branches | The remote lives under `refs/remotes/origin/*`; `cachedDefaultTip` reads the base from there |
| c | No process-group ownership | `ownedSpawn` is detached, piped and registered with `Supervisor.adopt`; stop is `Supervisor.stop` |
| d | Events arrived only at exit | `createClaudeEventParser`, with `parseClaudeStream` as its wrapper |
| e | The deny list missed the database | `defaultDenyRead(home, dataDir)` names the real files; the data dir is never denied whole |
| f | A specialist could commit its token | `.mec/*` in the common `info/exclude`, and `historyTouches` fails the attempt |
| g | The queue started before tools | The queue block moved below `tools.start()`, with `resumeRunning` still first |
| h | Scratch servers read real prompts | Confirmed landed: `keystoreRoot: opts.dataDir`, and `promptsRoot` under the data dir |

## Found while building

- **`info/exclude` must name `.mec/*`, not `.mec/`.** With the directory excluded, `commitAll`'s `git add --all -- ':!.mec'` stages everything and exits 1. The fake-CLI runner tests caught this.
- **The guard walks the commits, not the end state.** A token added and then removed leaves `base..head` clean and stays in history a push would publish.
- **An exit with no `result` and a code below 128 read as `completed`.** `finish` now says `crashed` for anything but 0. A `result` with no `terminal_reason` also fell through to an empty reason.
- **`Supervisor.stop` confirmed the leader, not the group.** A child outliving its leader counted as stopped. It probes `-pid` now. macOS answers EPERM when a group holds only zombies, and that no longer fails the stop: the confirmation loop decides.
- **Real run 1: `mcp__mec__confirm` was never asked** on a linked slot. Argv now passes `--permission-mode default`, and settings set `autoAllowBashIfSandboxed: false`.
- **Real run 2: `confirm` read the wrong field.** Claude sends `input`, not `tool_input`, so every ask looked empty, and an empty Bash command was allowed. It reads both now, and a request with nothing to judge is denied.
- **`git push` and `gh` are also refused by engine deny rules** (`--disallowedTools`), because a linked slot runs under the user's own settings and their allow rules can answer first.

## Found by verification

- **A stop never reached a running check.** `runCheck` could not be cancelled, and `interruptAttempts` asked the runner only for `running` attempts, so a `work_complete` one was never told. It then ended `succeeded` on work already `stopped`, and on SIGTERM the check outlived the server. `runCheck` takes a signal, `#stop` aborts it, and `stopWorkItem` asks for `work_complete` too. The wall clock reaches a hung check the same way.
- **A Claude-only store could not plan.** Only opencode slots had marks, so no tier was placeable and `propose_plan`, which requires a `model_request`, had no valid plan. Dispatch also ignored engine, so an opencode slot sorting first took the task and failed `engine_not_launchable`. `apps/desktop/src/planner-placement.ts` fixes both, with the flag on only: a launchable slot's marks are the table's own entries, declared and not probed, and tier validation and dispatch read the same list of launchable slots.

- **The worker's brief called the shared clone read-only, and it is not.** Second verifier, real run 2: `git branch evil-branch` was allowed and wrote a ref into `<dataDir>/repos/*.git`. The brief now says the sandbox lets git write there and that the refs belong alone. `docs/known-limits.md` said `git commit` inside an attempt fails. No run showed that, and the same grant suggests it works, so that line went too. The cause is read from the 2.1.318 binary's text: it adds a linked worktree's common dir to the write list and protects `hooks` and `config`, not `refs` or `objects` (`docs/engines.md`).
- **`git update-ref` was a branch delete `confirm` did not know.** Requirement 6 denies branch delete, so `confirm` denies `update-ref` in any spelling, in its own commit. Shell text is a heuristic: a plain file write to the same ref is not stopped by it.

- **A worker could still overwrite the shared clone.** Third verifier, real run 2: `rm` and overwrite of a sibling's ref and a file in `objects` all worked under the sandbox, and run 3's launch stopped at `git fetch`, `bad object`. The coordinator ruled from §26 ("cannot write outside its worktree"): deny it, and tell the worker. `sandbox.filesystem.denyWrite` now holds the whole clone, not only `refs`, `packed-refs` and `objects`. A deny beats an allow, so a sibling's admin directory cannot be denied while a later attempt's own stays writable, and a literal list misses later attempts. The whole `worktrees/` has to go, and with it the attempt's own admin directory, which also stops a worker pointing its `HEAD` at a sibling's branch. The clone's `HEAD` and `info/` were writable too, and `cachedDefaultTip` reads that `HEAD` for the next base. `commitAll` runs in the server, outside the sandbox, so it still commits. It runs only on a completed exit, which the brief now says.
- **The shipped planner on a linked slot set `CLAUDE_CONFIG_DIR`.** All three verifiers used a wrapper that unsets it. `settings/meta-slot` pointing at a slot doc with `linkedDefault: true` now leaves it unset, on the planner and on the v0 turn and its retry. Any other slot, `MEC_META_SLOT` and `metaSlotDir` keep setting it to the home they name.

**Owner call:** declared Claude marks depart from rule 2 of `docs/review/2026-11-04/03_MODEL_TIERS_AND_PLANNER.md` (probe before trust), because no zero-token Claude probe exists. It is one commit behind the flag. A model the account refuses fails that attempt with the engine's reason. The probe in `@mec/slots` still answers `unlisted`, and M2.2's placement replaces the slot list.

## Decisions applied

Base pinned at first dispatch on the work item, repo identity with refusal when there is none, 30 minutes of wall clock, `failed` from #26, one line per request from #24, unsandboxed checks for scratch only from #25. All are #36 or their own rows.

The token also leaves the worktree before anything repo-controlled runs: `seal` removes `.mec/mcp.json` when the engine stops, because the checks run in that directory and #25 says no tools token.

A repo whose profile changed after admission is refused (`repo_profile_changed`), because the pin records the hash and §12's rule is that registry edits change later admissions only.

## Touched outside the handoff's list

- `packages/meta/src/authority.ts`: `LaunchFailureReason` widened to `string`, so one function fails every attempt.
- `packages/meta/src/service.ts`: one import line beside the named `decision.stops` block, and `#placementSlots` with its two callers, by the coordinator's call. That placement is M2.2's block.
- `packages/meta/src/authority.ts`: `interruptAttempts` asks for `work_complete` attempts too.
- `apps/desktop/src/composition.ts`: the suppliers in `composePlanner` moved to `planner-placement.ts`, and the `brain` test seam now gets them.
- `packages/git/src/index.ts`, `packages/engines/src/index.ts`, `packages/runtime/src/index.ts`: exports.

No contracts change, no SQL migration, no new dependency.

## Intended behaviour changes to existing tests

- `packages/git/test/repos-worktrees.test.ts`: a fetched branch is read from `refs/remotes/origin/`, where it now lands.
- `packages/runtime/test/isolation.test.ts`: `mec.db`, not `db`, which was never the file.
- `packages/engines/test/argv-classify-probe.test.ts`: asserts the new `--permission-mode default`.

## Risks

- **Repo checks run agent-written code on the host.** Decision #25 limits this to scratch repos and `mec-sandbox`, and the flag stays off for real repositories.
- **Stopping during checks leaves `work_complete`.** The check's group is killed and `checks_note` says which check and why, with no verdict. There is no interrupt row from `work_complete`, so that attempt still counts as active, and nothing recovers it after a restart. M2.4.
- **A crash after spawn but before `session_started` leaves an orphan** and a queued attempt, whose row would start a second engine. Orphan cleanup is M2.4.
- **A wall-clock stop leaves the work `executing`** with an `interrupted` attempt and nothing to resume it. M2.4.

## Open

See `VERIFICATION.md`.
