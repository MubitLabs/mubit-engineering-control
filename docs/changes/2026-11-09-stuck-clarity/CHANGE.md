# Stuck clarity: five findings from installed 0.3.2

Branch `fix/integration-retry`, base 0250aa4 (v0.3.2). The findings come from Chrome on installed 0.3.2, on 9 November 2026. The first three are a blocked work item from 6 November on mec-sandbox with a single accepted task. Findings 4 and 5 came from a real run on the same install.

## 1. The Next line said "Resolve what blocks it" while a retry was on offer

**Cause.** `inspection.ts` `#reasonAndAction`, `person/blocked`: when no delivery had stopped, the Next line was always the fixed `'Resolve what blocks it'`, and `retryOffer` was never asked. The detail served `retry: {kind: 'integration'}`, but the only place that said so was a button below Delivery. Needs you rows come from the same `workRows` (`#workNeedRows`), so they said it too.

**Change.**
- Server: the blocked branch asks `retryOffer`. When a retry is offered, the Next line uses the button's words (`RETRY_NEXT`): *Retry integration*, *Ask to push again*, *Ask to open the pull request again* or *Try again*. With nothing on offer it stays *Resolve what blocks it*.
- Web: `deliveryDetail` gains `lead`, which is the retry action from `workActions`. `WorkView` shows it first in the detail (`.work-lead`), right under the row's Blocked line, and leaves it out of the bottom actions, so there is only one such button. `actions` is unchanged, so the model's order and the existing tests still hold.

## 2. A keyed action from an unlinked tab showed "approval_required"

**Cause.** `live/inspection.ts` `commandFailure` put the raw reason into the toast: "The workbench refused this: approval_required." It is used for retry, hold, lift, stop, merge and question answers. The command notice in `LiveApp` was a plain `StateNotice`, so it had no link. `live/failure.ts` `failureText` did the same for Settings (the host-run agreement). Card answers (`failedOutcome`) and chat sends (`failureText` in `LiveApp`) already said it in words, and their pages already show `ApprovalLink`.

The keyed routes are listed in `server.ts` `OWNER_WORD`: `/resolve`, `/host-run/agree`, `/work/:id/retry`, `/questions/:id/answer` and `/api/chat/messages`. Every path is covered now:

| Path | Words | Link in place |
| --- | --- | --- |
| retry, hold, lift, stop, merge (`act`) | `NOT_LINKED` | new `NotLinkedNotice` in the command notice |
| question answer (`answer`) | `NOT_LINKED` | Needs you's `approvalNotice`, and the chat's `ApprovalLink` |
| card (`settle`) | already in words | Needs you's `approvalNotice` (unchanged) |
| agreement (`failureText`) | `NOT_LINKED` | Settings and Setup `ApprovalLink` (unchanged) |
| chat send | already in words | composer `ApprovalLink` (unchanged) |

**Change.** `approval.ts` holds `APPROVAL_REQUIRED` and the shared words `NOT_LINKED`. `CommandNotice.link` marks a notice as being about an unlinked tab. `ApprovalLink.tsx` gains `NotLinkedNotice`, which reuses the existing link request (`requestApprovalLink`). Once the tab is linked, it says so and asks the owner to press the action again. It never replays the action itself. The known command refusals (`nothing_to_retry`, `host_run_unagreed`, `held`, `mandate_withdrawn`, `terminal`, `done`, `read_only`) now read in words. An unknown code still shows as it is, which keeps the existing "says the server's reason" test unchanged.

## 3. "Delivery failed: repo_profile_changed: this work was admitted under other commands"

**Cause.** `delivery.ts` `#work` (and `attempt-launch.ts`) block work whose pinned `profileHash` differs from the repository's current one. That is §14 ("the checks are the ones pinned at admission") and decision #41 ("Editing a repository keeps refusing admitted work at its next launch (`repo_profile_changed`)"). `#deliveryFailure` and the blocked reason served that text raw. `retryOffer` offers nothing for it, so only Hold and Stop showed.

**What the spec says.** §14 and decision #41 say the work is refused. §10 says a mandate never resumes silently. §12.5 says "Stop … nothing resumes it without a new admission". §11 Retry runs the same step again, and that step would be refused again. No section gives a re-plan route, an "Ask again" for blocked work, or a way to re-admit work under new commands. The brief's fallback therefore applies: plain words, with the Next line *Stop this work and ask again*. No server behaviour was added. Hold and Stop are the only actions, as before.

**Change.** `apps/desktop/src/reason-words.ts` `reasonWords`: a reason that starts with a `snake_case` code gets words in place of the code. The detail stays where it adds something, and is dropped where it only repeats the words (`repo_profile_changed`, `no_commit_identity`, `host_run_unagreed`). An unknown code loses its underscores. `inspection.ts` uses it for the blocked reason, for both delivery-failure branches (the integration block and a delivery record's `error`, such as the release refusals `remote_unreadable` and so on) and for a task's waiting line. Codes swept: `repo_profile_changed`, `bootstrap_failed`, `policy_changed`, `mandate_*`, `repo_mismatch`, `no_runner`, `engine_*`, `auth_required`, `model_refused`, `worktree_gone`, `slot_*`, `unknown_role`, `launch_mismatch`, `no_commit_identity`, `host_run_unagreed`, and the 12 release refusals.

## 4. A sent request came back in the composer the next day

**Cause (inferred, not proven on the owner's store).** `submission.ts` empties the box and stores the frozen payload (`mec-next-pending:<repo>`) for as long as a send is open. A chat POST stays open for the whole planner turn. If the tab closes or reloads before the answer arrives, the next load finds the pending copy. It reads that as "outcome unknown" and puts the text back in the box (`view` → `restore`), even though the server stored the message. A send that does get its answer already clears both copies (existing test "a success clears the draft …").

**Change.** `createSubmissions().landed(repoId, stored)`: a failed or interrupted submission whose idempotency key is in the thread (`sentAlready`, the existing echo check) has landed. Its pending copy is released, and its text is taken out of the draft with `withoutSent`, so anything typed since is kept. `LiveApp` calls it whenever the thread is read. A send still in flight is never settled this way.

## 5. The inspector kept showing a resolved card's Diff

**Cause.** `approvalScope` built the same scope (same id, no status) for an open card and a settled one. After the card was answered, the inspector stayed on its Diff tab and still presented it as the card asking.

**Change.** `approvalScope(item, evidence, outcome)` uses `cardStatus`, the same status the Needs card shows, including an answer this tab gave before the next read. A settled card gets a new scope id, so the tabs go back to Overview. Its context names the status, and the Overview leads with the status and its detail ("Denied · Nothing ran."). `LiveApp` passes the card's outcome. A card that leaves the lists entirely closes the inspector, as before.

## Owner questions

1. **Work admitted under commands that have since changed (§14, #41).** The spec is silent on a way forward, so the row says *Stop this work and ask again*. Should there be a one-press path instead, such as re-admitting the work under the current commands or re-sending its original request? Either one is new server behaviour.
2. **The retry that led to this.** `retryOffer` offers *Retry integration* even when the repository's commands have changed since admission, and the retry is then certain to be refused (`repo_profile_changed`). Not changed here, because the offer cannot see the policy text. Should the offer check the pin?
