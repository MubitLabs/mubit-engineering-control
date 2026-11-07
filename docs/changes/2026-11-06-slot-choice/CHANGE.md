# Slot choice: launchable, proven, then the meta engine

Before: a tier-only task (no pin, no `slot_class`) sorted by utilisation then id, so OpenCode `gem-1` beat the Claude slot. `gem-1` (`opencode-gemini`) has no row in `apps/desktop/src/engine-registry.ts`: the build cannot launch it, and no real run has proved that login.

Now, in `docs/reference.md` "How a task gets its slot":

- **Launchable only** (`apps/desktop/src/planner-placement.ts`): plan validation and placement see only slots this build can launch, with or without `MEC_REAL_RUNNER`. `MEC_FAKE_ENGINE=1` keeps its one fake slot. A plan pinning an unlaunchable slot is refused as an unknown slot.
- **A pin still wins; a `slot_class` hint stays a preference** (`packages/domain/src/scheduling.ts`).
- **The meta slot's engine goes next** (`settings/meta-slot`), on slots where the tier fits without degrading (`degradedSlots`, from `packages/meta/src/scheduler.ts` `modelFit`). No fit, no meta slot, or a retired one: the step does nothing.
- **Then a stable order:** utilisation, attempts, id.
- **Truthful placement:** `planDispatches` returns a `Placement` per launch (`narrowedBy`, `missed`, `tiebreak`, `candidates`); the attempt's `placement` string claims only the steps that changed the field, and says when a class or engine was asked for and missed.

Also: `docs/known-limits.md` (`opencode-gemini` takes no work), `packages/domain/src/index.ts` (exports `Placement`), `packages/meta/src/service.ts` (passes `metaEngine`).

Tests: `packages/domain/test/scheduling.test.ts`, `packages/meta/test/scheduler.test.ts`, `apps/desktop/test/attempt-launch.test.ts`. Mutants: `tools/mutants/slot-choice.json`.
