# Meta-agent journey checkpoint

Updated 10 November 2026, reconciled with `origin/main` at the v0.3.8 bump (#74). **Execution authorized by the owner and in progress (5 November 2026).** Authority is bounded by the Execution contract below and `docs/DECISIONS.md` #14-66. Sections below "State on 10 November" are history.

## State on 10 November 2026

- **Installed:** v0.3.8 (#74), only `MubitLabs/mec-sandbox` agreed for host runs. Releases 0.3.5 to 0.3.8 were shipped and installed.
- **Shipped since 0.3.4:** #64 OpenCode 2.2.6; #65 Codex lists models and picks only offered ones (gpt-5.6-luna, terra, sol); #66 a finished sign-in checks itself and the link line updates; #67 0.3.5; #68 Codex sandbox (worktree parent stattable, siblings denied by globs, each fileChange journalled; blockers-only review: no blockers); #69 a moved PR head reads in words, Bring up to date behind a push card, GitHub Update branch adopted, "Waiting for GitHub checks" (decision #65); #70 0.3.6; #71 follow-up tasks start from the integration head (decision #66, owner "A"), a replan restarts a changed blocked task, the planner reads a declined push correctly, a fixed result can be pushed after a declined push, the stage shows running work, a stale page says "MEC was updated"; #72 0.3.7; #73 a work leaves Blocked once none of its tasks is blocked, and accepted tasks don't wait behind an unrelated blocked task; #74 0.3.8.
- **Live journeys on MubitLabs/mec-sandbox via Chrome:**
  - OpenCode trot.js: PR #7 merged after MEC adopted the owner's Update branch.
  - CI moved to ubuntu-latest: PR #8, made through MEC, owner's option 2, because the self-hosted mubit-any pool was saturated by a MubitLabs/mubit backlog.
  - Codex gallop.js: PR #9 merged after MEC's Bring up to date.
  - Owner's test "build a horse tinder website": PR #10 ready for review, not merged, as the owner asked. Six tasks across Codex, Claude and OpenCode. Two site bugs passed the repo's npm test: CSS overriding `hidden`, and a global `top` clashing with `window.top`. Each was found in Chrome and fixed through follow-ups.
- **Real runs:** Claude 49 of the working cap of 50, Codex 15, OpenCode 10. Detail in `handoffs/engine-runs.md`.
- **Open:**
  - **Planner cancel resumes work (from #73):** a planner cancel that leaves no task blocked now resumes the work without the owner's go-ahead (decision needed).
  - **Moved-head questions (from #69):** whether to adopt a moved head when the repository has no required checks; whether to withhold Bring up to date when someone else pushed.
  - **Codex fileChange:** the failure seen twice has no known cause (runs 9 and att_7). Edits are now journalled.
  - **Planner placement:** the planner placed a task that needed a browser check on OpenCode, which can't run commands.
  - **UI evidence:** turning on the per-repo "UI evidence required" flag would catch broken pages before the push card.
  - **Real-process timeouts:** the full `pnpm test` times out in real-process suites when the machine is loaded; CI is green.
  - **Wording and windows:** queued-check wording; the 8 s confirm window.

## State on 9 November 2026

- **Installed:** v0.3.4 on the owner's machine, port 61610, real runner on; only `MubitLabs/mec-sandbox` is agreed for host runs. Backups of each prior tarball and a database copy per release are in `~/mec-releases`.
- **Released since 0.3.1:** 0.3.2 (#54 release cards: two-step Deny, no layout shift, checks/diff/commit served, PR body line breaks, card notices; #55 `mec stop` stops the server, declined-push stage, stored answers, Try again on blocked integration; #56 classic shell removed with shortcuts; #57 bump), 0.3.3 (#58 stuck work reads plainly, link in place, no raw codes, drafts, inspector follows a settled card; #59 A never denies, no retry offered that is sure to be refused; #60 bump), 0.3.4 (#61 a lapsed confirm says so, an open stop survives a regroup; #62 bump). Every PR merged through journalled cards with the 9 required checks green (#55 and #58 each went red once, on a JSON format error and committed `node_modules` symlinks, fixed on the same PR).
- **Real evidence (installed):** run 30 on 0.3.1 (shout.js to merged mec-sandbox PR #5) opened decision #48's gate; run 31 on 0.3.2 (clap.js to merged PR #6, `5a9254e`) showed the 0.3.2 card fixes on a real card. Chrome checks on 0.3.3: the stale 6 November wave.js item read in words with "Stop this work and ask again", no dead retry; stopped from the UI. Claude runs: 31 of a working cap of 50 (owner extension, #64). Codex and OpenCode unchanged.
- **Synthetic evidence:** each lane's failing-first tests, mutants (all killed) and screens (1039 passed on the last lane). No separate verifier (owner rule, #41). Full local `pnpm check` not run on this loaded machine; CI is the gate.
- **Decisions added:** #62 (classic removed, #48 gate passed), #63 (declined-push stage, spec §10, coordinator record; owner may overrule), #64 (real-run extension).
- **Open:** a one-press way forward for work admitted under changed repository commands (new server behaviour; owner call); whether 8 s is the right confirm window; Codex and OpenCode composed journey on the final build; phone-width check; `--setting-sources user` loads the linked home's settings; agreed repositories run setup and checks unsandboxed; a low 5-hour usage reading can hide the weekly one.
- **Next action:** owner review of 0.3.4. Further fixes ship the same way: lane, cards, CI, tag, backup, reinstall, Chrome check.

## Goal and decisions

One meta counterpart coordinates coding agents for repo-attached tasks, with complete on-demand activity/evidence. Four confirmed product choices: per-repo conversation/history; autonomous local plan/run but ask before push/PR/merge; tested PR ready for review target, merge separate; routine builder failing/passing checks+mutants, one blockers-only review for standing sensitive cases. Recorded in `docs/DECISIONS.md` #10–13. Legacy unknown history read-only/unassigned and draft persistence are proposed safeguards, not extra owner decisions.

## Current state

- Source: `/Users/shankhadutta/code/mubit-engineering-control`. `origin/main` is `1900dcb` (#47); the overhaul started from base `a102313` (history). Implementation is under way and merged (see State on main). Dirty sibling `/Users/shankhadutta/code/mec` untouched.
- Plan: CHANGE.md; full design: UI-OVERHAUL.md; interactive synthetic preview: ui-overhaul-preview.html; status: agent-progress.html; evidence/commands: VERIFICATION.md; research-user-journey.md, research-orchestration.md, research-observability.md.
- Older `2026-11-05-journey-ux` plan/report/checkpoint superseded; earlier evidence retained.
- Source proves non-fake launch no-op, potential global task ID overwrite, missing authority fencing before real workers, mismatched real HTTP/client contracts and incomplete observations. Source finding is not a failing test run. Installed UI observation is separately labelled; no saved screenshots.
- Source findings above are still source findings. Fixes for them are merged (see Merged on main); the evidence for them is synthetic tests run by the builders. Real-engine evidence: none. Installed behaviour: none.

## Approved-plan execution order proposed

M1: HTTP recovery; repo/canonical identity; repo workspace/submission intent; durable authority commands. M2: real worker vertical slice; continuing coordination; acceptance/integration/delivery; crash/capacity recovery. M3: bounded canonical inspection/freshness; observable UI; complete setup/config; accessibility/packaged local release. Twelve independently valid PR candidates/dependencies and owner modules are in CHANGE.md. Identity/authority gates precede real runner enable. Separate builders/verifiers; no builder self-review.

## Guardrails and recovery

Prior 5 November remote evidence: nine strict required CI checks, no required human reviews/rulesets, linear history, no force push/delete, auto-merge off. Recheck before execution. Screenshot suite outside CI; axe/Lighthouse absent. Release helper independently waits on all checks and uses a conflicting merge method; proposed squash correction uses cards. No protection changes. CI red blocks deploy.

Scratch repos/state first, then owner local install only if authorized. No npm/vendor/account changes, credential reading, automatic data deletion/migration or retention cleanup. Prior artifact rollback does not undo data writes or newer schema; SQL migration needs separately approved backup/compatibility/restore and blockers review. Preserve `.mec/` exclusion and redaction before write. Show unsupported capabilities honestly.

## Execution contract

Owner-authorized, 5 November 2026 (`docs/DECISIONS.md` #14-18; binds this overhaul only).

1. **Release environment (#14):** isolated scratch repositories and state first, then the owner's existing local install.
2. **Rollout authority (#15):** PR creation, merges, version bumps, tags, GitHub Releases, local reinstall and restart, and enabling flags after each increment is verified. Excludes npm publication, vendor or account changes, and any SQL migration or stored-data deletion, which stay separately approved.
3. **Confirmation cards (#23, superseding #16):** every push, PR and merge card opens, settles and journals on a scratch-state MEC server; the operator resolves them by script without per-card owner approval. The owner's ~/.mec gets no build records.
4. **Squash bootstrap (#23, superseding #17):** the bootstrap PR merges through its own repaired squash card; no raw merge.
5. **Real-engine budget (#18):** Claude, Codex and OpenCode, at most 10 bounded runs per engine on scratch repositories or mec-sandbox, through existing slots; stop and ask at the cap. Credentials are never read.

## Exact next action

The combined PR (#47) is merged. 33 B and real Claude runs are in progress on a release candidate (the installed-copy and real-engine checks that #41 moved there). When 33 B is verified: 33 D, release 0.3.0, install and verify, then 33 C, 33 D and 0.3.1. No release, tag, install or flag change has happened; none happens until 33 B is verified. 0.3.0 is held if a worker can reach the approval route in the real test (#44).

## Latest design steering

Owner rejected the modest prior UI preview and requested a full UI and UX overhaul with Apple-like finesse. New design covers all six surfaces, repository sidebar, primary meta conversation, task/dependency presentation, inspector/tabs, approvals, settings/connections/setup, commands/sheets, light/dark and narrow screens. System typography is a proposed amendment to the old Instrument Sans/prototype appearance. Preview is standalone synthetic HTML/CSS/JS, no network/live effects. No production code changed. Visual foundation can run parallel to M1 after design approval; real data wiring still depends on runtime foundations. Parent will inspect visual preview; viewport/theme acceptance remains planned, not verified.


## Prototype review handoff

Parent performed limited CUA visual inspection: improved Conversation hierarchy/model/connection, light/dark Work, contextual Settings inspector suppression, and approval-bound Needs you inspector on sample `7b34c91`. Final default Conversation/Overview ready. Last task-vs-approval evidence/tab correction is source-applied but not broadly regression-tested. No saved screenshot artifacts, product tests, accessibility or responsive checks. Production unchanged.

Live deliverable preview: `http://127.0.0.1:54318/ui-overhaul-preview.html`; parent preview server shell session `66326` served the plan directory at handoff (liveness must be checked before relying on it later). Local file `ui-overhaul-preview.html` remains the durable artifact. Next action is owner design/plan review, then scoped execution authority if approved.

## Wave status

Wave 0 scouting completed at base a102313 (history). Baseline: `pnpm check` has one environment failure only (node-pty spawn-helper lacks execute bit in fresh installs); `test:screens` 21 passed. Scout finding: the card path did not work, because UI approve burned cards without running gh, push had no card, and cards hid their payload; the bootstrap PR therefore repairs the whole path, not only the squash flag. Decisions #19-22 answered four open spec questions. Wave 1 running on local branches, nothing pushed: `fix/release-cards` (bootstrap, carries blockers-only review), `fix/http-recovery` (M1.1), `feat/visual-foundation` (VF0, default off). Next: the operator resolves cards by script on a scratch server running the unmerged fix (#23). M1.4a gets one blockers-only review because it changes who holds authority. Waves 1 and 2 are verified on local branches; decisions #24-36 are recorded; the five base branches are landing serially through scripted cards.

## State on main (reconciled 6 November 2026)

**Merged on main** at `1900dcb`, each through journalled cards: #24 card path, #25 effects, #26 visual foundation, #27 M1.1, #28 records, #29 M1.2, #30 a11y runner, #31 work surfaces on fixtures, #32 M1.4a authority fence, #33 main-gaps fixes, #34 M1.3, #35 M3.1 stage 1, #36 records, #37 M1.4b durable commands, #38 M3.2 stage B (31 B), #39 M2.1 real specialist slice (handoff 20), #40 M3.3 stage A (32 A), #42 records, #43 two bounded timing waits, #44 vendor login from an installed package and a package with no catalogue refused, #45 five gaps before the new shell is default, #46 `mec backup` and `mec restore` with redaction, and #47 the combined M2 ship PR (the replayed 21, 22, 23 A, 23 B, 30 S2, 31 C and 32 stage B work, per its commit list). (#41 is not in this list.)

**Not on main:** nothing from the combined PR. Release candidate work for 33 B is not on main.

**Wave status:** merged: 10, 11, 12, 20, 21, 22, 23 A, 23 B, 30 S1, 30 S2, 31 A, 31 B, 31 C, 32 A, 32 B, 33 A, plus the fixes in #44-46. In progress: 33 B (33 B and real Claude runs on a candidate). Remaining after it: 33 D, release 0.3.0, install and verify, 33 C, 33 D, 0.3.1.

**Evidence labels:** source: the findings above. Synthetic: builders' failing-then-passing tests and the required checks on each merged PR. Real-engine: handoff 20's slice ran a real Claude worker, and its verifier run 3 found a sibling-ref overwrite in the shared clone, fixed in #39 by denying the clone (#40); a real Claude run on 8d1bc80 on macOS then saw the sandbox refuse those writes, and it remains untested on Linux. Installed: none.

**Not done:** nothing is released, tagged or installed. No flag has changed. `classic` stays the default UI.

**Real-engine runs spent:** Claude 15 of 20, Codex 4 of 10, OpenCode 4 of 10 (as counted by the coordinator under #24).

**Unproven, stated plainly:**
- No real-engine run of 22 or 23 A. Their reserved verifier runs are unspent (#41); that evidence moves to 33 B and the installed checks.
- No separate verifier has looked at any change since the owner's ruling (#41). Routine work shipped on the builder's tests and mutants.
- The worker loopback route has not been exercised by a real run.
- Codex and OpenCode have not run on the final build. Their proof follows the release (#42); 0.3.0 is proven on Claude only.
- Nothing has been checked on an installed copy.

**Working method:** stacked branches are started on verified branches. `land.py` takes `ONTO=<old base>` for a stacked rebase. Every landing runs in the coordinator session.

**Decisions since 5 November:** #38 (no inspection index or SQL migration), #39 (land and release as soon as verified), #40 (shared clone denied to a specialist), #41 (pace, reviews and the restart port), #42 (one PR, Claude-only proof) and #43 (a `slot_class` hint is a preference), #44 (owner answers: queued capacity, approval route, `mec restart`, J/A/G W in 0.3.1), #45 (a process group that refuses to die: 0.3.0 ships as built, 0.3.1 holds capacity) and #46 (#44-47 merged, `login-cards` no longer a permitted baseline failure).

**Records not yet applied:** the spec lines proposed by #32 for §6 and §12.5 are not applied. Handoff 12's Stage A/B notes: the flip's revert-alone criterion was waived because squash merges can't keep it.

**Open items:** the full list is in `docs/known-limits.md`. Summary:
- Assigned to handoff 21, whose work is in #47 (the #47 commit list names fixes for the no-evidence 422, planner-write redaction and a pause-time wake; not re-checked item by item here): direct `POST /api/inbox/:id/resolve` still settles a no-evidence non-release card; `#persistExtras` stores planner operation and evidence unredacted (spec §13 invariant 3); `cardDetail` does not redact field names or class; the toast says "agent was told to continue" on a planner card that runs nothing; a late wake after a pause.
- A `{class}`-only `request_confirmation` is deny-only.
- next/work-model `canApprove` must map absent to null when wired (31 B).
- The server logged "stopping on SIGTERM" but stayed alive after a planner turn (handoff 23?). Not reproduced or fixed.
- The cause of the earlier empty real tarball (empty models and prompts) is unknown. The package fix is on main (#44), so it is no longer a known blocker; the release build is still checked for it.
- For 31 C (merged in #47; not re-checked since): raw ISO time in a held row (`inspection.ts:597`), wake rows in search (`inspection.ts:895-905`), and second-tab 409 wording that says "was not sent" though it was sent and refused.
- Restart on a new port leaves an open tab stale: owner ruling needed.
- Check in 33 B whether an engine transcript under `engines/claude/<slot>/` can hold `MEC_TOOLS_TOKEN` (spec line 558, §5.7). Commit 7f2601f cites §12 for "no credential in a backup"; the rule is spec line 558 and §5.7. `mec backup` and `mec restore` exist since #46, with the limits in `docs/known-limits.md`.
- `bundle.test.ts` 6 s health wait can flake under load. The handoff 11 real-run step moved to 20.
- Rule stands: kill processes by PID only (a flaky-test agent's `pkill` was denied; nothing was killed).
