# Verification

Base `1900dcb`. No real engine ran, and nothing used `~/.mec`. Real groups come from the fake Codex; the part SIGKILL cannot take is faked at `process.kill`, as in 23 B's test, which is unchanged.

## Failing first

```
npx vitest run packages/meta/test/scheduler.test.ts packages/runtime/test/supervisor.test.ts \
  apps/desktop/test/recovery.test.ts apps/desktop/test/inspection.test.ts -t "..."
```

Eight failed before the change, among them:

- `a recycled pid means the group has gone`: held list still there.
- `a parked attempt does not resume into a slot a held group fills`: resumed `att_1`.
- `a refused stop names what it left`: `survivors is not a function`.

`engine-registry.test.ts -t "outlives its failed attempt"`: `end.held_groups` undefined.

`a live process that leads no group is not gone because ps could not read it`: expected `unprovable`, got `gone`. The gap came from reading `identifyGroup` for bare stray pids.

## Mutants

`python3 tools/mutants/run.py tools/mutants/hold-capacity.json`: 16 of 16 killed.

The first run stopped at its baseline: `baseline is not green for: apps/desktop/test/recovery.test.ts -t keeps the hold while it is there`. The runner hides the report and the cause was not captured. The same test then passed 9 times alone and 18 times with 6 running at once, and the second run's baseline was green. It may be a flake, and it is unexplained. Looking for it found the `ps` gap above, which is fixed, but nothing shows that gap caused it.

During one focused run, two `supervisor.test.ts` tests that this change does not touch timed out waiting for a pid file, beside `engine-registry.test.ts`. The file passed alone, 19 of 19, and again with `recovery.test.ts`.

## pnpm check

Typecheck and lint passed. The tests did not, on a machine at load 12 to 20 with a VM taking about seven cores. `pnpm check` itself: 31 failed in 9 files, with 20 worker-start errors, and the output kept no test names. A rerun of the suites gave 28 failed of 3312, in the same kind of files: waits that ran out. The 9 failed files rerun on 3 workers: 282 of 286 passed. The 4 left are in `supervisor.test.ts`, all from the `strayOutliving` helper's 2 s wait for a pid file; 3 of the 4 tests predate this change.

No green full run exists yet, and base `1900dcb` was not run for comparison.

## Not run

- A real command SIGKILL cannot take. The kernel case is faked.
- A real engine.
