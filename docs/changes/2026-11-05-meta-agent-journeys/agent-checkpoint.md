# Meta-agent journey checkpoint

Updated 5 November 2026. **Execution authorized by the owner and in progress (5 November 2026).** Authority is bounded by the Execution contract below and `docs/DECISIONS.md` #14-22.

## Goal and decisions

One meta counterpart coordinates coding agents for repo-attached tasks, with complete on-demand activity/evidence. Four confirmed product choices: per-repo conversation/history; autonomous local plan/run but ask before push/PR/merge; tested PR ready for review target, merge separate; routine builder failing/passing checks+mutants, one blockers-only review for standing sensitive cases. Recorded in `docs/DECISIONS.md` #10–13. Legacy unknown history read-only/unassigned and draft persistence are proposed safeguards, not extra owner decisions.

## Current state

- Source: `/Users/shankhadutta/code/mubit-engineering-control`, base `a102313`. Planning records and dated decision append only; no commits. Dirty sibling `/Users/shankhadutta/code/mec` untouched.
- Plan: CHANGE.md; full design: UI-OVERHAUL.md; interactive synthetic preview: ui-overhaul-preview.html; status: agent-progress.html; evidence/commands: VERIFICATION.md; research-user-journey.md, research-orchestration.md, research-observability.md.
- Older `2026-11-05-journey-ux` plan/report/checkpoint superseded; earlier evidence retained.
- Source proves non-fake launch no-op, potential global task ID overwrite, missing authority fencing before real workers, mismatched real HTTP/client contracts and incomplete observations. Source finding is not a failing test run. Installed UI observation is separately labelled; no saved screenshots.
- No implementation, tests, mutants, builds, real model turn, PR, merge, tag, release or reinstall. All acceptance pending. No new feature flags exist; proposed capabilities default off.

## Approved-plan execution order proposed

M1: HTTP recovery; repo/canonical identity; repo workspace/submission intent; durable authority commands. M2: real worker vertical slice; continuing coordination; acceptance/integration/delivery; crash/capacity recovery. M3: bounded canonical inspection/freshness; observable UI; complete setup/config; accessibility/packaged local release. Twelve independently valid PR candidates/dependencies and owner modules are in CHANGE.md. Identity/authority gates precede real runner enable. Separate builders/verifiers; no builder self-review.

## Guardrails and recovery

Prior 5 November remote evidence: nine strict required CI checks, no required human reviews/rulesets, linear history, no force push/delete, auto-merge off. Recheck before execution. Screenshot suite outside CI; axe/Lighthouse absent. Release helper independently waits on all checks and uses a conflicting merge method; proposed squash correction uses cards. No protection changes. CI red blocks deploy.

Scratch repos/state first, then owner local install only if authorized. No npm/vendor/account changes, credential reading, automatic data deletion/migration or retention cleanup. Prior artifact rollback does not undo data writes or newer schema; SQL migration needs separately approved backup/compatibility/restore and blockers review. Preserve `.mec/` exclusion and redaction before write. Show unsupported capabilities honestly.

## Execution contract

Owner-authorized, 5 November 2026 (`docs/DECISIONS.md` #14-18; binds this overhaul only).

1. **Release environment (#14):** isolated scratch repositories and state first, then the owner's existing local install.
2. **Rollout authority (#15):** PR creation, merges, version bumps, tags, GitHub Releases, local reinstall and restart, and enabling flags after each increment is verified. Excludes npm publication, vendor or account changes, and any SQL migration or stored-data deletion, which stay separately approved.
3. **Confirmation cards (#16):** every push, PR and merge card opens on a scratch-state MEC server and the owner clicks each one; the owner's ~/.mec gets no build records. Decision #8's scripted resolve is not used.
4. **Squash bootstrap (#17):** release.ts merges with --merge, which linear history refuses. The PR correcting it to squash is squash-merged by the owner by hand on GitHub, once; no agent runs a raw merge. Later merges use the repaired card.
5. **Real-engine budget (#18):** Claude, Codex and OpenCode, at most 10 bounded runs per engine on scratch repositories or mec-sandbox, through existing slots; stop and ask at the cap. Credentials are never read.

## Exact next action

Wave 0 scouting running. Bootstrap order: the squash card fix goes first because every other merge depends on it, and that PR also lands the planning records.

## Latest design steering

Owner rejected the modest prior UI preview and requested a full UI and UX overhaul with Apple-like finesse. New design covers all six surfaces, repository sidebar, primary meta conversation, task/dependency presentation, inspector/tabs, approvals, settings/connections/setup, commands/sheets, light/dark and narrow screens. System typography is a proposed amendment to the old Instrument Sans/prototype appearance. Preview is standalone synthetic HTML/CSS/JS, no network/live effects. No production code changed. Visual foundation can run parallel to M1 after design approval; real data wiring still depends on runtime foundations. Parent will inspect visual preview; viewport/theme acceptance remains planned, not verified.


## Prototype review handoff

Parent performed limited CUA visual inspection: improved Conversation hierarchy/model/connection, light/dark Work, contextual Settings inspector suppression, and approval-bound Needs you inspector on sample `7b34c91`. Final default Conversation/Overview ready. Last task-vs-approval evidence/tab correction is source-applied but not broadly regression-tested. No saved screenshot artifacts, product tests, accessibility or responsive checks. Production unchanged.

Live deliverable preview: `http://127.0.0.1:54318/ui-overhaul-preview.html`; parent preview server shell session `66326` served the plan directory at handoff (liveness must be checked before relying on it later). Local file `ui-overhaul-preview.html` remains the durable artifact. Next action is owner design/plan review, then scoped execution authority if approved.

## Wave status

Wave 0 scouting complete at base a102313. Baseline: `pnpm check` has one environment failure only (node-pty spawn-helper lacks execute bit in fresh installs); `test:screens` 21 passed. Scout finding: the card path did not work, because UI approve burned cards without running gh, push had no card, and cards hid their payload; the bootstrap PR therefore repairs the whole path, not only the squash flag. Decisions #19-22 answered four open spec questions. Wave 1 running on local branches, nothing pushed: `fix/release-cards` (bootstrap, carries blockers-only review), `fix/http-recovery` (M1.1), `feat/visual-foundation` (VF0, default off). Next: owner clicks push and PR cards on a scratch server running the unmerged fix, then hand-squash-merges that PR once. M1.4a gets one blockers-only review because it changes who holds authority.
