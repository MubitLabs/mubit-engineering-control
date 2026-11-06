# Verification

Touched suites only; the landing runs `pnpm check` once.

Failing first, each seen red for the intended reason and then green:

| Item | Test | Red |
| --- | --- | --- |
| 1 | `authority.test.ts` "a policy change fails the attempt that never started", `composition.test.ts` "a launch under a changed policy", "leaves a running attempt alone" | the attempt stayed `queued` |
| 1 | `scheduler.test.ts` "gives its slot unit back" | `expected [] to deeply equal ['task_b']` |
| 2 | `authority.test.ts` "not proven gone keeps its capacity", four reasons | the attempt went to `failed` |
| 3 | `restart.test.ts`, 7 of 9 | `stop marker cleared; no server was started`, exit 1 |

Green from the start, on purpose, as pins:

- `authority.test.ts` "a policy change cancels no running work (§13)". Both §13 proofs are killed by a mutant that interrupts running attempts.
- `restart.test.ts` "the single-writer lock still holds" and "a restart that honours a stop".

`restart.test.ts` builds both bundles into a scratch install and runs real servers on a scratch `MEC_DATA_DIR`, with `MEC_FAKE_ENGINE=1`. It proves the same port, a new pid, a process group of its own, the same install's launcher, and a server that outlives the command. Stray processes after the runs: 0.

`restart-proof.test.ts` uses real stand-in processes for what a healthy server never does: a pid reused, a SIGTERM ignored, a slow exit, a failed start.

Mutants: `tools/mutants/ship-restart.json`, 29. The first run killed 27. The two survivors showed real gaps, and each got a test:

- "no wait for the old server to exit": a real server closes faster than a new one boots, so nothing saw the wait. `restart-proof.test.ts` "starts only after the old pid has gone" uses a slow exit.
- "the lock reader takes any leading digits": `lock.test.ts` "only starts with a dead pid".

Both then killed, 2 of 2. The other 27 were not rerun after those two tests were added.

Known failure, not from this change: `mec.test.ts` "reads MEC_DATA_DIR when it is set" and "reads ~/.mec when it is not" fail the same way at `857a12a` (`expected 'not answering' to contain ...`). Their snapshot has no `heartbeatAt`, so status never reaches the part line.

Also not from this change: `context-stage.test.ts` "the earliest reset is the one shown" fails with `authority.ts` at `857a12a` too. It fixes its resets at 2026-11-05 and the clock has passed them.

Not run: `pnpm check`, `pnpm pack:internal`, a real tarball install, any real engine, or a restart of a server from before this change. That last path is proven only with a stand-in process.
