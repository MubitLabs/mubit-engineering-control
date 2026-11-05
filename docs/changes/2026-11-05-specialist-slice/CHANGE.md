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

## Decisions applied

Base pinned at first dispatch on the work item, repo identity with refusal when there is none, 30 minutes of wall clock, `failed` from #26, one line per request from #24, unsandboxed checks for scratch only from #25. All are #36 or their own rows.

The token also leaves the worktree before anything repo-controlled runs: `seal` removes `.mec/mcp.json` when the engine stops, because the checks run in that directory and #25 says no tools token.

A repo whose profile changed after admission is refused (`repo_profile_changed`), because the pin records the hash and §12's rule is that registry edits change later admissions only.

## Touched outside the handoff's list

- `packages/meta/src/authority.ts`: `LaunchFailureReason` widened to `string`, so one function fails every attempt.
- `packages/meta/src/service.ts`: one import line beside the named `decision.stops` block.
- `packages/git/src/index.ts`, `packages/engines/src/index.ts`, `packages/runtime/src/index.ts`: exports.

No contracts change, no SQL migration, no new dependency.

## Intended behaviour changes to existing tests

- `packages/git/test/repos-worktrees.test.ts`: a fetched branch is read from `refs/remotes/origin/`, where it now lands.
- `packages/runtime/test/isolation.test.ts`: `mec.db`, not `db`, which was never the file.
- `packages/engines/test/argv-classify-probe.test.ts`: asserts the new `--permission-mode default`.

## Risks

- **Repo checks run agent-written code on the host.** Decision #25 limits this to scratch repos and `mec-sandbox`, and the flag stays off for real repositories.
- **Stopping during checks leaves `work_complete`,** and nothing recovers such an attempt after a restart. M2.4.
- **A crash after spawn but before `session_started` leaves an orphan** and a queued attempt, whose row would start a second engine. Orphan cleanup is M2.4.
- **A wall-clock stop leaves the work `executing`** with an `interrupted` attempt and nothing to resume it. M2.4.

## Open

See `VERIFICATION.md`.
