# Verification: M2.4 Part B

Base `feat/m2.1-specialist-slice` at `8b20e97`. Real verifier runs on `40a2426` are in `handoffs/engine-runs.md`. Codex and OpenCode each stand at 4 of this handoff's 4, so no engine ran for the fixes below.

## The verifier fixes, on `0c908bc`

- **Failing first.** Unit suites: 7 failed of 65 at first, then 3 more in the sharpened OpenCode stream tests, each for the expected reason. Registry suite: 11 failed of 44, all on behaviour (`condition never held` on the journal, `engine_crashed` with no detail, the command still alive, and so on). All of them pass now.
- **`pnpm check`.** Typecheck and lint pass. Three full runs in a row: 2395 passed, 17 skipped, 1 failed, and that one is the baseline `login-cards` node-pty test. Load average was about 3 and the machine was not otherwise quiet. `bundle.test.ts` and `a11y-gate` passed in all three.
- **`codex-client.test.ts` alone** no longer has an unhandled rejection: the full runs report none.
- **Mutants.** `tools/mutants/m2.4b.json`, 57 mutants, 18 of them new. On the first commit 56 were killed, `token file for codex` among them, and `stream closes at the verdict` survived. It lived on read timing: the late event shared a chunk with the verdict. The fake now sends it in a later chunk. On `0c908bc` that mutant was killed 3 of 3 times, and the other six that run `opencode-client.test.ts` were killed again. The other 50 were not rerun after that fake change.

## The overlapping stop, on `a9bd444` and `970da19`

- **The defect.** The monitor's stop returned `terminated` and dropped ownership during the first stop's grace, so `interrupted` was recorded with a TERM-ignoring command outside the group still alive.
- **Failing first.** `supervisor.test.ts`: 2 failed of 14, each with `terminated` where the test expected the wait or the refusal. `engine-registry.test.ts`, "interrupted waits for a command that ignores SIGTERM": the command still alive at `interrupted`. "a command SIGKILL cannot take": it was written after the fix, so its red came from removing the sharing, and the attempt's state was then not `failed`. All pass now.
- **`pnpm check`** on `a9bd444`. Typecheck and lint pass. 2399 passed, 17 skipped, 1 failed, and that one is the baseline `login-cards` node-pty test. `970da19` changes only a mutant spec line, and `pnpm check` was not rerun on it.
- **Mutants.** `tools/mutants/m2.4b.json`, 59 mutants, 2 of them new. On `a9bd444` 58 were killed, both new ones among them, and `drift ignored` was INVALID: two tests failed, but the two new registry tests took that run to 308 s, past the runner's 300 s limit. The bounds stay. On `970da19` the mutant runs only those two tests and is killed. The other 58 were not rerun, as only that line changed.

## Not proven

- No real binary ran on these fixes. The trust override and the Codex read denies rest on the verifier's zero-turn checks; the stop, the 404 path, the live journal and the link refusal rest on the fakes. The deny entries for OpenCode's default home were tested on neither.
- The cause of the earlier full-run timeouts was not confirmed. They did not recur with the longer bounds.
- Independent verification of these fixes has not been done.
- In the tests only SIGKILL's refusal is faked.
- The supervisor keeps a refused stop's pids and groups until a stop confirms them gone, and the only retry today is the monitor's, right after the refusal. A retry much later could signal a recycled id.
