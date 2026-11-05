# Effects no longer run twice

**What.** A job in flight is not picked again, and rows left `running` by a crash resume once at boot.

**Why.** `pickDue` reset every `running` row to pending on each pass, and `composition.ts` starts a pass every 2 s without waiting for the last one. Any handler over 2 s ran twice, overlapping itself, and each later pass started another copy. This also broke the kind's concurrency limit, and `relay`/`note` lost their one-at-a-time rule.

**Design.**

- `EffectsQueue` keeps an in-memory `inFlight` map by kind + key. A later pass skips those jobs, and they count against the kind's concurrency. An ordered kind with a job in flight is busy.
- `resumeRunning()` is a queue method, called once by `startServer` before the first pass. It is deliberately not on the frozen `Effects` contract. `packages/contracts` is unchanged.
- The guard is per job, not per pass. A pass-level guard would hold every kind behind one slow launch, which §11 rules out ("a slow bootstrap delays only its own task"). §11's "one pass at a time" holds for picking, which is synchronous. Handlers keep running across passes.

**Two consequences the guard forced.**

- `drain()` used to finish a live job by re-running it. With the guard it would return at once and `close()` would shut the database under the handler, so it now waits for in-flight jobs.
- Success deleted the row outright. With the guard, a re-enqueue during a run would be lost. Success now deletes only when the payload is unchanged: a new payload stays pending and runs once after, and an identical one is the same job, so a replayed launch (`service.ts` `#replay`) adds no second run.

**Spec gap, for the owner.** §17 covers re-enqueuing a *waiting* key and is silent on a running one. The rule above is this change's reading. A changed payload is kept, but an identical `relay` wake enqueued mid-run is treated as already handled.

**Known limit, unchanged.** A handler that never settles holds its concurrency place until restart, and `close()` waits on it. `drain()` awaited such a handler before this change too. §20's bounded shutdown wait is not implemented here.
