# M3.2 Stage C: verification

Builder's run only. The brief waived the separate verifier, so its scratch-server step in the handoff did not run.

## Failing first

`npx vitest run` on `work-model`, `sse-resume`, `inspection-feed`, `inspection-decode` and `inspection-contract`, before the implementation: failed on the missing surface (`inspection.openArtifact is not a function`, `decodeArtifact is not a function`, `workspace.onInvalidate is not a function`) and on assertions (`expected null to be '1'` for `compact`, `expected [ 'Attempt 1: running' ] to deeply equal [ 'SAMPLE-ONLY Bash' ]`).

After: 216 of 217 on those files plus `api.test.ts`. The one failure was the new test's own count: `client.work` is also read for Unassigned on a refresh, so it now asserts growth, and the `inspectWork` count stays exact. All pass since.

Named by the handoff, both green: `work-model.test.ts` `activity has no running state from a tool call`; `sse-resume.test.ts` `compact frame invalidates one read`.

`inspection-contract.test.ts` holds activity and artifacts against the real routes on `SqliteStore`: only the contract's types, a key redacted in activity and in an artifact, JSON text stays text, binary is metadata, 403 and 404.

`inspector-evidence.test.ts` renders the tab with `renderToStaticMarkup`: an artifact holding `<script>` stays escaped.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.2-evidence.json`: 24 of 24 killed, including `tool call implies running` and `compact frame ignored`. The first run was 22 of 24. `a later after moves the attempt's cursor` and `coverage false still reads activity` survived, because the tests did not reach them. Both tests were tightened and the source did not change.

A static check of every `apps/web` mutant's `find` shows `m3.2-work.json` still matches. Two older entries do not; see `CHANGE.md`.

## pnpm check

Typecheck and lint passed. `pnpm test` exited 1 under machine load (load average near 8, other agents running): 9 failed tests and 8 failed files out of 172, all in `apps/desktop` and `packages`, with `Timeout waiting for worker to respond` or timed-out waits. This change touches neither area, and the web suite was green.

- The baseline: `login-cards.test.ts` `drives a real interactive shell through the seam` (`posix_spawnp failed`).
- Rerun of the 8 other affected test files plus `packages/contracts`, alone: 21 files, 569 tests, all passed.
- Rerun of the six files whose workers never started, alone: 5 passed, 1 skipped, 57 tests passed.

So no failure beyond the baseline reproduced, but the full gate did not finish green in one run.

## Not run

- `pnpm test:screens`: Stage C's handoff names no screens. Classic and next baselines were not rerun.
- A browser. The tab's markup is proven by server rendering and its data by the real routes. Clicking through it on a scratch server, and a forced `reset` compared against SQLite, did not happen.
- Real engines: none spent.
