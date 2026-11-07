# Meta agent visibility

The owner, on the installed 0.3.0: "there is no way of knowing what the meta agent is doing and who the tasks or request is delegated to?" A real-browser pass then added seven findings. All on `feat/meta-visibility`.

## What was wrong, with evidence

- **Delegation was never written.** `workDetail` returned a literal `delegation: []` (`apps/desktop/src/inspection.ts`, the old line 965). No code anywhere writes a parent or child attempt: `parentAttemptId` appears only in the read path. The facts always existed on the attempt doc (`slotId`, `placement`, `resolved_model`) and in `session_started`.
- **Answers were not lost in the store, they were never put on the page, or never written.** Two different things:
  - `wi_mw59ad2z390yd5m`: the answer is in `result_reported.summary` on the work stream. Chat shows only `ackText`, so it never appeared.
  - `wi_mw5auzox46qjk53`: lost. The turn ran 18:20:17 to 18:20:44 and stored its acknowledgement ("I'll check its state ... and answer") with `tasksCreated: 0`, no `result_reported`, no question. `PlannerBrain.decide` retries an incomplete turn once and then returns it with `protocolIncomplete: true`, which the service does not read, so `#ackOnlyTurn` files it as a normal turn. Nothing further runs. The item stays `planning`, which reads as Working forever. The protocol invited this: step 4 asked for "one short line on ... why none was needed", and never said the summary is the answer.
- **A question became the newest open work,** so it replaced the blocked delivery in Conversation and took over the heading.
- **Double message.** The server stores the message before the brain runs, and the POST answers only when the turn ends. For that whole time the stored line and the page's echo were both on screen, and the draft stayed in the box.

## What changed

Server:
- `GET /api/inspect/meta`: per repository, the state, a line, the work it concerns, whether a turn is running, and the time of the last real event (or the turn's start). Plus the meta connection, and the model the last turn really started on.
- `MetaAgentService.turnsInFlight()`: running turns, held in memory so a crash leaves nothing claiming to run. The phase comes from the tools the planner has really called this turn.
- `meta/session` in the engines kind: engine and model from `session_started`, written as a turn starts. No migration. It is empty until the first turn on this build, and the page says "model not recorded yet".
- `delegation` on the work detail is now one row per task, from the attempts: who, requested, attempts, placement reason, why it waits, last recorded step. This replaces the `{parentAttemptId, childAttemptId}` shape, which nothing ever filled. It is an intended change to two tests that pinned the empty list.
- `actual.model` prefers what `session_started` reported over the slot's alias (`claude-haiku-5-5`, not `haiku`).
- `turnOutcome` on a work row. A planning item whose turn ended with no task and nothing asked gets the stage `ended/answered` or `ended/no-answer`, from a read of what is stored, so items already in the store are corrected with no data change.
- `replyText` on `GET /api/chat/messages`: the report of a turn that planned nothing, joined by the transaction's shared time because a report carries no message id. `answer` on the work detail is the same text.
- The protocol now says the summary of a question is the answer, and never to promise a later one. This is both the shipped default and the code fallback.

Web:
- A live line in Conversation (`MetaLine`): headline, model and connection, time of the last real event. Text only, nothing animates. It is read every 2 s while something moves, and a turn ending rereads the thread.
- The plan's rows name who got each task, the requested tier and the model that ran. Inspect and Open in Work moved into its footer, so the orphan Inspect above the composer is gone.
- Open work: every other open delivery in the repository, with its state.
- The heading is the repository. `UI-OVERHAUL.md` asked for the request title to lead; the browser pass found it reads wrongly once a newer request arrives, so that line is superseded here.
- Work detail: Delegation lists every task. Delegation, Dependencies, the delivery line, Hold and Stop show only where they apply. An answered question shows its answer instead.
- A send clears the box at once, shows once, and shows status at once. A failed send, or a reload that interrupted one, puts the text back. This reverses "draft clears only on confirmed success", an intended test change.
- Discuss this work moves focus to the composer, and the composer says the next message goes to that work.
- The composer's scope line no longer wraps over three lines beside a truncated toggle.

## The repository dropdown stays, except where it repeats

The brief said to remove it if the sidebar does the same job. It does not: Work and Needs you open on All repositories (`LiveApp.tsx`), which is the first question on those pages, the sidebar has no such option, and Unassigned history is reached through it. With one repository and nothing unassigned, All and that repository are the same list, which is the owner's case, so there it is now hidden.

## Risks

- `replyOf` joins on an exact time. A later write to a message that changes `updatedAt` would lose the join, and the turn would then read as No answer. Nothing writes a `new_work` message after its receipt today.
- A question the planner asked and the owner answered can read as Answered or No answer for the moment between the answer and the wake's turn starting.
- The Open-work list and the plan cover the newest open delivery's detail only: the rest show state, not tasks.
- `fix/delivery-surfaces` owns the question row's stage. Its worktree had no change when this was built, so this branch sets it. Expect a small overlap in `workRows`.
