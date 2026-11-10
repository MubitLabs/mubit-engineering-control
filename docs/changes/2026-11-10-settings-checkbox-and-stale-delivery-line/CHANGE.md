# The screenshots checkbox sits inline; the "Delivery failed" line is not stale

Branch `fix/settings-checkbox-and-stale-delivery-line`, base `8584ac1` (0.3.10). Both findings come from installed 0.3.10 on 10 November 2026. Part 1 is fixed here. Part 2 has no code change: its premise did not hold up, and the right fix is an owner decision (below).

## 1. The "Screenshots before review" checkbox rendered as a large box above its label

**Cause.** `SettingsView.tsx` `UiEvidenceControl` (added in #79) wraps the checkbox in `<label className="field field-check">`. `shell.css` styles every `.field` as a grid and every `.field input` as a full-width field: `width: 100%`, `min-height: max(36px, var(--target))`, padding and a border. Nothing defined `.field-check`. So the checkbox took the full width of the form (560 px measured in Chromium), stood 36 px tall, and sat on its own grid row above its words. The app has no other checkbox. Its radio rows (`.choice-row`, `.answer-choice`) are flex lines with a 16 px box.

**Change.** `shell.css` adds `.field-check` (a flex line, centred, 8 px gap, `--target` tall) and `.field-check input` (16 px square, `min-height: 0`, no padding or margin, `accent-color: var(--ink)`), after `.field input` so it wins at equal specificity. This is the same pattern as `.answer-choice`. No markup changed.

## 2. "Delivery failed: integration: git rev-parse timed out after 60000 ms" on the horse tinder card

The brief said this line was stale: an earlier integration failure that a later retry superseded, with the sequence "delivery failed, then retry, then pr_ready". Read-only queries of `~/.mec/mec.db` show otherwise.

**What the item's events really are** (stream `work:wi_…597y`, last four events):

| seq | at (UTC) | type |
| --- | --- | --- |
| 42 | 2026-11-09 23:57:45 | `task_integrated` |
| 43 | 2026-11-09 23:57:45 | `local_result` |
| 44 | 2026-11-10 00:02:15 | `pr_ready` (PR #10, verdict green) |
| 45 | 2026-11-10 10:28:28 | `work_blocked`, reason `integration: git rev-parse timed out after 60000 ms` |

No `retry_requested` event exists on the stream. The failure came about ten and a half hours after `pr_ready`, not before it. Nothing after it cleared it.

**Store state now.** The work item has `state: 'blocked'` and that `blockedReason`. The delivery record is at `stage: 'ready'` with `prNumber: 10` and `ci: 'green'`, last read at 10:27:06 and with `pollAt` 10:27:34. The integration record has no `failed` and its combined checks passed on the same head.

**How it happened.** `Delivery.#pass` (`apps/desktop/src/delivery.ts:410-427`) re-runs `#work` about every two seconds for each item in `executing`, `reviewing` or `integrating`, ready pull requests included (that pass also polls CI). Under load, one of those passes had a `git rev-parse` time out at 60 s (`packages/git/src/exec.ts:84`). The catch at `delivery.ts:418-425` treats any error as "a state nothing here understands" and blocks the item with `integration: <message>`. A blocked item is not in `OPEN_STATES`, so the pass skips it from then on. CI polling for PR #10 stopped at 10:27, and nothing retries the item unless the owner presses Try again (`retryOffer` offers `integration`).

**Why the row and the footer disagree.** The footer is `work-model.ts` `deliveryLabel`. It shows `delivery.failure` first, and `inspection.ts` `#deliveryFailure` (line 1113) returns the blocked reason when the item is blocked with an integration reason (lines 1132-1135). That reports the store accurately. The Open work row comes from `packages/domain/src/stages.ts` `STAGE_TABLE`. There `person/review` (`deliveryReady === true`, line 143) comes before `person/blocked` (`state === 'blocked'`, line 162), so the row reads "Ready for review" and hides the block, its Try again, and the fact that CI is no longer being read.

**Why no code change here.** Hiding the footer line would hide a block that is real and still in force. The brief's acceptance test ("delivery failed, then retry, then pr_ready") describes a sequence this item does not have. A test built on it would pass against code that never meets this item's real state. The fix that removes the cause is a delivery-behaviour decision for the owner, so it is listed as an open item in `VERIFICATION.md` and the PR body.
