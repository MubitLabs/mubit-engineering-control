# Verification: M2.1 Real specialist vertical slice

Base `feat/durable-commands` at `5be0ef8`, a local branch, by coordinator waiver. These are builder runs in the builder's worktree. Independent verification and the blockers-only review are still to come.

## Failing first

- `pnpm exec vitest run --project b repos claude-stream stream-conformance argv-classify isolation`, before the fixes: 15 failed, 20 passed. `createClaudeEventParser is not a function`; `git rev-parse failed` on the `mec/*` branch a second `ensure` had deleted; the deny list holding `/Users/tester/.mec/db`.
- `packages/runtime/test/attempt-runner.test.ts` first ran against a written runner: 3 failed, 27 passed, all from `git add failed (exit 1): The following paths are ignored`, a real defect. `.mec/` in `info/exclude` breaks `commitAll`. `.mec/*` does not.
- `apps/desktop/test/attempt-launch.test.ts` and `specialist-tools.test.ts` were written before running the launch: 2 failed, 38 passed, both from a wrong assertion on `Later`. The new modules were not written test-first line by line, so the mutants below are the evidence that these tests see them.

## Fake and real-process evidence

`packages/runtime/test/attempt-runner.test.ts` runs a real process in its own group through the fake CLI (`packages/testkit/fake-cli/claude`). `apps/desktop/test/attempt-launch.test.ts` runs the real server, queue and store on it. `apps/desktop/test/specialist-tools.test.ts` uses real HTTP and real tokens. `core-facts.test.ts` runs on the real SQLite store.

## Real engine evidence

Three builder runs, logged in `handoffs/engine-runs.md`, with details in `docs/log/HANDSHAKES.md`. Claude 2.1.318 through a linked slot, with `CLAUDE_CONFIG_DIR` unset, real `HOME`, scratch `MEC_DATA_DIR` and a fake `gh` first on `PATH`. A seeded launch row, so no planner ran.

The verifier's run 2 prompt is worth wording with care. In run 3 the model declined the refused steps from its own prompt, and that proves nothing about the boundary.

## Not verified

- The composed chat path with a real planner.
- A real Read-tool denial on a text file on the deny list. Confirm's rule covers it, and the test covers the rule, but no real engine has exercised it.
- `sandbox: required` on Linux.
- The real `--restricted` launch of a read-only role: the argv combines `--permission-prompt-tool` with `--permission-prompts none`, and no real run has tried that.
- Under a heavy load one full run timed out real-process tests, including the existing `shims.test.ts`. The same three files then passed alone. Their waits were raised.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m2.1.json`: see the report for the final count.
