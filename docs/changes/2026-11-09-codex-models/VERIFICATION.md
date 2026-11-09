# Verification

Branch `fix/codex-models` on base 77bcdb4. The builder ran all of this on 9 November 2026. Nothing touched `~/.mec` or the server on 61610. No credential was read, nothing was pushed, and nothing was installed. The full `pnpm check` was not run; CI is the gate.

## What the engine says (real, zero tokens)

- **The method exists.** `codex app-server generate-ts` (0.148.0) has `model/list` with params `{cursor?, limit?, includeHidden?}`. The answer is `{data: Model[], nextCursor}`, and each `Model` has `id`, `model`, `hidden`, `isDefault`, `supportedReasoningEfforts` and `description`.
- **Empty scratch `CODEX_HOME`, no login.** The binary answers its bundled list: gpt-5.6-sol (default), gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4 (hidden), gpt-5.4-mini (hidden), gpt-5.2, codex-auto-review (hidden). This is recorded as `packages/testkit/fixtures/codex/0.148.0/model_list/`, `recorded_by: real`, with the path and user agent redacted. `matchesSecret` finds nothing in it, and a test asserts that.
- **No MCP side effects.** On a scratch home whose `config.toml` declares an MCP server that writes a marker file, `initialize` and `model/list` left no marker.
- **Signed-in ChatGPT home.** This is the linked default `~/.codex`. `codex login status` says "Logged in using ChatGPT", and the owner's `~/.mec` slot home was not used. The listing went through the Codex row's own `probe` and `listModels` (`MEC_REAL_CODEX=1 apps/desktop/test/codex-models.real.test.ts`, passed). It listed **gpt-reserve, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, codex-auto-review**. The listing is per account: it differs from the bundled list, and it holds no gpt-6-* id. The shipped table resolves fast → gpt-5.6-luna, balanced → gpt-5.6-terra and strong → gpt-5.6-sol, and each of those is listed. Only the ids were written down: the full answer is the account's catalogue.

## Real runs

Logged in `docs/changes/2026-11-05-meta-agent-journeys/handoffs/engine-runs.md` before each run.

1. **The zero-token listing above.** No turn.
2. **Codex run 6** (1 of the 2 allowed): `MEC_REAL_CODEX=1 apps/desktop/test/codex-runner.real.test.ts`. One seeded fast implementer attempt went through the real server, queue and launch path, on a scratch repo and data dir, with the linked default login. There was no planner, no delivery and no gh. **Passed**:
   - state `succeeded`, and the check `test -f made.txt` passed on the head;
   - the listing was kept as `slot-models/slot_codex`;
   - `resolved_model: gpt-5.6-luna`;
   - events: session_started, message, tool_call, usage, rate_limit, report, exit;
   - no key or bearer shape appeared in any data-dir file.

   That run reported `models_passed_over: [gpt-6-luna, gpt-6.1-terra]`. Those rows come after gpt-5.6-luna in the table, so they were never ahead of it. A test was added for that case and seen red, then fixed: only rows ahead of the choice (or the whole requested tier after a walk down) are passed over.
3. **Codex run 7** (2 of the 2 allowed): `MEC_REAL_CODEX=1 MEC_REAL_CODEX_REFUSAL=1 apps/desktop/test/codex-models.real.test.ts`. The adapter ran on an app-server started with the launch's own argv (`codexAttemptArgs`: the mec profile, a read-only scratch worktree, the home's MCP servers fenced), with the linked default login. One turn was asked of `gpt-6-luna` on purpose. **Refused, as on 0.3.4**:
   - no usage event, and exit `api_error` in about 3 s;
   - the error event's detail, verbatim: `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}`, with `codexErrorInfo: "other"`, sent twice;
   - `modelRefusalOf` returned the sentence.

   A first error event came from the canary itself: it set no `MEC_TOOLS_TOKEN`, so the `mec` server did not start. The turn was not affected. The real string now drives the engine-registry refusal test and a `model-refusal.test.ts` case. Only the normalised events were kept, not the raw protocol lines, so this is not a fixture.

## Failing first

Each test was written before its code and seen red for the stated reason.

| Test | Red |
| --- | --- |
| `packages/runtime/test/model.test.ts` (new, 7) | 4 red: `unavailable` was ignored, so `gpt-6-luna` was chosen, no `passed_over`, a named unoffered model was accepted, and the refusal named nothing. The passed-over-after-the-choice case was red later, as `['gpt-5.6-luna']` |
| `packages/meta/test/scheduler.test.ts` "a tier whose first model the slot does not offer places the next one it does" | `expected [] to match [{slotId: 'slot_codex'}]`: the slot was dropped because the first fast row was unavailable |
| `packages/runtime/test/codex-client.test.ts` "the models a Codex home offers" (5) | `codexModelIds` and `listCodexModels` were not functions |
| `apps/desktop/test/engine-registry.test.ts` "the model is one the connection offers" (4) | `expected 'gpt-6-luna' to be 'gpt-5.6-luna'`; `'gpt-6.1-sol'` for balanced; the nothing-offered case launched instead of refusing (never settled); a failed listing still took `gpt-6-luna` |
| same, "an engine that refuses the model fails in words…" | `expected 'engine_api_error' to match /^model_unsupported: …/`, the 0.3.4 symptom exactly |
| `packages/runtime/test/model-refusal.test.ts` (3) | `modelRefusalOf` was not a function |
| `apps/desktop/test/planner-placement.test.ts` (3) | the kept listing was ignored, so every row was `available` |
| `apps/desktop/test/delivery-surfaces.test.ts` model_unsupported row | the words fell back to "model unsupported: …" |

One existing test changed. The store double in `apps/desktop/test/real-runner.test.ts` gained `engines: { get: () => undefined }`, because placement now reads `store.engines`. Its assertion is unchanged.

The engine-registry refusal test first ran on a synthetic message. It now carries the real string from run 7, with the model renamed to the one that launch resolves. Mutant M13 (the words-only pattern removed) survived the first mutant run, because every refusal test also carried `model_not_found`. A `{"detail": …}` words-only case was added and seen red: the whole body came back where the sentence should have. The fix reads `"detail"` as well as `"message"`.

## Suites

- `pnpm exec vitest run packages/runtime packages/meta packages/prompts packages/domain packages/engines packages/contracts packages/slots packages/testkit`: 100 files, 1770 passed, 9 skipped.
- `apps/desktop` together with `apps/web/test/config-contract.test.ts` at default parallelism, on the loaded shared machine: 35 failed across 14 files. The failures were timeouts and "Failed to start forks worker", in files with no Codex model path (bundle-defaults, recovery, coordination, pause-attempts…). The same 14 files, `engine-registry` included, rerun at `--maxWorkers=3`: **14 files, 345 passed, 0 failed**. The `engine-registry` "Codex through the runner" block alone: 29 passed.
- `tsc --noEmit`: clean in `packages/runtime`, `packages/meta` and `apps/desktop`.
- `pnpm exec biome check .`: 0 errors. The remaining warnings are on main too.
- No web change, so no screens run.

## Mutants

`python3 tools/mutants/run.py tools/mutants/codex-models.json`: **21 of 21 killed** on the final tree. The first run killed 20 of 21, and M13 survived (see Failing first). The mutants cover:

- resolution: unoffered rows ignored, a named unoffered model accepted, the walk down read as "provider has no", passed-over rows unsaid, every unoffered row called passed over;
- the scheduler: resolving without the slot's marks, and not recording what was passed over;
- the listing: the wrong id field, a no-list answer read as empty, only the first page read, hidden models left out, the listing server left running;
- the refusal: read as an api error, the words-only pattern removed, the whole body returned as the reason;
- the launch and placement: resolving without the listing, not keeping it, marks ignoring it, a listing kept for another engine used;
- the refusal code with no words;
- the shipped table without a fast gpt-5.6 row.
