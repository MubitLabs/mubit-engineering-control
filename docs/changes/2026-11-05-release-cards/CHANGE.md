# Make the confirmation cards real

## What was wrong

Decision #16 says the owner approves every push, PR and merge on a card. At a102313 that could not be followed:

- Approving a `pr_create` or `pr_merge` card in the workbench called `/api/inbox/:id/resolve`, which settled the record, ran no gh, and burned the card. The UI then said the agent was told to continue.
- Push had no card and no route.
- The card showed a class name and a hash.
- `gh pr merge --merge` is refused on a repository that requires linear history.
- No card bound the head SHA (spec §13: "operation hash, input SHA (when repo-related)").
- A PR behind its base, a SKIPPED check or a red gate each cost the owner something: a spent card, a refused merge, or a deny that was ignored.

## What changed

**The approval is the action.** `/api/inbox/:id/resolve` sends a card with a release payload to `resolveReleaseCard`, which runs the real function and returns what happened. An approve on any other always-confirm card (`branch_delete`, `force_op`, `pr_edit`, or a planner card under a release class with no payload) is refused with 422 `no_executor`, and the card stays pending. Deny still settles those. Ordinary classes such as `install` settle as before.

**Push card.** `POST /api/release/push { repoId, branch, headSha? }` and its resolve route. The git directory is the path a repository was registered with. The GitHub repository is that clone's `origin`. Neither comes from the caller. The default branch is refused, read from GitHub on opening and again on approving, and unreadable means no card. The push is `<sha>:refs/heads/<branch>` with no `+`, so a diverged branch is rejected and nothing can force it. A failed exit reads the remote before reporting failure (§20), and a real failure leaves a redacted `push_failed` event.

**Head binding.** All three cards store the head as `inputSha` and hash it into the operation. On approve the head is read again and passed to the compare-and-set: a moved head settles the card `stale`, and nothing runs. Merges also pass `--match-head-commit`, so GitHub enforces the same thing at the last moment. Cards from before this change have no head; an approve answers `card_unbound`, and they can be denied.

**The merge gate.** The order is now: deny or expiry settles first and reads nothing. Then the PR must be readable, open and on the bound head. Then `gh pr checks --required` decides. Then `mergeStateStatus` must be `CLEAN`, `HAS_HOOKS` or `UNSTABLE`. Any hold leaves the card pending and names the reason. Branch updating stays outside the card.

| Required check state | Reads as |
| --- | --- |
| `SUCCESS`, `NEUTRAL`, `SKIPPED` | passed |
| `PENDING`, `QUEUED`, `IN_PROGRESS`, `WAITING`, `REQUESTED`, `EXPECTED` | `ci_pending` |
| anything else, including a state nobody has seen | `ci_failed` |
| no rows | `ci_pending` |
| gh failed, garbage, or green rows on a failed exit | `ci_unreadable` |
| gh says "no required checks" | `no_required_checks` |

**One compare-and-set.** `settleCard` re-reads the card with no await before the save. Every pre-flight awaits gh, so two answers can both pass it; only this read picks the winner.

**The card says what it approves.** `GET /api/inbox/:id/detail` serves the `DecisionDetail` shape the classic inbox already renders: repository, branch, head, title, body and PR number. The confirm button names the effect, for example "Confirm: squash-merge". A served card brings its own verb, because the old fallback would have said "push and open PR" on a plain push.

**The UI tells the truth.** `describeApproval` (`apps/web/src/release-cards.ts`) turns the result into words. A hold keeps the card open and says why. A failure says the approval is spent. A success names what happened.

**The tray hears cards.** Release stream names are per delivery, so every release event is also written to a fixed `inbox` stream, which the workbench subscribes to.

**Redaction.** Tool stderr, PR titles and bodies now pass `redact()` before they are stored. A key-shaped string in a PR body is sent to GitHub redacted, matching chat.

**`tools/mutants/run.py`.** A stdlib mutant runner every later PR uses, with a `--self-check`. `tools/mutants/release-cards.json` is this PR's spec.

## Intended behaviour changes to existing tests

These assertions changed. None was weakened; each change is the behaviour this PR exists to make.

| Test | Before | After | Why |
| --- | --- | --- | --- |
| `release.test.ts` merge argv | contains `--merge` | equals `pr merge -R <repo> --squash --match-head-commit <head> 12` | Squash, bound head. Stricter. |
| `release.test.ts` pr_create hash | title+body+branch | title+body+branch+head, plus `inputSha` | §13 input binding. |
| `release.test.ts` "calls gh not at all" on open | no gh call | no gh write, and the head read is expected | Binding a head needs one read. A read is not a side effect (§13 invariant 1). The deny test keeps "no gh at all" after opening. |
| `release.test.ts` state-read count | one `view` in the whole flow | one `view` after the merge call | The pre-flight now reads the PR too. The ordering it was protecting is now asserted directly. |
| `release.test.ts` `pushIntegrationBranch` argv | the branch name | `<head>:refs/heads/<branch>` | The exact head, never a moving ref. |
| `server.test.ts` two generic-settle tests | cards of class `push` and `pr_merge` with no payload | class `install` | That settle-without-acting is the bug. The new tests pin the refusal for all release classes. |

## Risks

- **`no_required_checks` holds forever on a repository with no required checks.** That is the fail-closed reading: gh gives the same answer before a required check has started. This repository has required checks, so it is not hit here. It needs an owner decision before MEC is used on a repository without them.
- **`gh pr create` has no head flag.** The head is compared a moment before the call, not at it.
- **The push remote is the URL `gh repo view` reports**, as before. It relies on the user's git credentials working for that https URL.
- **A push card needs a repository registered by local path.** A repository registered by URL answers `repo_not_local`: the bare cache in §14 does not exist in the code yet.

## Not in this PR

- `gh` real-write behaviour. See `VERIFICATION.md`.
- `yieldCheck` and `buildPrBody` stay unwired. The caller writes the PR body.
- Release cards are still opened by HTTP route. No agent flow opens them yet.
- Scout gap 10 (`bin/mec.js` source fallback, `MEC_DATA_DIR` ignored by the CLI and `keystoreRoot`) was not in this brief.
