# An implementer's own notes start no repair, and a repair that finds nothing never cancels the task

Branch `fix/self-findings-and-dropped-repair` from `main` 8584ac1 (v0.3.10). No contract change (`packages/contracts` untouched), no fixture change, no migration, no web change.

## What went wrong

On installed v0.3.10, work item `wi_…sb` ("Add a home page…", mec-sandbox), task `task_…z4p`:

1. att_16, the implementer (OpenCode, `slot_glm-2`), made `index.html` and `style.css` and reported `ready`. Its report carried two artifacts of kind `finding`, each just describing a file it made ("index.html — new home page markup …", "style.css — warm palette …"). Its `npm-test` check passed on `da335fc`.
2. MEC launched att_17 as `repair_agent` with a `repair` continuation in att_16's worktree. The evidence was "Finding on da335fc…: index.html — new home page markup …": the implementer's own notes, read as review findings. No reviewer ran.
3. att_17 rightly reported `dropped` ("Neither finding reproduces as a defect … no fix was applied"). Its checks passed.
4. MEC then cancelled the task (`task_cancelled`, attempt att_17). The good, checked head `da335fc` was thrown away. The work stayed at state `reviewing`, stage Working, with nothing running and no next action.

## Cause

Three faults, all in `packages/meta/src/scheduler.ts`:

- **`findingsOf` read any attempt's `finding` artifacts as findings.** Its comment said "What a reviewer said", but it never checked that the attempt was a reviewer. `acceptanceOf` passes the latest attempt's findings to `acceptance()`, so an implementer's own notes on its head became `{ verdict: 'repair', reason: 'finding' }`, and `repairEvidence` wrote "Finding on <head>: …".
- **`settleOnReport` cancelled the task on any `dropped` report.** For the task's own role, `dropped` means "this task should not be done" (for example, already done upstream), and cancelling is right. For a repair, `dropped` means "nothing here needed fixing": it declines the findings it was sent with, and says nothing against the task.
- **Nothing settled work whose every task had ended.** `settleTasks` blocks the work only when a task is blocked. With the only task cancelled, no rule moved the work from `reviewing`, and the stage table falls through to Working.

What it is not: the repair agent (it reported correctly), the checks (they passed on both attempts), or the head (att_17 left it at `da335fc`).

## What changed

- **`packages/meta/src/scheduler.ts`**
  - `isReviewer` and `REVIEWER_ROLES`: an attempt is an independent reviewer when its continuation is a `review`, or its role is `code_reviewer`, `pr_reviewer` or `security_checker` (the reviewing roles in `packages/domain/src/registry.ts`). `findingsOf` returns nothing for any other attempt. So an implementer's or a repair's own `finding` artifacts never start a repair, and they are not recorded as findings. A failing check still routes to a repair, as before.
  - `settleOnReport`: a `dropped` report from a `repair` continuation no longer cancels. The task goes on to `settleAttempt`, which judges the head it has: acceptance, review where the task is sensitive, UI evidence where the repository requires it, and then integration. A `dropped` report from the task's own role still cancels, as before.
  - `foundOn` (dispositions written when a task is accepted): each reviewer finding is answered by the first repair after its review. If that repair reported `dropped`, the finding is `{ disposition: 'declined', reason }`, where `reason` is the first sentence of the repair's summary, cut to 200 characters (§15: "a declined finding gets one factual sentence"). Otherwise it is `fixed`, as before.
  - `settleEnded`: work in `executing` or `reviewing` whose every task is `cancelled`, with no attempt holding a place, blocks with `every task ended with no result to deliver: <task> was cancelled (<reason>); …`. No task caused that block (`blockedTask` is unset), so `settleBlock` never lifts it by itself, and no cancelled task comes back.
  - `byAge`: the attempt order `latestOf` used, pulled out so `foundOn` uses the same one.
- **`packages/meta/src/index.ts`**: exports `ALL_TASKS_ENDED`.
- **`apps/desktop/src/inspection.ts`**: a block that opens with `ALL_TASKS_ENDED` reads next action "Stop this work and ask again", as a changed-profile block already does, instead of "Resolve what blocks it".
- **`apps/desktop/src/delivery.ts`**: `findingLine` writes a finding's line in the pull request body: `<text> (fixed)`, or `<text> (declined: <sentence>)`.

## The stuck live item after upgrade

**Choice: a plain-words dead end, with no resurrection.** On the first scheduler pass after upgrade, `wi_…sb` meets `settleEnded`. Its one task is cancelled and nothing runs, so the work blocks with "every task ended with no result to deliver: task_1 was cancelled (attempt att_17 dropped it: Neither finding reproduces as a defect. …)". Work shows stage Blocked and next action "Stop this work and ask again". The cancelled task stays cancelled, and nothing is queued. No SQL migration: the ordinary pass does it.

Why not an offer to revive it: no task transition leaves `cancelled` (`TASK_MACHINE`), and adding one would bring cancelled work back from an owner press on a head no one re-judged. Asking again is cheap here (two small static files), and it goes through planning and acceptance like any new work. The old head `da335fc` is still on branch `mec/<work>/<task>/a1` in MEC's cache, untouched.

## Tests

- **`packages/meta/test/repair.test.ts`**, "an implementer's own notes and a repair that found nothing (live, 10 November 2026)":
  - the implementer's own `finding` artifacts start no repair, the task is accepted, and no findings are recorded;
  - a planned `code_reviewer` attempt still finds, and its findings route to a repair;
  - the live replay: a repair sent on self-notes that reports `dropped` is accepted on its head, with no `task_cancelled`;
  - a reviewer's finding that the repair declined is recorded `declined` with "Neither finding reproduces as a defect.";
  - a finding a repair fixed stays `fixed`;
  - each finding is answered by the repair after its own review: one declined, one fixed;
  - sensitive work: a declined repair goes on to the next review of the same head (round 2), not a cancel;
  - a `dropped` report from the task's own implementer still cancels it.
- **`packages/meta/test/repair.test.ts`**, "work whose every task ended (live, 10 November 2026)": the work blocks in plain words, with no `blockedTask`, the task stays cancelled, nothing is queued, and a second pass keeps it blocked. While an attempt still holds its place, the work stays at `reviewing`.
- **`apps/desktop/test/inspection.test.ts`**: such a block reads Blocked, gives the reason, and gives next action "Stop this work and ask again".
- **`apps/desktop/test/delivery.test.ts`**: `findingLine` for fixed and declined findings.
- **Mutants**: `tools/mutants/self-findings-and-dropped-repair.json`, 11 mutants.

## Risks

- **A reviewer in a role MEC does not know.** An ad-hoc reviewing role outside the three built-in ones would no longer have its findings read. The registry has no ad-hoc reviewing roles today, and the planner's roles are the built-in roster.
- **A repair that drops on a red head** is judged by checks, as before: another repair up to the cap, then a block with what remains.
- **A dropped repair on a head equal to the task's base** goes to a `no_change` repair, bounded by the same cap.
- **An integration repair task** (`repairOf`) whose repair drops used to be cancelled. Now it is judged on its head like any repair, and integration takes it from there.
- **The new block covers only `executing` and `reviewing`.** Work in `integrating` is the integration controller's to settle. Held work is blocked too, since it has nothing to resume.
