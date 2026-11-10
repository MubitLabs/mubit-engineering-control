# Yield only to the same change; say so when MEC yields

Branch `fix/yield-same-diff`, base `b8e6b6a` (0.3.11). The fault was seen on installed 0.3.11 on 10 November 2026.

## What happened

Work item `wi_mwav…` on `MubitLabs/mec-sandbox` built a home page (`index.html`, `style.css`). It integrated at `7083832` on `mec/mwavswe7/integration`, `npm-test` passed, and MEC took before and after screenshots. Then delivery recorded `delivery_dropped {yieldTo: "mec/mw9kvv16/integration"}`. That branch is open PR #10, "build a horse tinder website". It is a different site that also adds `index.html` and `style.css`.

Read-only `sqlite3 -readonly` queries of `~/.mec/mec.db` confirm it. `delivery/wi_mwav…` has `stage: 'dropped'`, `repo: 'MubitLabs/mec-sandbox'`, `yieldTo: 'mec/mw9kvv16/integration'` and no other yield field. The last work event is `delivery_dropped`, after `local_result`.

## Cause

Spec §14 says: "the release agent checks for a human branch or PR that already contains the work item's change (the same commits or the same diff) … Related work that does not contain the change is not a reason to yield."

`packages/integration/src/yield.ts` `yieldToDuplicate` yielded when the other branch's file list included every changed path. `apps/desktop/src/release.ts` `yieldCheck` fed it file names only, from `gh pr view --json files` and from `compare … --jq .files[].filename`. Two different changes to the same files therefore read as a duplicate.

The second fault: `Delivery.#deliver` handles no `dropped` stage, and nothing on any surface read the record's `yieldTo`. `inspection.ts` `DELIVERY_STAGES` had no `dropped` entry, so the wire said `none` ("Nothing has left this machine"). The stage table had no row for it, so the item fell through to `working` ("Working"). A dropped delivery also stayed dropped for good.

## Change

1. **The same commits or the same diff (§14).** In `yield.ts`, `yieldToDuplicate` now takes `{path, blob}` per changed file, where `blob` is null for a deletion. A branch yields only when (a) its head contains ours (`containsHead`), or (b) for every changed path its blob equals ours, a deletion matching only a deletion. A path the other side does not show never matches, and an empty change set never yields.
2. **Reading GitHub through the existing `GhRun` seam.** In `release.ts`, `yieldCheck`:
   - lists open PRs with `headRefOid`;
   - reads each PR's files with `gh api repos/{repo}/pulls/{n}/files --paginate --jq '.[] | [.filename, .sha, .status] | @json'`, and each branch's with `compare/{default}...{branch}` and the same row filter;
   - checks the same commits with `compare/{ourHead}...{theirHead} --jq .status`, which must be `ahead` or `identical`. GitHub cannot answer that for a head it has never seen, so it is no.
   All of these are reads. A failed call means no duplicate. The function returns `prNumber` when the duplicate is a PR.
3. **Our blobs.** `delivery.ts` `changedBlobs` reads `git diff --raw --no-renames --no-abbrev -z base..head`. A deleted path gets a null blob. It replaces `git diff --name-only`. `#openPush` passes `head` and records `yieldPr` and `yieldRule: 'same_change'` on `dropped`, and adds `prNumber` to the `delivery_dropped` event. The push-card path and `#reconcile` clear the yield fields.
4. **Recovery (c): checked again once, automatically.** `#deliver` sends a `dropped` record that has no `yieldRule` back through `#openPush`. That covers every record v0.3.11 wrote. The re-check uses the new rule. If the change is not really elsewhere, the delivery goes on to its push card, which still needs the owner's approval (§13). If it still yields, the record is rewritten with `yieldRule: 'same_change'` and is never checked again for that head. There is no SQL migration, nothing stored is deleted, and nothing leaves the machine without a card. A "Deliver anyway" action was not added: under the new rule, a yield means the other side already has our exact content.
5. **Plain words (b).** `packages/domain/src/stages.ts` adds `deliveryYielded(record)` and `yieldedWords(...)`. A `person/yielded` row, labelled "Same change already on GitHub", sits after `person/branch-moved`. Like the declined-card row, it gives way to work under way. It is wired into Work (`inspection.ts` `workRows`) and into the planner context (`packages/meta/src/context.ts`), so chat and Work agree (§10). In `inspection.ts`:
   - the row's reason is "MEC found the same change already on <branch> (pull request #n), so it pushed nothing and opened no pull request";
   - its next action is "Look at pull request #n on GitHub; stop this work if it covers your request", or names the branch when there is no PR;
   - the live line is "Same change already on <branch>";
   - `dropped` maps to `local-complete` on the wire;
   - the detail gets an additive optional `yieldedTo {branch, prNumber}`.
   In the web app, `inspection-wire.ts` and `inspection-decode.ts` take the optional field. In `work-model.ts`, the Delivery section says the same sentence and links `https://github.com/<repo>/pull/<n>`, but only when the stored repo is an `owner/name` slug.
6. **Caption (d).** `work-model.ts` `screenshotCaption` puts no second full stop after a title that already ends its sentence. `WorkView.tsx` uses it.

`packages/contracts` is untouched. The new wire field is between `apps/desktop` and `apps/web` only, and it is optional.
