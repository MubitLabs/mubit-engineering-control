# Stop, stages and the stored answer: five walkthrough findings on 0.3.1

Branch `fix/stop-and-stages`, base 7a7dd82. Findings from the owner's walkthrough of installed 0.3.1, 9 November 2026.

## 1. `mec stop` said it stopped and did not

**Cause.** `mec stop` (`apps/desktop/src/mec.ts`, `command === 'stop'`) only wrote the stop marker and printed a success line. It never signalled the server. The premise that the server ignores SIGTERM did not hold up. In the fake-engine path, a real server ends on SIGTERM well inside the bound: `restart.test.ts` already relies on that in its `afterEach`, and the new stop test proves it. `serve.ts` closes, then `bin/mec.js` calls `process.exit()`, so open handles cannot hold the process. Every close step is bounded except `tools.stop()`.

**Change.**
- `restart.ts` `stopServer`: the same proven pid and SIGTERM as `mec restart`, with the same wait (`STOP_BOUND_MS`, 45 s, from the §20 close bounds). It prints `stopped pid N` only once that pid is gone. If the pid is still alive at the bound, it prints `not stopped: pid N did not stop within 45 s; it was sent SIGTERM and is still running` and the command exits 1. A pid that is not proven to be this server is not signalled. Nothing is SIGKILLed, the same as restart.
- `mec.ts`: the marker is written first, then the stop. `CliIo.stopServer` is the new seam.
- `serve.ts` `closeWithin` / `SHUTDOWN_BOUND_MS` (40 s, inside the 45 s a stop waits): a SIGTERM'd server whose close never settles is let go and says so. `composition.ts` bounds `tools.stop()` like the other close steps.
- Help text, `docs/reference.md` and spec §21 now say `mec stop` stops the server.

## 2. A declined push still read "Working"

**Cause.** The §10 stage table had no row for a delivery whose card was declined or whose step failed. The work stays `integrating`, so it fell through to Working.

**Change.** Domain `deliveryStopped(record)` and a `person/blocked` row after `held`, labelled *Push declined*, *Push failed*, *Pull request declined* or *Pull request failed*. Work (`inspection.ts`) and the planner context (`meta/context.ts`) both read it, so they cannot disagree. The row's reason is the retry's own words (`stoppedWords`, shared with `retryOffer`), and its next step is *Ask to push again* or *Ask to open the pull request again*. Because it is a `person` stage, it also appears in Needs you. Spec §10 gains the row. **This is a spec addition from the walkthrough brief. The owner has not ruled on it yet.**

## 3. An old answered question read "stopped without answering"

**Cause.** Before #51, a turn's reports were not yet its answer, and a planner could report against the work a question asked about rather than the question's own item. That item stayed `planning` with no report on its own stream, so it read as *No answer*. The turn wrote that report and the message's receipt in one write with the same `at`. Today's rule (`#ackOnlyTurn`: the turn's last report, wherever it was aimed, is the answer) already treats such a report as the answer.

**Change.** `inspection.ts` `#sameTurnReport`: when an ended turn has no report of its own, Work reads the `result_reported` that the same turn wrote at that instant on its repository's other work streams. It is shown as Answered, with the text. `InspectionReads.eventsAt(streams, type, at)` is the bounded query: stream-keyed, 500-stream chunks. A report written at another time does not count. A turn that really stopped at its acknowledgement still reads *No answer*.

**Unverified.** I could not read the owner's store, so I have not confirmed that the walkthrough item has this shape. The read is right for the shape the code could produce. If the item's answer is stored somewhere else, this does not fix it.

## 4. A blocked integration offered no Try again

**Cause.** When combined checks fail after their task is integrated and the repairs are used up, `openRepairTask` cannot block the integrated task, so it blocks the work with `repairs used up …`. `retryOffer` sends that reason to `ownerRepairOffer`, which only looked for a blocked task, and there was none. No Try again was offered.

**Change.** `scheduler.ts` `integrationRepairOffer`: the work's own used-up block, together with the integration record's open failure on an integrated task, offers Try again. Pressing it (`ownerRetryRepair`) opens one owner repair task in the integration worktree and branch, with the same task shape as `openRepairTask` (shared `saveRepairTask`). The work moves back to `integrating` and `retry_requested` is recorded. A second press finds nothing. Held work, a repository not agreed to host runs, and a record with no failure offer nothing.

**Open.** Not changed: when the failed task was still `accepted`, it blocks itself and the existing Try again reruns it in its own worktree, not the integration worktree. That path offered Try again before this change.

## 5. The conversation's "… is blocked" sentence

`work-model.ts` `blockedSentence`: the title is one sentence naming the work and the reason, for example *Add audit view is blocked: the build broke.* A label the reason already starts with is not repeated. A capitalised plain word is lowercased mid-sentence, while names such as GitHub keep their capitals. The body is only the next step.
