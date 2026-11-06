# Runtime defaults: real launches on by default, and a Work row that hears `pr_ready`

From `origin/main` at `07000f2`. The capacity fix travels with this branch and keeps its own record in `docs/changes/2026-11-06-hold-capacity-stuck-group/`. No version bump.

## A real launch is the default

Without `MEC_REAL_RUNNER=1` an installed `mec` failed every launch with `no_runner`, and `mec restart` from a shell without the variable lost it.

- `realRunnerOn` in `apps/desktop/src/attempt-launch.ts` is the one rule: on unless `MEC_REAL_RUNNER=0`, and `MEC_FAKE_ENGINE=1` wins. Any other value reads as on.
- `composition.ts` and `planner-placement.ts` were the only two readers in product code. Both call it.
- `vitest.config.ts` sets the variable to `0` for the suites, so a test server with no flag still starts nothing. Tests that cleared the variable now set `0`. The two tests that mean off set it themselves, and new tests clear it to prove the default.

The variable grants no authority: mandate, hold and repo checks run on every launch, as before.

## `pr_ready` reaches the page

The page follows `work:<id>` for its rows. `pr_ready` landed on the release and inbox streams only, so the row waited for the 10 s refetch. Delivery now also appends `pr_ready` to `work:<id>`, through `workEvent` in `release.ts`, once, on the move to ready.

The new event comes after the stage patch. A frame makes the page read the stage back, so a frame sent first could read the old one.

The journey test's bound goes back to the default 5 s.

## Limits

- **Security posture.** DECISIONS #25 kept the runner to scratch repositories because repo checks run unsandboxed on the host. That risk now applies to any repository a user admits. `docs/known-limits.md` says so. `docs/DECISIONS.md` is the coordinator's, so #25 still needs a superseding line.
- **`MEC_REAL_RUNNER=0` does not survive `mec restart` by itself.** The restart passes on the environment of the shell that runs it. From a shell without the variable, an off server comes back on. It is not persisted.
- **A ready PR that falls back.** `target_moved`, `ci_failed` and `pr_closed` still land only on the release and inbox streams, so that row moves on the refetch. Only the move to ready was in scope, and others are working in `delivery.ts`.
