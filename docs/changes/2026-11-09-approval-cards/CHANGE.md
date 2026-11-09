# Approval cards: a safe Deny, the card's own evidence, the PR body as written, notices that clear

Branch `fix/approval-cards` from `origin/main` 7a7dd82. Four findings from a real walkthrough of the installed 0.3.1, all on the push, PR and merge confirmation cards in the new shell. No contract change (`packages/contracts` untouched), no migration, no real engine run.

## 1. Hazard: Deny was one click beside a two-click Approve, and arming moved it

Measured on the old card, in the work harness at 1440, 1024 and 390: Approve is 77.7 px wide at rest and 230.4 px armed ("Confirm: push in sample-console"). Arming pushed Deny about 150 px along the row. Deny settled on one click. The walkthrough denied a push card this way.

- `apps/web/src/next/Decision.tsx`: `Approval` has an optional `denyConfirmLabel`. When it is set, Deny works like Approve. The first click arms it, and announces `Armed: Confirm: deny in <repo>`. The second click denies. Arming one button disarms the other. Escape, any other pointer or focus action, or 8 seconds disarms (the existing `ARM_WINDOW_MS`).
- Both two-step buttons lay out both of their labels in one grid cell (`TwoLabels`). The label not in use is `visibility: hidden` and `aria-hidden`, so it is not seen or read but still takes space. A button is as wide armed as at rest, so arming moves nothing on the row. The cost: Approve is as wide at rest as its confirm label.
- `apps/web/src/next/work-model.ts` `approvalProps`: release cards set `denyConfirmLabel: Confirm: deny in <repository>`.
- The Work view's "Stop this delivery" confirm passes no `denyConfirmLabel`. Its "Keep it" is a cancel that changes nothing, so it stays one click. Its Stop button gets the same fixed width.
- The no-evidence card (`.decision-missing`) still has a single Deny on its own, with no Approve beside it. It is unchanged.

## 2. The push card's Checks and Diff tabs were empty, and the commit was not on the card

`cardDetail` (`apps/desktop/src/release.ts`) served `checks: []` and `diff: 'not served for this card'` for every release card. The web side already renders both (`approvalScope`), so the gap was on the server.

- `release.ts` `cardEvidence(deps, doc)` (new, async) is what `GET /api/inbox/:id/detail` now serves (`apps/desktop/src/server.ts`):
  - **Checks**: the combined checks the integration recorded (`integration/<workItemId>.combined`), served only when `combined.sha` equals the card's bound `inputSha`. A verdict on another head is not this card's, so none is served. `passed` is passed. `failed` and `error` are failed. Each log tail is redacted, then cut to its last 500 characters.
  - **Diff**: `git diff --no-ext-diff --no-renames --numstat -z <work base_sha> <inputSha>` in the work item's `git_dir`. It gives names and line counts only, no file contents (as `measureDiff` does for tasks). The summary reads like `1 file changed, +1 -1, 1a2b3c4 to 5d6e7f8`. At most 300 files are listed. Both ids must look like commit ids before they reach git.
  - A card with no work item or no base on record says `No diff is on record: this card names no work with a base commit.` A git read that fails says the changes could not be read. Neither says "not served".
- The route now passes the whole answer through `scrub()` on the way out, in addition to the per-field redaction.
- `approvalProps` adds a `Commit` fact (the short SHA, monospace) to the card face. It is taken from the served `Head` fact when that is a commit id. The full id stays under the inspector's technical details.
- Planner cards (`plannerCardDetail`) are unchanged.

## 3. The PR body rendered as one line

The `Body` fact went into a right-aligned `<dd>`, so its line breaks collapsed and its markdown table ran together.

- `Decision.tsx` `Frame`, and `Inspector.tsx` `Facts`: a fact value that contains a newline gets class `fact-text`.
- `apps/web/src/next/shell.css`: `.facts dd.fact-text` uses `white-space: pre-wrap`, monospace and left alignment, and is capped at 320 px with its own scroll. Its row stacks under the label. The text is shown as written. No markdown dependency was added.

## 4. "Done: The merge card is in Needs you" outlived the merge

`act({ kind: 'merge' })` set a command notice that only navigation cleared.

- `apps/web/src/live/inspection.ts`: a `card_open` notice carries `cardId`. It clears in two cases: when that card settles here with a closing outcome, and when a Needs read finds that card no longer pending (answered in another tab or from the CLI). Other notices (hold, stop, retry) are untouched. A hold that keeps the card open keeps the notice.

## Files outside the brief's list

- `apps/desktop/src/server.ts`: two lines in the detail route (`await cardEvidence`, `scrub`). The card payload is served from here.
- `apps/web/src/live/inspection.ts`: the toast in finding 4 is set and cleared here.
- `apps/web/src/next/Inspector.tsx`: one line, so the inspector's Overview shows the same PR body as the card.

No change to `apps/desktop/src/mec.ts` or to work stage labels.

## Risks

- Approve and Deny are wider at rest. The screenshot baselines still pass within their 2% tolerance. No baseline was updated.
- The diff is read live from git on every detail read. One `git diff --numstat` runs for each card read, with the existing 30 s exec timeout. The Needs page reads the evidence of open cards one at a time.
- A merge card's `inputSha` is the PR head. If that commit is not in the work's `git_dir`, the diff says it could not be read, and the card can still be approved, as before.
