# OpenCode 2.2.6 joins the proven versions

Base `origin/main` at `77bcdb4` (v0.3.4 and records). Branch `fix/opencode-2.2.6`.

## Why

On installed 0.3.4 a request pinned to an OpenCode slot was refused at launch: "An engine's version is not one MEC supports: engine opencode is 2.2.6; this build proved 2.2.5" (OpenCode run 5 in `engine-runs.md`). The machine's `opencode` had self-updated to 2.2.6. A new engine version is accepted only after a real-binary run (AGENTS.md, gates never pass on fakes).

## What changed

- **The gate is a set.** `EngineRow.pinned` is now `readonly string[]`, and `driftOf` (`apps/desktop/src/engine-registry.ts`) refuses a probed version outside the set; the refusal names every proven version. Codex keeps one, `[CODEX_ENGINE_VERSION]`.
- **`OPENCODE_PROVEN_VERSIONS`** (`packages/engines/src/opencode/protocol.ts`, exported from `@mec/engines`) is `['2.2.5', '2.2.6']`. 2.2.5 stays: nothing about it changed, and its fixtures and proof stand. `OPENCODE_ENGINE_VERSION` stays 2.2.5, the revision the fixtures were recorded on.
- **No adapter change.** The probe of the 2.2.6 serve API and the real run found no drift the adapter reads (`docs/engines.md`, OpenCode 2.2.6 drift).
- **A gated real test,** `apps/desktop/test/opencode-runner.real.test.ts` (`MEC_REAL_OPENCODE=1`): one seeded attempt through the runner on the installed binary and the default home's own login, so a later version can be proven the same way without reading a keystore or a slot under `~/.mec`.
- **Mutants.** `tools/mutants/opencode-226.json` (4, on the set and the gate). One `find` in `tools/mutants/m2.4b.json` repointed at the renamed constant.
- **Records.** `docs/engines.md`, `docs/log/HANDSHAKES.md`, the pinned-versions line in `AGENTS.md`, the engine table in `README.md`. Engine runs 6 and 7 are in `docs/changes/2026-11-05-meta-agent-journeys/handoffs/engine-runs.md` in the main checkout.

## Not changed

No contract, no migration, no fixture. 2.2.6 has no recordings: the fixtures stay under `2.2.5/`.
