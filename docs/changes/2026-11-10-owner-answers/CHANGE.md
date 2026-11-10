# Owner answers of 10 November 2026, and Bring up to date withheld when someone else pushed

Branch `fix/owner-answers`, base ef1e309 (v0.3.8 is installed). Owner decisions #67, #68 and #69.

## What the owner answered

The owner answered four questions on 10 November 2026: "1. yes", "2. yes", "3. yes" and "4. fix them". `docs/DECISIONS.md` #67 to #69 quote the first three questions and answers word for word:

- **#67.** Keep the 0.3.8 behaviour. A block caused by a task clears once no task is blocked, without the owner's go-ahead. A block no task caused still needs the owner. No code change.
- **#68.** (a) Adopt GitHub's Update branch even when the repository has no required checks, with that limit stated. This is the current behaviour (#65 (c), decision #34's stated limit), kept. (b) Withhold *Bring up to date* when someone else pushed to the branch. This change builds (b).
- **#69.** UI evidence on for MubitLabs/mec-sandbox. The repository flag does not exist yet (spec §14 names it, and no repository doc carries it). It is built in a following change and then turned on. Nothing is turned on here.

## Cause

Since #69 (decision #65), `retryOffer` offers *Bring up to date* (`update`) whenever an open pull request is BEHIND or its head moved on GitHub (`updateWords`, `apps/desktop/src/delivery.ts`). `#bringUpToDate` starts from the adopted head, if GitHub still has it, or else from the integration head. It merges the target there and opens a push card for the result. That push is a fast-forward only when GitHub's head is in what MEC built on. When someone else pushed commits to the branch, it is not, so the approved push was rejected as diverged. The offer asked the owner for a decision that could only fail, and the words ("The branch changed on GitHub … MEC won’t merge commits it didn’t check.") did not say that someone else's work was on the branch.

## Behaviour now

`#adoptMoved` already tells a pure base merge from anything else (`baseMergeOf`). When it refuses a head with `not_on_mec_head`, `not_a_target_merge` or `changes_differ`, it now also counts the commits on GitHub's head that are neither on the head MEC speaks for nor on the target (`git rev-list --count <head> ^<speaksFor> ^<target>`, `carriesOthers`). One or more means someone else pushed. The delivery record then holds `headMoved: {sha, at, why, foreign: true}`, and the `head_moved_on_github` event carries `foreign: true`.

- `updateWords` returns nothing for a foreign head, so `retryOffer` offers no `update`, and `POST /api/work/:id/retry` is refused with `nothing_to_retry`. This holds even when the pull request is also BEHIND.
- `movedWords`: "Someone else pushed to this branch on GitHub (now <short sha>). MEC won’t merge over or replace their commits."
- Stage `person/branch-moved` (`packages/domain/src/stages.ts`) is labelled *Someone else pushed to the branch* (`branchForeign`, an optional fact from `deliveryWaiting`). The work row and Needs you show the words above, with Next: *Look at the pull request on GitHub* (the existing no-offer branch in `apps/desktop/src/inspection.ts`). The live line says "Someone else pushed to this branch on GitHub (now <short sha>): <title>".
- What is unchanged: a pull request that is only BEHIND, a head that moved without foreign commits (for example, a branch reset to the target, or put back on MEC's pushed head under an adopted update), a head MEC could not judge (`github_disagrees`, `changes_unreadable`, or a refusal), and adoption itself. All of these still offer *Bring up to date* as before.

`reason-words.ts` needed no new code: the words are written whole, and no stored code reaches the page.

## Files

- `apps/desktop/src/delivery.ts`: `movedWords`, `updateWords`, `#adoptMoved`, `FOREIGN_HEAD`, `carriesOthers`.
- `apps/desktop/src/inspection.ts`: `deliveryLine`.
- `packages/domain/src/stages.ts`: `branchForeign` on `WorkItemView` and `WorkFacts`, `deliveryWaiting`, the `person/branch-moved` label.
- Tests: `apps/desktop/test/delivery.test.ts`, `apps/desktop/test/delivery-surfaces.test.ts`, `packages/domain/test/stages.test.ts`.
- Mutants: `tools/mutants/owner-answers.json`.
- `docs/DECISIONS.md` #67 to #69.

`packages/contracts` is untouched. A record that predates this change has no `foreign` flag, so it reads as before until the head is judged again. A head is judged once, so an already-judged foreign head keeps offering *Bring up to date* until GitHub's head changes again.

## Risks

- **Two Update branches in a row that MEC never saw between them.** The second merge's parent is the first merge, not MEC's head, so the head is `not_on_mec_head`, and the first merge counts as a foreign commit. The words then say someone else pushed, when it was GitHub's button pressed twice. *Bring up to date* would have been rejected as diverged there too, so withholding it is right, but the words overstate. MEC polls far more often than a person presses the button twice, so this is rare.
- A `rev-list` that fails (an object missing from the cache) counts as no foreign commits. The behaviour is then as before, and the words claim nothing they did not see.
