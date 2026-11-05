# Verification: M1.4b Durable commands and truthful launch

Base `feat/authority-fence` at `a5fa29b`, verified but not on `origin/main` (coordinator waiver for this run). All runs are local, in the builder's worktree. No real engine, canary, `~/.mec` write or live server was used. Everything here is the builder's own evidence.

## Failing first

| Command | Before | After |
| --- | --- | --- |
| `npx vitest run apps/desktop/test/composition.test.ts -t "prompts and models"` | 1 failed: `path` was `packages/prompts/defaults/models.yaml`, `source` `default` | passed |
| `npx vitest run packages/domain/test/states.test.ts` | 2 failed | 17 passed |
| `npx vitest run packages/meta/test/durable.test.ts` | 21 failed | all passed |
| `npx vitest run apps/desktop/test/server.test.ts apps/desktop/test/planner.test.ts` | 6 failed, including `POST answer wakes the real service once` | 49 passed |
| `npx vitest run apps/desktop/test/composition.test.ts` | 9 failed | 23 passed |

The first test reads before it writes, on purpose. Without the fix its `PUT` would land in the real `~/.mec/prompts`, and the sandbox refuses a redirected `HOME`, so the failing read stops it first.

Some of the red runs fail because a seam did not exist yet (`stableMessageId is not a function`, no `brain` option), not on the behaviour itself. The mutants below are what show each behaviour is pinned.

## Mutants

`python3 tools/mutants/run.py tools/mutants/durable-commands.json`: 32 of 33 killed on the first full run. The survivor was 12b, a message that already has a receipt being resumed at boot. A test was missing, and the case matters: a turn that asked a question leaves its work in `planning` with a receipt. Added `a message answered with a question waits for its answer, not a resume`, then re-ran 12b alone: killed. The other 32 were not re-run after that test-only commit.

The 11 the handoff lists are 1 to 11. The other 22 cover what this PR added beyond them: the key dropped by a later save, the receipt on stopped work, the in-flight entry clearing, the queue key, a wake with no write, redaction on both paths, second answers, ended work, the failed-attempt retry, a relay with no meta agent, drain on close, stuck connections, boot and resume scans, the pause, replay and the data dir.

Mutant 2 stores the key only with the receipt, which is the behaviour the mutant names. It is a change to `#saveMessage`, because the route no longer has a write to move.

## Gate

`pnpm check` on the final code: exit 1, from the one baseline failure only.

| Step | Result |
| --- | --- |
| Typecheck | Passes |
| `biome check .` | 367 files, 17 warnings, 1 info, no errors |
| `vitest run` | 1922 tests: 1905 passed, 1 failed, 16 skipped |
| The failure | `apps/desktop/test/login-cards.test.ts > drives a real interactive shell through the seam`, the known environment problem |

## Not verified

- **Separate behaviour verification (README rule 6).** All five verifier steps in the handoff are open: retry, `kill -9` crash, truthful launch, SIGTERM shutdown, and the one gated real Claude run. They need a different agent, and the real run needs a slot home the coordinator names. No engine run was spent.
- **The crash path against a real process.** Unit and composition tests seed what a crash leaves; none kills a server.
- **Close against a real brain.** The stuck-turn tests use a held fake. `RealClaudeBrain.close()` is reached only on the real path.
- **An answer's wake after a pause** is late by source reading, not by a run. See the risks in `CHANGE.md`.
