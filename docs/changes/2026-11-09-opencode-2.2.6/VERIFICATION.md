# Verification: OpenCode 2.2.6

## Real runs (2 of a budget of 3)

Binary `~/.opencode/bin/opencode`, `opencode --version` → `opencode v2.2.6`. No credential, key file, opencode auth store or slot `keys/` was read; nothing under `~/.mec` was touched. Details and commands: `docs/log/HANDSHAKES.md`, "OpenCode 2.2.6 through the runner".

- **Run 6, zero tokens.** `opencode serve --stdio` on scratch XDG homes and the attempt config. Every path the adapter uses answered as on 2.2.5; agent ids `build` and `plan`; reply `{decision, message?}` → 204, an unknown ask 404 `PermissionNotFoundError`; `session.created` carries `version: "2.2.6"`. Differences found: a session on a missing directory is created (200, was `LocationNotFoundError`), and two `browser` deny rules now follow MEC's in the merged agent lists. Neither is read by the adapter.
- **Run 7, one turn, `glm-5.3-flash`.** `MEC_KEEP_SCRATCH=1 MEC_REAL_OPENCODE=1 node_modules/.bin/vitest run --project b apps/desktop/test/opencode-runner.real.test.ts`: 1 passed. `succeeded` on the exact head, stream 25 s; engine 2.2.6 on `session_started`; edit ask allowed and written, shell ask refused, `mec_report` stored, check passed on the head, no `.mec` in history, exit `completed`, cost 0; no key shape or bearer value in the data dir; no serve process left.

The proven-set change was in the working tree, uncommitted, for run 7: on main the gate refuses 2.2.6 before any spend.

The real test was first run on a scratch copy of the fake CLI (zero spend) to check its own assertions. The unmodified fake sends no `version` on `session.created`, so the copy added one.

## Tests

- **Failing first.** `node_modules/.bin/vitest run apps/desktop/test/engine-registry.test.ts -t "2.2.6|OpenCode version"`: 2 failed of 2. The 2.2.6 launch ended `failed` instead of `succeeded`, and `driftOf` returned "engine opencode is 2.2.6; this build proved 2.2.5" instead of nothing.
- **Then green.** `vitest run packages/engines apps/desktop/test/engine-registry.test.ts apps/desktop/test/opencode-runner.real.test.ts packages/runtime/test/drift.test.ts`: 141 passed, 9 skipped (the gated real tests). `vitest run apps/desktop/test/attempt-launch.test.ts apps/desktop/test/slot-cli.test.ts apps/desktop/test/slot-switch.test.ts apps/desktop/test/models-api.test.ts`: 116 passed.
- Two `toBe` checks of `ROW.pinned` against the probe's version became `toContain`, because `pinned` is now a set. The probe still has to report a proven version.
- `tsc --noEmit` in `packages/engines` and `apps/desktop`: clean. `biome check .`: exit 0, no errors.
- Not run: the full `pnpm check`.

## Mutants

See the mutant results below.
