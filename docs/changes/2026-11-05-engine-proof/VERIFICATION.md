# Verification: M2.4 Part B

Base `feat/m2.1-specialist-slice` at `8b20e97`. Real verifier runs on `40a2426` are in `handoffs/engine-runs.md`. Codex and OpenCode each stand at 4 of this handoff's 4, so no engine ran for the fixes below.

## The verifier fixes, on `0c908bc`

- **Failing first.** Unit suites: 7 failed of 65 at first, then 3 more in the sharpened OpenCode stream tests, each for the expected reason. Registry suite: 11 failed of 44, all on behaviour (`condition never held` on the journal, `engine_crashed` with no detail, the command still alive, and so on). All of them pass now.
- **`pnpm check`.** Typecheck and lint pass. Three full runs in a row: 2395 passed, 17 skipped, 1 failed, and that one is the baseline `login-cards` node-pty test. Load average was about 3 and the machine was not otherwise quiet. `bundle.test.ts` and `a11y-gate` passed in all three.
- **`codex-client.test.ts` alone** no longer has an unhandled rejection: the full runs report none.
- **Mutants.** `tools/mutants/m2.4b.json`, 57 mutants, 18 of them new. On the first commit 56 were killed, `token file for codex` among them, and `stream closes at the verdict` survived. It lived on read timing: the late event shared a chunk with the verdict. The fake now sends it in a later chunk. On `0c908bc` that mutant was killed 3 of 3 times, and the other six that run `opencode-client.test.ts` were killed again. The other 50 were not rerun after that fake change.

## Not proven

- No real binary ran on these fixes. The trust override and the Codex read denies rest on the verifier's zero-turn checks; the stop, the 404 path, the live journal and the link refusal rest on the fakes. The deny entries for OpenCode's default home were tested on neither.
- The cause of the earlier full-run timeouts was not confirmed. They did not recur with the longer bounds.
- Independent verification of these fixes has not been done.
