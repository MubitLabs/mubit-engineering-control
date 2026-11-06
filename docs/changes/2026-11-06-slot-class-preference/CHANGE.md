# Slot class is a preference

Owner ruling, following spec §10: a planner's `slot_class` hint is a preference, not a requirement.

- Before: `planDispatches` (`packages/domain/src/scheduling.ts`) filtered slots on `slot.slotClass === task.slotClass`. No slot carries a class, so a hinted task deferred forever as `slot_unhealthy`.
- Now: the class is no longer a filter. Among eligible slots (healthy, pin, role pinning, model, capacity, ceiling) those matching the hint are preferred; if none matches, any other eligible slot takes the task. No healthy slot still defers as `slot_unhealthy`; no new status.
- Tests: `packages/domain/test/scheduling.test.ts` (classless placement, matching slot wins, no healthy slot defers).
- Mutants: `tools/mutants/slot-class-preference.json`.
