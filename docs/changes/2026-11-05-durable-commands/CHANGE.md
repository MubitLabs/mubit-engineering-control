# M1.4b: Durable commands and truthful launch

**Why.** A retry during planning admitted the message twice. A crash after work was created routed the same message as conversation. An answered question never woke the planner over real HTTP, because the route saved `answered` and the service then refused it as `not_open`. A launch with no runner settled as success. `close` could wait on a stuck turn with no limit, and a drain could start a paid planner turn on the way out. Spec §6, §12.1, §17, §20, §26; decisions #26, #27 and #36.

## What changed

**Message identity.** With an idempotency key the route derives `messageId` (`stableMessageId`, `msg_` plus 24 hex of the sha256). The key goes into the first transaction, through `onUserMessage` into `#saveMessage`, which carries the key and repo over on every later save. The post-await patch in the route is gone.

**Resume before routing.** `#admit` looks at a receipt-less `prior` first. Planning work resumes on the same work item. Ended work gets the stopped receipt with no brain call. Work past planning, which only a wake can cause, gets a note on that work rather than a conversation receipt that loses the work item.

**In-process duplicates.** `#once` keeps a `Map<messageId, Promise<TurnOutcome>>`, so a concurrent retry joins the turn. At the route, a retry with a stored key answers `routing: 'duplicate'` at once from the doc and does not wait. That is what the handoff asked the test to decide: the second request never holds open on the first one's turn.

**Durable wakes.** `enqueueWake` writes a `relay` row, key `wake:<causationId>`, inside the caller's transaction. `onWake` derives its message id from the cause and returns the recorded receipt if there is one, so a row replayed after a crash runs nothing. Callers with no cause, which today are only direct calls in tests, keep a fresh id. `runRelay` is the handler's entry for wakes and resumes.

**The answer.** `onQuestionAnswered` owns the write: compare-and-set, redaction, event and wake in one transaction. The route returns after that commit. An answer on ended work is recorded and queues nothing (§13 invariant 4), with `wake_refused` on the work's stream. The wake-less path also redacts now.

**Boot resume.** `enqueueResumes` queues `resume:<messageId>` for each `new_work` message with no receipt and work in `planning`. The planner is now composed before the first queue pass, so a boot pass finds it.

**Truthful launch.** With no runner, `failLaunch` moves the attempt to `failed` and blocks the work with `no_runner`, then the handler throws. Because the attempt is no longer `queued`, the launch gate would drain a retry as refused, so the handler re-throws for a failed attempt before the gate, and the row runs to `failed` with `last_error`. `deliver`, `note`, `reply`, `external` and `probe` throw `unsupported effect: <kind>`.

**Attempt `failed` (decision #26).** A terminal state from `queued` and `running`, event `attempt_failed`, with the §10 line. The handoff's interim was to leave the attempt `queued` until the owner answered; #26 answered, so the interim does not apply. M2.1 has `failLaunch` as its one place to route failures through.

**Pause (decision #27).** A new request during a pause is stored, with its work item in `planning` and no receipt, and spends no turn. Resume runs `enqueueResumes` after the deadline shift, so the row is due on the next pass. A paused boot skips the scan for the same reason. A relay already running when a pause lands finishes (§20). Messages that need no planner are answered as before.

**Lifetime.** `RealClaudeBrain` is held, and `close` stops the timers and quiesces the brain, so no engine starts from then on, a corrective retry included. It waits for `app.close()` and `settle()` within 10 s, drops any stuck connection, then gives `abort` and the brain's close 1 s, closes the database and releases the lock. `abort` sends the running engine `stop`, which is SIGTERM on Claude. `bin/mec.js` then calls `process.exit`, because an engine child that outlives close keeps its pipes, and those pipes would keep the process up. It never drains (#36, the handoff's shutdown question): pending rows wait for the next boot.

A turn cut short rejects with `Later`, and the service rethrows that instead of running `#failTurn`, which would have stopped the user's work for good. No receipt is written, so a message resumes at the next boot. A relay that ends inside the 1 s grace turns `waiting`, due 30 s after its pass started, with no failure counted. One that ends later fails at its next write and stays `running` for `resumeRunning`. A chat request cut short gets an error, and its message resumes at boot.

**Scratch state.** `keystoreRoot: opts.dataDir`, and the planner's models supplier and protocol read the same root. This commit comes first.

## Intended test changes

- `apps/desktop/test/planner.test.ts`, "records the first answer": the stub now does the write, because the service owns it. Every assertion keeps its meaning.
- `apps/desktop/test/composition.test.ts`, "an effect left running by a crash": moved from `note` to `relay`, since `note` now throws. It needs a meta agent, so it sets the fake flag.

## Outside the handoff's file table

- `packages/domain/src/states.ts` and its test, for #26.
- `packages/meta/src/authority.ts`: `failLaunch`, `launchFailure`, and the block extracted from `refuseLaunch`.
- `packages/meta/src/brain.ts`, `packages/meta/src/real-brain.ts` and `apps/desktop/bin/mec.js`, for the shutdown fixes the verifier asked for. `real-brain.ts` and `brain.ts` also gained `promptsRoot`, for requirement 16.
- `freshId` in `apps/desktop/src/server.ts`. Keyed requests stopped drawing fresh ids, which moved the counter's `z` to `10` rollover onto `GET /api/chat/messages lists newest-last`. The list tie-breaks on id, so the counter is now fixed-width. The test is unchanged.

## Compatibility

- **Storage:** no SQL migration. New fields sit in existing json docs.
- **Contracts:** `packages/contracts` is unchanged.
- **API:** `POST /api/questions/:id/answer` no longer returns `wake`. The web client does not read it.
- **Spec:** §10 for #26, §17 and §20 for shutdown under #36, §20 for #27.

## Risks and limits

- **An answer during a pause wakes late.** `shiftWaiting` moves every waiting row by the pause length, including rows written during the pause. A wake queued an hour into a pause runs up to an hour after resume, and holds later relays until then. Paused messages avoid this because they queue on resume. Fixing it means changing `shiftWaiting` in `packages/store`, outside this handoff.
- **An engine that ignores SIGTERM outlives the process.** `BrainEngine` has `stop` and no kill, so nothing escalates to SIGKILL. The process still exits within the bound, and the child is an orphan until M2.4. If it exits by itself after the lock is gone, the tmpdir `mec-planner-*` stays behind: `close` gave up waiting for the turn, so it never removed it. That dir holds a bearer token for a tools server that died with the process.
- **`kill -9` still orphans the engine.** Nothing here changes that; M2.4 owns it. A boot resume while the orphan runs can have two turns going at once.
- **A resume for a repository that was removed** fails admission on each retry until the row ends `failed`, holding later relays for those minutes.
