# Codex models: run only what the connection offers, and say a refused model as one

Branch `fix/codex-models` from `origin/main` 77bcdb4. No contract change (`packages/contracts` untouched), no migration, no web change.

## What went wrong

Installed 0.3.4, a real run (Codex run 5 in `docs/changes/2026-11-05-meta-agent-journeys/handoffs/engine-runs.md`): a fast task on the owner's ChatGPT-sign-in Codex slot (codex-cli 0.148.0) resolved to `gpt-6-luna`, the first fast row of `packages/prompts/defaults/models.yaml`. Codex answered HTTP 400 `model_not_found`: "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account." The attempt failed as `engine_api_error`, and Work said "engine api error".

Three causes:

1. The shipped Codex rows (`gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-astra`) had never run on 0.148.0. The models that had run, `gpt-5.6-luna` and `gpt-5.6-sol` (`docs/log/HANDSHAKES.md`, `docs/engines.md` "The live catalogue is not the table"), were not in the table.
2. Review 2026-11-04 §3 rule 2 ("probe before trust": Codex's catalogue comes from app-server `model/list`, and the planner sees only available models) was not built for Codex. `@mec/slots`' probe answered `unlisted`, and `planner-placement.ts` declared every table row available on a launchable slot. `resolveModel` took the first row at the tier and never asked.
3. The runner turned every failed exit with no park into `engine_<terminal_reason>` and dropped the engine's own words.

## What changed

**`model/list` is the probe (§3 rule 2).** `packages/runtime/src/codex-client.ts`:
- `listCodexModels` starts an app-server of its own under the slot's env, with the same `--disable` features as an attempt. It sends `initialize`, then `model/list {includeHidden: true}` page by page (at most 20 pages), and stops the server whatever the answer.
- `codexModelIds` reads `data[].id` from each page.
- A failed or empty answer is `{failed}`, never an empty listing.

Nothing is spent: no thread starts. On 0.148.0 the call starts none of the home's MCP servers. That was checked on a scratch home with a marker server configured.

**The launch asks before it resolves.** In `apps/desktop/src/engine-registry.ts`, the Codex row gains `listModels`, and `modelListingId(slotId)` names the kept listing. `apps/desktop/src/attempt-launch.ts`:
- `#offered` runs only after `#probe` has passed, so a drifted or signed-out slot still spends nothing and starts no process.
- It keeps a good listing as `store.engines` `slot-models/<slotId>` (`{slotId, engine, listed, listedAt}`). A failed listing leaves the last good one in place, and the table alone decides, as before.
- `#model` hands `resolveModel` the table rows the home did not list.
- The attempt's `resolved_model`, `tier_degraded` and the new `models_passed_over` are rewritten from the launch's own resolution. The queue's resolution was made on an older listing.

**Resolution never picks an unoffered model.** `packages/runtime/src/model.ts` `resolveModel(request, slot, table, offer?)`, where `offer.unavailable` is a set of engine-facing keys:
- An unoffered row at the tier is passed over, and the next row at that tier serves.
- If the connection offers nothing at the tier, resolution walks down the ladder, as §3 rule 1 already does for a tier the provider lacks. The attempt then says `balanced→fast (this connection offers no balanced model)`, which is not the same as "provider has no balanced".
- `passed_over` lists the requested tier's unoffered rows.
- A model the plan named is refused if the connection does not offer it, never swapped.
- Nothing offered at or below the tier is refused, and the refusal names the unoffered models. The launch turns that into `model_refused` before any thread starts.
- The ladder walks down only: §3 rule 1 and §4 never move a task to a dearer tier.

**Planning sees the listing.**
- `packages/meta/src/scheduler.ts` `modelFit` passes each slot's `unavailable` marks into `resolveModel` and records `models_passed_over` on the queued attempt.
- `apps/desktop/src/planner-placement.ts` marks a launchable slot from its kept listing, when there is one for that engine: a listed row is `available`, any other row `unavailable`. With no listing it keeps the declared marks.
- The planner's tier validation (`packages/domain/src/tiers.ts`) already reads marks, so it needed no change.

**The shipped table.** `packages/prompts/defaults/models.yaml` adds, ahead of the gpt-6 rows:
- `gpt-5.6-luna` (fast, low, proven);
- `gpt-5.6-terra` (balanced, medium, listed, not yet run through MEC);
- `gpt-5.6-sol` (strong, high; it ran in the 3 November canary).

`vendor_says` is model/list's own description of each. Putting them first means a home whose listing fails still runs the proven rows. The gpt-6 rows stay for connections that list them. Codex keeps no `frontier` row, so `frontier→strong` holds.

**A refused model is said as one.**
- `packages/runtime/src/attempt-runner.ts` `modelRefusalOf(events)` looks for an `error` event matching `model_not_found`, "model is not supported", or "model … does not exist". It returns the vendor's sentence, taken from the body's `"message"` and capped at 300 characters.
- `#finish` then fails `model_unsupported: <model> on <slot>: <sentence>` in place of `engine_api_error`. A park still comes first.
- `apps/desktop/src/reason-words.ts`: `model_unsupported` reads "The connection cannot run the model chosen for this task: gpt-6-luna on codex-1: The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."

**Test support.**
- `packages/testkit/fake-cli/codex` answers `model/list` from `scenario.models`, with `modelPageSize` and `modelListError`. With none of them set it answers `{}`, as it does any method.
- `packages/testkit/fixtures/codex/0.148.0/model_list/` is a real recording of 0.148.0's answer on an empty scratch home, with `recorded_by: real` and a redacted path. The signed-in listing was not recorded as a fixture: it is the account's catalogue, so only its ids are written down, in VERIFICATION.md.
- `apps/desktop/test/codex-models.real.test.ts` is the gated canary (`MEC_REAL_CODEX=1`). It runs the row's own probe and listing on a real home and checks that the shipped table resolves every tier to a listed id.

## Not changed, and why

- `GET /api/models` (Settings) still reports Codex rows as `unlisted`. Its block in `server.ts` reads `@mec/slots`' probe, not the kept listing. Placement and launch are right; only that display lags.
- `requires_cli` stays unenforced. `gpt-6.1-terra` is not listed on 0.148.0, so the listing keeps it out anyway.
- A refusal is not written back as an `unavailable` mark. The next launch's listing is what corrects placement.
- Claude and OpenCode rows have no `listModels`, so their behaviour is unchanged.
