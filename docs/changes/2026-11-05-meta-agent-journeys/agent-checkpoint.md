# Meta-agent journey checkpoint

Updated 5 November 2026, reconciled with `origin/main` at `c842f4f`. **Execution authorized by the owner and in progress (5 November 2026).** Authority is bounded by the Execution contract below and `docs/DECISIONS.md` #14-40.

## Goal and decisions

One meta counterpart coordinates coding agents for repo-attached tasks, with complete on-demand activity/evidence. Four confirmed product choices: per-repo conversation/history; autonomous local plan/run but ask before push/PR/merge; tested PR ready for review target, merge separate; routine builder failing/passing checks+mutants, one blockers-only review for standing sensitive cases. Recorded in `docs/DECISIONS.md` #10–13. Legacy unknown history read-only/unassigned and draft persistence are proposed safeguards, not extra owner decisions.

## Current state

- Source: `/Users/shankhadutta/code/mubit-engineering-control`. `origin/main` is `c842f4f`; the overhaul started from base `a102313` (history). Implementation is under way and merged (see State on main). Dirty sibling `/Users/shankhadutta/code/mec` untouched.
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

Land this records PR, then keep the in-progress lanes (21, 22, 23 B, 23 A, 30 S2) moving and land each as soon as it is verified (#39). After those: 31 C, 32 Stage B, 33 B, 33 D, release 0.3.0, install and verify, 33 C, 33 D, 0.3.1. No release, tag, install or flag change until 33 B is verified.

## Latest design steering

Owner rejected the modest prior UI preview and requested a full UI and UX overhaul with Apple-like finesse. New design covers all six surfaces, repository sidebar, primary meta conversation, task/dependency presentation, inspector/tabs, approvals, settings/connections/setup, commands/sheets, light/dark and narrow screens. System typography is a proposed amendment to the old Instrument Sans/prototype appearance. Preview is standalone synthetic HTML/CSS/JS, no network/live effects. No production code changed. Visual foundation can run parallel to M1 after design approval; real data wiring still depends on runtime foundations. Parent will inspect visual preview; viewport/theme acceptance remains planned, not verified.


## Prototype review handoff

Parent performed limited CUA visual inspection: improved Conversation hierarchy/model/connection, light/dark Work, contextual Settings inspector suppression, and approval-bound Needs you inspector on sample `7b34c91`. Final default Conversation/Overview ready. Last task-vs-approval evidence/tab correction is source-applied but not broadly regression-tested. No saved screenshot artifacts, product tests, accessibility or responsive checks. Production unchanged.

Live deliverable preview: `http://127.0.0.1:54318/ui-overhaul-preview.html`; parent preview server shell session `66326` served the plan directory at handoff (liveness must be checked before relying on it later). Local file `ui-overhaul-preview.html` remains the durable artifact. Next action is owner design/plan review, then scoped execution authority if approved.

## Wave status

Wave 0 scouting completed at base a102313 (history). Baseline: `pnpm check` has one environment failure only (node-pty spawn-helper lacks execute bit in fresh installs); `test:screens` 21 passed. Scout finding: the card path did not work, because UI approve burned cards without running gh, push had no card, and cards hid their payload; the bootstrap PR therefore repairs the whole path, not only the squash flag. Decisions #19-22 answered four open spec questions. Wave 1 running on local branches, nothing pushed: `fix/release-cards` (bootstrap, carries blockers-only review), `fix/http-recovery` (M1.1), `feat/visual-foundation` (VF0, default off). Next: the operator resolves cards by script on a scratch server running the unmerged fix (#23). M1.4a gets one blockers-only review because it changes who holds authority. Waves 1 and 2 are verified on local branches; decisions #24-36 are recorded; the five base branches are landing serially through scripted cards.

## State on main (reconciled 5 November 2026)

**Merged on main**, each with 9/9 required checks, through journalled cards: #24 card path, #25 effects, #26 visual foundation, #27 M1.1, #28 records, #29 M1.2, #30 a11y runner, #31 work surfaces on fixtures, #32 M1.4a authority fence, #33 main-gaps fixes, #34 M1.3, #35 M3.1 stage 1, #36 records, #37 M1.4b durable commands, #38 M3.2 stage B (31 B, live Work, Conversation and Needs you), #39 M2.1 real specialist slice (handoff 20), #40 M3.3 stage A (handoff 32 A). The test diagnostics PR is not on main.

**Wave status:** merged: 10, 11, 12, 20, 30 S1, 31 A, 31 B, 32 A, 33 A. In progress: 21, 22, 23 B, 23 A, 30 S2. Remaining after those: 31 C, 32 Stage B, 33 B, 33 D, release 0.3.0, install and verify, 33 C, 33 D, 0.3.1.

**Evidence labels:** source: the findings above. Synthetic: builders' failing-then-passing tests and 9/9 checks on each merged PR. Real-engine: handoff 20's slice ran a real Claude worker, and its verifier run 3 found a sibling-ref overwrite in the shared clone, fixed in #39 by denying the clone (#40); a real Claude run on 8d1bc80 on macOS then saw the sandbox refuse those writes, and it remains untested on Linux. Installed: none.

**Not done:** no release, tag, install or flag change. `classic` stays the default UI.

**Real-engine runs spent:** Claude 15 of 20, Codex 4 of 10, OpenCode 4 of 10 (as counted by the coordinator under #24).

**Next:** see Exact next action. Decisions #39 (land and release as soon as verified, #15 limits stay) and #40 (shared clone denied to a specialist) are recorded.

**Working method:** stacked branches are started on verified branches. `land.py` takes `ONTO=<old base>` for a stacked rebase. Every landing runs in the coordinator session.

**Records not yet applied:** the spec lines proposed by #32 for §6 and §12.5 are not applied. Handoff 12's Stage A/B notes: the flip's revert-alone criterion was waived because squash merges can't keep it.

**Decision #38 (5 November 2026):** no inspection index or SQL migration for now. Read costs are recorded in `docs/known-limits.md`.

**Open items:**
- Direct `POST /api/inbox/:id/resolve` still settles a no-evidence non-release card (about 3 lines, 422).
- `#persistExtras` stores planner operation/evidence unredacted (spec 13 invariant 3).
- `cardDetail` doesn't redact field names or class.
- The toast says "agent was told to continue" on a planner card that runs nothing.
- A `{class}`-only `request_confirmation` is deny-only.
- next/work-model `canApprove` must map absent to null when wired (31 B).
- The server logged "stopping on SIGTERM" but stayed alive after a planner turn (handoff 23?).
- Blocker for release: the real tarball previously had empty models and prompts.
- One oversized record makes its inspection route answer 500 `response_too_large` until removed (known limit, #38).
- Late wake after a pause: assigned to handoff 21, with the direct-resolve gap, `#persistExtras` redaction, `cardDetail` key redaction and the misleading toast.
- Raw ISO time in a held row (`inspection.ts:597`), wake rows in search (`inspection.ts:895-905`), and second-tab 409 wording that says "was not sent" though it was sent and refused: for 31 C.
- Restart on a new port leaves an open tab stale: owner ruling needed.
- `mec backup`/restore CLI doesn't exist though the spec promises it; check in 33 B whether an engine transcript under `engines/claude/<slot>/` can hold `MEC_TOOLS_TOKEN`. Commit 7f2601f cites §12 for "no credential in a backup"; the rule is spec line 558 and §5.7.
- Owner question: should a repository edit stop admitted work at its next launch (`repo_profile_changed`)? Current behaviour kept.
- `bundle.test.ts` 6 s health wait can flake under load. The handoff 11 real-run step moved to 20.
- Rule stands: kill processes by PID only (a flaky-test agent's `pkill` was denied; nothing was killed).
