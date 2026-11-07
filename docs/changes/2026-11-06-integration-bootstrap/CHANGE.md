# Integration and the bootstrap's own output

The installed journey blocked at integration on `MubitLabs/mec-sandbox`. Its bootstrap is `npm install` and it has no lockfile, so `package-lock.json` appeared in every worktree. `commitAll` swept it into the task commit, and `#integrationDoc` wrote it again, untracked, in the integration worktree. `git merge` refused, and the blocked reason said only that a merge had failed.

## What changed

1. **Bootstrap output stays out of a commit (§14).** The launcher and the integration worktree record what a bootstrap left, by content, in the worktree's admin directory (`packages/git/src/bootstrap-output.ts`). `commitWork` keeps those paths out while their bytes are unchanged, including when a specialist's own `git add` or commit took them, and a repair's merge commit does the same. A file the specialist changed commits as usual. The `.mec/` exclusion in `commitAll` is untouched.
2. **A merge makes room for itself (§14).** `clearMergePath` drops whatever is uncommitted on a path the task branch brings, in the integration worktree only, and `integration_output_cleared` records it. Commits are never touched, and neither is any path the merge does not bring.
3. **A refused merge says why.** The reason carries git's own text, and `#pass` redacts it before the write, as it already did.
4. **A person can retry (§11).** `POST /api/work/:id/retry` and a visible action in the work detail. Blocked integration runs again. A declined or failed push or PR goes back to the step that opens a card, so the retry is a new card (§13), never a replay.

## One retry, one effect

The check and the state move share a transaction, so a second press answers `nothing_to_retry`. A pass does the work and skips held work as always. Stopped, held and expired work is refused, and the mandate revalidates first (§10).

## Where the spec is silent

The conservative option each time:

- **Offered only for reasons a retry can answer.** `integration:`, `bootstrap_failed:`, `checks failed on`, `could not run`. `repo_profile_changed`, `policy_changed`, an open or ended repair and `<branch> is not on <sha>` are not offered.
- **`closed` (a PR closed on GitHub) is not offered.** §11 names failed deliveries, and a closed PR was somebody's decision.
- **Uncommitted output in the integration worktree counts as the machine's**, not only recorded bootstrap output, because a worktree from an older build has no record. No agent is in that worktree during a merge: a repair stops the queue.
- **`retry` on paused processing is accepted** and waits for the pass, like everything else while paused.
- **§10's "a new user message releases a blocked item" is not built here.** Retry is the only release this adds.

## Machine change

`TASK_MACHINE` gains `blocked --integration_retry--> accepted`, so a task integration refused keeps its accepted head and starts no new attempt. `packages/domain/test/states.test.ts` pins that table, and its expected list gained this one edge, an intended change.

## Limits

- **A task commit from an older build keeps its file.** Accepted heads are not rewritten, so retried work carries that `package-lock.json` into its PR. The owner can drop it from the branch or decline.
- **A specialist's own commit stays in history.** The net diff drops the file, and the branch's commits still show it.
- **A retried `could not run` leaves dependents blocked.** Their blocks are not retried, so the work can block again on their reason.
- **The classic UI has no retry action.** The route works from anywhere; the action is in the default shell.
- **A later task reusing a bootstrap path merges over the integration's copy.** Checks then run without another bootstrap, as they already did.
