# Verification: M2.1 Real specialist vertical slice

Base `feat/durable-commands` at `5be0ef8`, a local branch, by coordinator waiver. These are builder runs in the builder's worktree. Independent verification and the blockers-only review are still to come.

## Failing first

- `pnpm exec vitest run --project b repos claude-stream stream-conformance argv-classify isolation`, before the fixes: 15 failed, 20 passed. `createClaudeEventParser is not a function`; `git rev-parse failed` on the `mec/*` branch a second `ensure` had deleted; the deny list holding `/Users/tester/.mec/db`.
- `packages/runtime/test/attempt-runner.test.ts` first ran against a written runner: 3 failed, 27 passed, all from `git add failed (exit 1): The following paths are ignored`, a real defect. `.mec/` in `info/exclude` breaks `commitAll`. `.mec/*` does not.
- `apps/desktop/test/attempt-launch.test.ts` and `specialist-tools.test.ts` were written before running the launch: 2 failed, 38 passed, both from a wrong assertion on `Later`. The new modules were not written test-first line by line, so the mutants below are the evidence that these tests see them.

## Gate

`pnpm check` on the final tree: exit 1, from the one baseline failure only.

| Step | Result |
| --- | --- |
| Typecheck | Passes |
| `biome check .` | 94 warnings, none an error |
| `vitest run` | 2302 tests: 2286 passed, 1 failed, 15 skipped |
| The failure | `apps/desktop/test/login-cards.test.ts > drives a real interactive shell through the seam`, the known environment problem |

Earlier full runs of the verification fixes each timed out one more test under load, and each passed alone: `bundle.test.ts` `exits within the bound…`, and `server.test.ts` `setup mode needs no repoId` at 20 s, three runs of three. The full run before the first gate also failed `a crash fails the attempt`: its attempt hit the rig's 20 s wall clock on a loaded machine and correctly ended `interrupted`. The rig's wall clock is now 55 s. A slow start, not a hang, is the likely cause, but that was not proven.

## Fake and real-process evidence

`packages/runtime/test/attempt-runner.test.ts` runs a real process in its own group through the fake CLI (`packages/testkit/fake-cli/claude`). `apps/desktop/test/attempt-launch.test.ts` runs the real server, queue and store on it. `apps/desktop/test/specialist-tools.test.ts` uses real HTTP and real tokens. `core-facts.test.ts` runs on the real SQLite store.

## Real engine evidence

Three builder runs, logged in `handoffs/engine-runs.md`, with details in `docs/log/HANDSHAKES.md`. Claude 2.1.318 through a linked slot, with `CLAUDE_CONFIG_DIR` unset, real `HOME`, scratch `MEC_DATA_DIR` and a fake `gh` first on `PATH`. A seeded launch row, so no planner ran.

The verifier's run 2 prompt is worth wording with care. In run 3 the model declined the refused steps from its own prompt, and that proves nothing about the boundary.

## Verification findings fixed

Two defects from the independent verifier, on the same branch. The verifier's rerun is still to come.

- **A stop reaches a running check.** Red: `pnpm exec vitest run --project b checks.test attempt-runner.test attempt-launch.test -t "cancelled|a stop while the repo check|during its only check|kills a running check"`: 7 failed. `stop kills the group` took 30013 ms, the check's full length, and the server test waited out its 45 s limit, because no stop reached the check. Green: 7 passed. `packages/meta/test/authority.test.ts` adds the `work_complete` request.
- **A Claude-only store plans and launches.** Red: `pnpm exec vitest run --project b attempt-launch.test -t "a chat request"`: 3 failed, 3 passed. `expected +0 to be 1` on `tasksCreated`, `attempt settled failed: engine_not_launchable: opencode`, and a tier only the opencode slot serves passing the plan. Green: 6 passed, through `POST /api/chat/messages`, the real server and a real process on the fake CLI, with a scripted planner calling the real `propose_plan`. The test's model reached the fake CLI's argv as `haiku`.

No real engine ran for these fixes. Whether a subscription accepts each alias, and the shipped path with a real planner, are for the verifier: `Not verified` below still stands for the composed chat path.

## Not verified

- The composed chat path with a real planner.
- A real Read-tool denial on a text file on the deny list. Confirm's rule covers it, and the test covers the rule, but no real engine has exercised it.
- `sandbox: required` on Linux.
- The real `--restricted` launch of a read-only role: the argv combines `--permission-prompt-tool` with `--permission-prompts none`, and no real run has tried that.
- Under a heavy load one full run timed out real-process tests, including the existing `shims.test.ts`. The same three files then passed alone. Their waits were raised.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m2.1.json`: 34 of 34 killed, the handoff's 12 plus 22 for gates this change added, ten of them for the two verification fixes. The wall clock test then changed, and the two runner mutants it covers were killed again.

The first run gave 20 of 23. `shim first` was INVALID: its tests waited out their timeouts past the runner's 300 s limit, so they now fail as soon as the attempt settles on the wrong state. `stop trusts the leader alone` survived because the fake CLI's child could take SIGTERM before its handler was in. `a stopped attempt comes back` survived because no test covered it, so `core-facts.test.ts` was added.
