# M2.4 Part B: Codex and OpenCode through the runner

Handoff: `docs/changes/2026-11-05-meta-agent-journeys/handoffs/23-m2.4-crash-capacity-recovery.md`, Part B. Base: `feat/m2.1-specialist-slice` at `8b20e97`, a local branch, by coordinator waiver.

## What it does

With `MEC_REAL_RUNNER=1`, a launch on a `codex-sub` slot or an `opencode-glm` slot starts that engine through the same runner Claude uses: same journal, same facts, same commit, same checks on the exact head. Each engine has its own row in `apps/desktop/src/engine-registry.ts`, added with its own proof. An engine with no row refuses with no spend, and the planner never sees it.

## Design

- **One server per attempt** (decision #31). `packages/runtime/src/codex-client.ts` and `opencode-client.ts` start the engine through `ownedSpawn`, so the group is the attempt's. `ownedSpawn` gains an optional open stdin.
- **`connect` on the adapters.** The runner calls `launch(spec)` and `events(handle)` and nothing else, so an adapter with `connect` starts its process at launch, sends the brief as the first turn, and ends its stream at the turn's end. Without `connect` the adapters behave as they did, for fixtures.
- **Rows.** The launch order stays in `attempt-launch.ts`. What differs per engine moved to `engine-registry.ts`, a new file, so handoffs 21 and 22 keep their blocks: sandbox, env, what the brief says of the shell, how an ask is answered. The handoff named only a registry row in `attempt-launch.ts`, and a row could not carry this.
- **Codex's sandbox is a permissions profile,** because only a profile says what a worktree needs. See `docs/engines.md`. A thread without it refuses.
- **Every Codex ask is refused.** The handoff has both engines reuse 20's decider. That decider allows shell "under the required sandbox", and on Codex an allowed ask runs outside it, so reuse would be an escape. `bridgeOf` records the ask and denies. It is a behaviour change from the handoff's wording, and it is the safe direction.
- **OpenCode pins `sandbox: off`,** which is the truth, and 20's decider then refuses every shell ask by its existing rule and judges edits by their real path. A worker there has no shell. See the owner question below.
- **`permissionRequested`** is recorded in `bridgeOf`, because `attempt-runner.ts` is Part A's. The id is a hash of the operation, and the engine's native id stays on the journalled event.

## Outside the handoff's file list

`packages/runtime/src/owned-spawn.ts` (stdin), `apps/desktop/src/engine-registry.ts` (new), the `#launch` and `#adapterFor` blocks of `attempt-launch.ts`, `packages/prompts/defaults/engines/{codex,opencode}.md` (they stated things that are not so), one test row in `attempt-launch.test.ts`, the spec's §8.1 and §9 lines for decision #31.

## Intended test changes

- `codex.test.ts`: one process takes one handshake, so a later `launch` no longer sends `initialize`. `restricted_mode` is now `false` in the probe, with `resume`, `interrupt` and `questions`: nothing through the runner has shown them.
- `opencode.test.ts`: a rejected reply now carries a `message`.
- `attempt-launch.test.ts`: the non-registry engine in the refusal list was `codex`, and is now `gemini`.

## Owner questions

1. **§8.4, OpenCode shell.** Denying every shell command is the safe reading of "no OS sandbox", and it leaves a worker that cannot run a test. Recommendation: keep it until a boundary exists, such as wrapping `opencode serve` in `sandbox-exec` with the same file rules. That wrapper is unproven and has not been built.
2. **Model table.** `packages/prompts/defaults/models.yaml` lists `gpt-6-*`, and 0.148.0 offers `gpt-5.6-*`. Recommendation: correct the table in a change of its own. Until then a planner can pick a Codex model the engine refuses, and only that attempt fails.

## Verifier fixes

Real verifier runs on `40a2426` found what follows, and each fix has a failing test first. No engine ran for these fixes, so each is proven on the fakes or by the verifier's zero-turn check, and the real behaviour needs one more run.

- **Codex trust.** `thread/start` wrote `trust_level = "trusted"` for the repo cache and then loaded the repository's own config. The argv now names the cache `untrusted` (§8.4).
- **Stop.** Codex runs each command in its own process group, so `Supervisor.stop` missed it. It now lists the group's descendants before signalling, signals those too and confirms them gone. This holds for every engine. A descendant of a server that already died has no parent left to find it by, and stays a known limit.
- **Parallel OpenCode asks.** A reject settles the session's other pending asks, so a sibling's reply answers 404. That is now a settled ask, recorded `deny` because nothing it wanted ran, and the stream reads on. Any other failure journals an `error` and an `exit` of `crashed`, and the attempt's reason carries the detail through the stderr tail. `attempt-runner.ts` stays untouched, as Part A's.
- **OpenCode journal.** The pump now wakes the consumer after each event.
- **OpenCode links.** A launch refuses, with no spend, when a tracked link leads out of the worktree, dangling links included. The worker has no shell to make a new one.
- **Codex reads.** `<data>/work` and `<data>/tmp` are denied in the profile, with the attempt's own paths kept. OpenCode's default home joins `defaultDenyRead`, which Claude's list shares. Claude's list still does not deny `<data>/work` or `<data>/tmp`; that gap predates this branch.
- **`opencode-gemini`** leaves the row until a real run. Slots of that kind can still be added.
- **Time bounds.** The probe bound is 60 s (was 15 s), the OpenCode start bound 60 s (was 30 s), and vitest's test and hook bounds 60 s (were 20 s and 30 s).

## Intended test changes (verifier fixes)

- `opencode-client.test.ts`: the fake now answers 404 for an ask it does not hold, as the real server does, so the empty-body test asks first.
- `codex-client.test.ts`: the in-flight request's handler attaches before the stop, which removes an unhandled rejection. The assertion is unchanged.
- `engine-registry.test.ts`: longer bounds on `until` and the suites.

The rest of what this does not do is in `docs/known-limits.md`.
