# Verification

Base a102313, branch `fix/effects-double-run`. Commands are from the repository root.

## Red, then green

`pnpm vitest run packages/store/test/effects.test.ts`, before the fix: 10 of the new tests failed. The two named in the brief:

- `a running job is not re-picked by an overlapping pass`: `expected [ { attempt: 1 }, { attempt: 1 } ] to deeply equal [ { attempt: 1 } ]`
- `boot resumes a crashed running row`: `TypeError: queue.resumeRunning is not a function`

After the fix, `effects.test.ts` plus `apps/desktop/test/composition.test.ts`: all pass.

Two new tests passed before the fix as well, so they are guards and not failing-first: `an identical re-enqueue during a run adds no second run`, and the composition test `an effect left running by a crash is resumed once at boot and drained` (the old per-pass reset also resumed it). `a settled job leaves the guard` was added later for a mutant.

## Mutants

Each ran against the effects and composition tests.

| Mutant | Result |
| --- | --- |
| Remove the in-flight guard (all three checks) | killed, 3 tests |
| Remove only the ordered-kind check | killed |
| Remove only the due-row filter | killed |
| Capacity ignores in-flight jobs | killed |
| Resume on every pass | killed, 2 tests |
| Drop the boot call in `composition.ts` | killed |
| Success deletes whatever the payload | killed |
| Success deletes only when still `running` | killed |
| `drain` ignores in-flight jobs | survived at first; the test now yields a macrotask before release, then killed |
| In-flight entry never cleared | the full suite hangs in `drain`; killed cleanly by `a settled job leaves the guard` run alone |

## Full gate

`pnpm check`: typecheck and lint clean. Tests: 1 failed, 1591 passed, 16 skipped. The one failure is the baseline's `login-cards.test.ts` "drives a real interactive shell through the seam".

No real-engine canary and no `~/.mec` access. `pnpm test:screens` was not run: nothing in the UI changed.
