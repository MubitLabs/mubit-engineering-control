# A pull request head that moved on GitHub, and checks that wait on GitHub

Branch `fix/moved-head`, base 29f1588 (v0.3.5). Owner decision #65 (9 November 2026, "Say + offer update").

## What happened

Installed v0.3.5 opened MubitLabs/mec-sandbox PR #7 from `mec/mw9erxnp/integration` at c4a7ebd. The repository's `main` has a strict required check (`check`, strict: true). Another MEC PR merged first, so PR #7 went BEHIND. The owner pressed GitHub's Update branch, which made the PR head 63865a9: a merge of `main` into c4a7ebd, with the same PR diff. CI passed and GitHub showed the PR as CLEAN. MEC still showed "integrating / Working", with no merge card and nothing said to the person.

A second finding from the same run: the required checks sat QUEUED for over 20 minutes (the self-hosted runner pool was saturated), and the work only said "Working".

## Cause

- `apps/desktop/src/delivery.ts` `#observe`, on every poll: `if (pr.headRefOid !== doc.head) { movePrFlow(..., 'target_moved'); return notReady() }`. That kept the delivery at `pr_open` with no reading and no words. The stage table (`packages/domain/src/stages.ts`) had no row for it, so the item fell through to *Working*.
- That `movePrFlow` call never did anything. `packages/integration/src/prflow.ts` lists only `ci_green --target_moved--> ci_pending`. `release.ts` `advance()` swallows the invalid-transition throw, so from `pr_open` the call was a silent no-op. It is still harmless from `ci_green`, so it is kept, with a comment. `prflow.ts` is unchanged.
- Pending checks: `#observe` stored `ci: 'ci_pending'` and `ciAt`, but nothing said how long the wait had lasted, and no stage read it.

## Spec

- **§13.** `git push` to a remote is an always-confirm class, and integration merges done locally are autonomous. Invariant 1: no outside effect leaves the machine without a settled approved card. (b) merges locally and pushes only through the existing push card. (c) pushes nothing. It reads GitHub, and adopts a commit that GitHub made.
- **§14.** "Target-branch movement re-runs required checks on the updated integration branch." (b) is that: it merges the target into the integration branch and runs the repository's checks on the exact result. "Merged is confirmed by GitHub, never assumed from an API call" still holds. The merge card still binds the head GitHub reports and still pins `--match-head-commit`.
- **§15.** "A report of ready requires … the relevant checks passed on the reported SHA." An adopted head is ready only once GitHub's required checks are read on that SHA (`#observe` reads them after adopting). The local checks did not run on that exact commit. The owner's (c) accepts this, because the changes are the ones MEC checked, file for file. Nothing in the spec contradicts (b) or (c), so the build went ahead.

## Behaviour now

**(a) Say it plainly.** When GitHub's head is neither the commit MEC pushed nor one it adopted, the delivery record holds `headMoved: {sha, at, why}` and stays `pr_open`. The stage is `person/branch-moved`, *Branch changed on GitHub*, and the item waits on the person, so it is listed in Needs you. Reason: "The branch changed on GitHub (now 63865a9). MEC won’t merge commits it didn’t check." Next: *Bring up to date* when that is on offer, and *Look at the pull request on GitHub* otherwise. The live line says "The branch changed on GitHub (now 63865a9): <title>". The detail serves `delivery.movedTo`. Each head is judged once, with one `head_moved_on_github` event (`from`, `sha`, `why`). If the branch is put back on MEC's head, the words go away. The meta agent's context reads the same stage (`packages/meta/src/context.ts`).

**(b) Bring up to date, behind a push card.** `retryOffer` offers kind `update` when the PR is BEHIND (`mergeStateStatus`, kept as `behind`) or its head moved. Like integration, it waits for the host-run agreement. Pressing it (`POST /api/work/:id/retry`) records `update: {status: 'requested'}`, and the next pass does the following:
1. Fetches GitHub's branch and target into the work's bare cache under `refs/mec/github/<branch>/{head,target}` (`release.ts` `fetchGitHubBranches`). The URL and repository come from `pushTarget`. Nothing goes under `refs/heads/`.
2. Detaches the integration worktree at the adopted head, if one was adopted and GitHub still has it, or else at the integration head. It merges the target there with `--no-ff`, under the repository's commit identity.
3. A conflict is aborted. A failing check, or a merge refused for another reason, is put back. The record then says so: "Bringing it up to date with main conflicted in b.txt. Nothing was pushed." or "… failed the checks on 1a2b3c4: unit. Nothing was pushed." The integration branch, its head and its verdict are untouched, and no repair task opens.
4. On a pass, the branch moves by compare-and-set from the head it was on (`update-ref <branch> <new> <old>`). The integration record gets `head`, `combined` and `diffBase` (the target tip). A `brought_up_to_date` event is written. The existing new-head path then opens the push card: the commit, the checks run on it, and a diff measured from the target, so main's own commits are not listed.
5. On approve, the existing push runs: exactly that commit, no `+` and no force. A branch that diverged on GitHub is rejected, as before. The delivery records the new head, waits for CI and offers the merge card as usual.

A close or a kill mid-check leaves an `updating` marker on the integration record. The next pass puts the worktree back on its branch before integration runs, so the unchecked trial merge is never taken for a move. The request still stands, so it runs again.

**(c) Accept GitHub's Update branch.** A moved head is adopted without asking only when all of these hold:
- the head the delivery speaks for is one of the new head's parents;
- every other parent is an ancestor of GitHub's target tip;
- the merge-base diff against the target matches the one MEC checked, file for file (`git diff --raw`: status, path, new mode and new blob). The old side is the base's, which the target may have moved.

The record then gets `prHead: <new head>`, and a `head_adopted` event gives `from`, `to` and why. The same read goes on to GitHub's checks. `doc.head` stays the integration head, so `#reconcile` does not mistake the adoption for a local move. The merge card still binds the head GitHub reports, which is now the adopted one, so `--match-head-commit` pins it. A rebase, someone's added commit, an Update branch on top of someone's commit, a merge of a side branch, a merge that edits a file, or a GitHub ref that disagrees with `gh pr view`: each of these is (a). A new integration head clears `prHead`, `headMoved`, `behind` and `update`.

**(d) Waiting for GitHub checks.** While required checks are pending, the record keeps `ciSince` (the first read that saw them pending, kept across reads) and `ciQueued` (no required check is IN_PROGRESS). The stage is `waiting/checks`, labelled "Waiting for GitHub checks (queued since 14:02)" or "(running since …)". It waits on the system, so it is in the Waiting group, not Needs you. Reason: "Pull request #7: GitHub has not finished its required checks". The live line uses the label. The detail serves `ciSince` and `ciQueued`, and the page's CI line reads "Waiting for GitHub’s required checks: queued since 14:02. Read 14:25."

## Files

- `apps/desktop/src/delivery.ts`: `#observe` (behind, moved or adopted, CI wait), `#adoptMoved`, `baseMergeOf` and `changesOf`, `#bringUpToDate`, `#putBack`, the interrupted-update guard in `#work`, `retryOffer` (kind `update`), and `movedWords` and `updateWords`.
- `apps/desktop/src/release.ts`: `fetchGitHubBranches` (a read, `pushTarget`'s URL, refs outside `refs/heads/`), `PushTarget.defaultBranch`, and `recordedDiff` measuring from `diffBase`.
- `apps/desktop/src/inspection.ts`: stage facts, the reason and Next lines for the two new stages, the live line, and `DeliveryView.ciSince`, `ciQueued` and `movedTo`.
- `packages/domain/src/stages.ts`: the `person/branch-moved` and `waiting/checks` rows, `deliveryWaiting` and `checksWaitLabel`.
- `packages/meta/src/context.ts`: the same facts for the agent's stage.
- `apps/web`: decoding of the `update` retry kind and the optional delivery fields, the *Bring up to date* label, and the CI wait line.
- No change to `packages/contracts`, so no fixture or CONTRACTS §10 line is needed.

## Where a push can now happen

Pushes still happen in one place only: `release.ts` `answerPush` → `pushIntegrationBranch`, behind an approved `push` card. `#bringUpToDate` moves only the local integration branch. The existing new-head path opens the card (`#reconcile` → `#recordResult` → `#openPush` → `openPushCard`). `fetchGitHubBranches` is a fetch, not a push.

## Owner questions

1. A repository with **no required checks** (decision #34): an adopted head is ready on "no required checks" with the limit stated, as any head is. No check, local or on GitHub, ran on that exact merge commit. Should adoption require reported checks, and otherwise offer *Bring up to date*?
2. When a moved head carries **someone else's commits**, *Bring up to date* is still offered, as the decision says. Its push will be rejected as diverged, and that rejection is said in words. Should the offer be withheld in that case?
