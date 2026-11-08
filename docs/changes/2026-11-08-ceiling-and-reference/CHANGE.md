# The 95% ceiling in words, and referenced questions answered

Branch `fix/ceiling-and-reference` from `origin/main` 8d8bc8f. Two fixes, one commit each. No contract change, no SQL migration, no real engine run.

## C1: the utilisation ceiling is 95%, and a wait on it says so

Owner ruling, 8 November 2026: raise the ceiling from 80% to 95% of a connection's limit, which leaves 5% for the owner. When work waits on it, the person sees it in words.

Before: `UTILISATION_CEILING = 0.8` in `packages/meta/src/scheduler.ts`, and a task held by it deferred as `capacity`, which reads "Waiting until a slot unit comes free". That was not true: no unit coming free would release it.

- `packages/meta/src/ceiling.ts` (new) holds `UTILISATION_CEILING = 0.95` and `ceilingWords()`: "Claude account preflight-a is at 96% of its weekly limit; MEC stops at 95%. Resets Tue 10 Nov 07:00". The connection is named by slot kind and label, the window by the reading's window, and the reset in the machine's local time. When no reading gave a reset, it says "When it resets is not known.", never a guess.
- `packages/domain/src/scheduling.ts` `planDispatches`: a new defer reason, `utilisation_ceiling`, used only when every candidate slot is at or over the ceiling, so a unit freeing would change nothing. It carries the least used of those slots. If some candidates are only full, the defer stays `capacity`. The bound did not change: at or above the ceiling, nothing new starts.
- `packages/meta/src/scheduler.ts`: a ceiling defer stores those words as the task's `releases`, and posts one chat notice on that work (`msg_ceiling_<workItemId>`, routing `notice`) the first time it waits for this reason. Later readings update the task's words, not the chat line.
- `apps/desktop/src/core-facts.ts` `rateLimitObserved`: the slot doc keeps `usageWindow` and `usageResetsAt` with `usageUtilization`, from the same reading.
- `apps/desktop/src/inspection.ts`: Delegation shows the words as they are (no "until"). A Work row in `working` with a ready task waiting on the ceiling has the reason `Waiting: …`. The live line says the same in place of "No specialist is running on …".
- Needs you: not applicable. A ceiling wait asks nothing of the person, so no card or row is added.
- Spec §11 Caps now says 95% (owner, 8 November 2026) and describes the words. `docs/reference.md` "How a task gets its slot" names the value.

### Other readers checked

- `packages/engines/src/codex/protocol.ts:224` maps Codex's `usedPercent >= 80` to the rate-limit event's `warning` status. That label copies the vendor's own warning, and nothing in MEC reads `warning` to gate placement, so it was left alone.
- `apps/web/test/mocks.ts:427`, a mock slot's note "New work goes elsewhere above 80%." It feeds the screen fixtures and their pixel snapshots, so it was not changed here. It is stale.
- The planner's context prints a slot's utilisation and its prompt says "above its utilisation ceiling" with no number. Probes and readiness do not read the ceiling.

## C2: a question sent by reference to running work gets an answer

Real evidence (`real4/Q-2026-11-08T11-15-47-368Z`): "How far along is this? One sentence." sent by reference to the running slow task was acknowledged "Noted on …: it lands with the running work." and handed to the specialist, which read it at end of turn. The same kind of question without a reference got a planner answer in chat (decision #52).

- `packages/meta/src/service.ts` `#admit`: a referenced message that `isQuestion()` accepts, sent while an attempt owns that work (`followups.ownerOf`), goes the question route: its own `questionOnly` work item, a planner turn told it can only answer, and the answer in chat. It is never delivered to the specialist, and the running work is unchanged. The turn's detail names the work it asks about (`about wi_…`), on resume as well.
- A referenced message that asks nothing keeps today's route to the specialist. A referenced question with nothing running keeps today's turn on that work.
- Spec §12.3 gains the exception (owner, 8 November 2026, under the §12.1 ruling).

## Risks

- `usageUtilization` holds the last reading of any window. A low five-hour reading after a high weekly one hides the weekly one. This was already so before this change. It now also decides which window the words name.
- `isQuestion` leans to a turn, so a referenced instruction phrased as a question ("Can you also cover the export button?") is answered, not delivered. The person can send it again as a statement.
- The reset is shown in the server's local time zone, which is the person's on a local install.
