# Journey-first UI and UX pass — superseded

Superseded on 5 November 2026 by [the full meta-agent product/journey plan](../2026-11-05-meta-agent-journeys/CHANGE.md). Earlier observations remain historical evidence; no implementation resulted from this narrower plan.

Date: 5 November 2026. Base: clean `main` at `a102313` in `/Users/shankhadutta/code/mubit-engineering-control`. This record proposes changes; it does not claim implementation, approval, or release.

## Outcome

An owner can get ready, request work, understand progress, answer or approve, recover, and recognize the result without learning internal identifiers or losing context. Evaluate every action by its entry point, intent, prerequisites, next step, feedback, failure/retry, cancellation, and return destination.

Canonical behavior: `docs/plan/spec.md` §§5, 10, 12–16, 18, 20–21. Visual target: `docs/review/2026-11-04/04_UI_DESIGN_SPEC.md` §§2, 5–10 and `docs/design/prototype/`. Resolve any behavioral ambiguity against the numbered spec and owner decisions before implementation.

## Approach and alternatives

**Recommend complete journeys in vertical slices.** Pair each small UI repair with the real read/action needed to complete that journey. Verify it before a dependent slice. Surface-only polish is faster but leaves loading dead ends and misleading progress; blanket route expansion improves coverage but risks another broad release before any one journey works end to end. Retain the reference tokens, component classes, quiet appearance, and honest states.

## Initial walkthrough findings

These are observations reported by the computer-use coordinator in the installed workbench at loopback port 60432, not results from this checkout's build. The observed subset is distinct from the planned full journey inventory below.

| Priority | Journey and observation | Proposed resolution and acceptance |
| --- | --- | --- |
| P0 | Settings navigation blanks the entire app; console reports `TypeError n.find is not a function`; reload remains blank. Hash navigation to Chat alone does not recover; a full reload on Chat restores the shell. | Diagnose and repair the Settings crash; a response/consumer shape mismatch is a hypothesis, not an established root cause. Validate boundary shapes, preserve shell/navigation, and show an actionable local error. All five Settings tabs load or explain unavailable data without crashing. |
| P1 | Returning to Work shows internal IDs as titles. Selecting Working opens a pane that remained “Loading the work item…” across about two minutes. | Use a real request-derived human title; keep IDs in folded details. Serve the real detail or a finite error/unavailable state with retry. Show origin, actual state and next step; never substitute another item's sample data. |
| P1 | Chat displays “Planning · 0 of 0 tasks”; only user messages were present in the inspected conversation. | Separate planning from measurable task execution; zero tasks is “Planning the work,” not a progress denominator. Show actual acknowledgement/plan/status when available and explain a stalled/error state when established. No new model send was performed during planning. |
| P1 | Slots → Add a slot jumps straight to an API-key form, while Setup offers three connection paths. | Use the spec §18 engine → provider → connection → validate → done journey consistently. Existing-login and dedicated-slot paths remain discoverable; never request credentials in chat. |
| P1 | Setup Continue allowed advancing past connection and repository entry to the meta slot; Finish appeared at the fourth of five displayed sections. Finish was not clicked. | On a scratch state directory, reconcile actual step prerequisites and numbering with §21. Existing valid configuration may satisfy a step; missing required configuration must explain what is needed. Completion summarizes the selected configuration and leads to the first request. |
| Question / verify spec | Chat reply chip names an internal ID. Clear removes it immediately; it returns after reload. | Use a request title for context. Establish the intended persistence semantics from §12 before calling this a defect; test clear, navigation and reload accordingly. |
| P2 | Healthy Slots displays usage-not-served copy. | Preserve truthful unknown readings, with an intelligible explanation and useful next action where one exists. Never replace absent readings with zero or invented numbers. |

Needs you was empty and appeared normal. Light Chat and dark Work/Slots were seen; the full theme matrix was not completed. Slash focused the composer; Escape then G/W navigated to Work. Escape closed the Work pane and restored focus to the originating row. Cmd+K opened Commands; Escape closed it. Auto theme was restored. Approval, question, quota, expired-login, real planner, setup completion and final delivery remain unverified. Screenshots were observed in the tool; none have been saved as evidence files.

## Concrete interaction proposal

The static **Proposed** preview in `agent-progress.html` shows a returning owner's Work → Details journey and a contained Settings error. All example request text is illustrative, not operational evidence. Work rows use a recognizable request title, one plain-language state reason and a next action. Details preserve that title and provide source request, current evidence and return context; unavailable data has a finite state and retry. A Settings failure stays within the Settings pane and leaves navigation usable. The final visual treatment must use the existing prototype's tokens and classes.

For every journey: preserve draft and selected context on recoverable failure; name the pending operation; distinguish received/running/completed; disable duplicate submits while pending; show completion where the action began; make cancellation and return destinations explicit. Irreversible approvals retain exact-operation evidence, two-step arming, ≤8-second disarm, and truthful resolved/expired states.

## Independently mergeable sequence

1. **Restore routes and contain errors.** Diagnose and repair the Settings crash (a response/consumer mismatch is only a hypothesis); preserve the shell and navigation when a pane fails. Builder adds a failing real server-contract regression plus malformed/failed load cases. Verifier opens all five tabs from a fresh session and confirms shell recovery. No flag needed for a complete repair of existing behavior.
2. **Recognize requests, progress and results.** Real work titles/details and necessary task/attempt reads, finite unavailable/error states, plain-language planning, reply-context behavior and request/send lifecycle. Builder proves actual endpoint shapes and routing, including missing records and delayed responses. Verifier follows Chat → Work → Details → task/result → return against scratch state. A bounded real-engine request requires the agreed quota scope; fixture tests never count as proof of launch.
3. **Get ready and connect capacity.** Consistent add-slot paths, accurate five-step Setup numbering/prerequisites, validation, cancel/return and completion. Existing valid configuration may satisfy steps. Verifier uses scratch state; the owner enters credentials. Verify existing-login, dedicated-slot and API-key entry paths without the agent reading credentials; no account changes in this scope.
4. **Answer, approve and recover.** Remaining real reads/actions needed for questions, evidence, hold/stop/resume and capacity recovery. Same cards in tray/Needs you, resolved/expired states, safe countdowns and keyboard focus. Preserve exact SHA/effect binding and two-step approval. Absent source data stays unavailable. One blockers-only review applies if permissions/sign-in behavior changes; no unnecessary independent review otherwise.
5. **Complete themes/accessibility and release the verified package.** Per-bug regression and keyboard coverage lands with each earlier slice; this slice completes the both-theme/narrow-layout matrix and axe/Lighthouse validation. Record and address screenshot CI coverage in the approved scope. Bump three package versions before tagging. Release through confirmation cards and verify installed artifact after hard refresh. Current release helper check/method conflict must be resolved before shipping, without bypassing protections.

Each slice's verifier records the installed version, flag state, entry → intended outcome, failure/retry, cancel/return and keyboard behavior after deployment before dependent work begins.

Each PR works independently. No broad mock-fallback deletion or unrelated framework/dependency upgrade. Keep contracts frozen unless an approved additive change includes fixtures and CONTRACTS §10. Preserve `.mec/` commit exclusion, secret redaction before writes, and single-writer isolation.

## Complete action/journey inventory

Every row must be verified from a user's point of view: **entry → preconditions → action → visible feedback → next step/outcome → recovery or cancellation → return focus/context**. This is planned coverage, not a claim that the walkthrough exercised every action. The verifier records each state separately.

| Journey | Entry and prerequisites | Action, feedback and next step | Failure, cancellation and return |
| --- | --- | --- | --- |
| First request | Chat; configured repository and meta slot | Submit → received acknowledgement → plan/tier/slot → actual launch → result | Preserve draft on failure, prevent duplicate submit, show actionable stall/error; return to request |
| Follow-up / clear context | Conversation or selected work; explicit target | Recognizable reply title → send to intended work; Clear removes current reply intent | Resolve reload persistence against §12, ambiguity asks once; failed send preserves intent/draft |
| Hold / stop / resume | Live work with supported action | Name exact scope and consequence, pending feedback then actual state; resume only from supported state | Failure does not claim completion; retain context, offer allowed retry; verify stop semantics without destructive live tests |
| Work / task / result | Work row or Chat Details; identifiable request | Open real source, state, tasks, slot/model/check evidence, final PR/result | Finite missing/error state, retry; close/Escape restores originating focus; no unrelated fixture |
| Approve / deny / expire | Needs you or tray; actual pending effect | What/why/consequence + evidence → arm → confirm within ≤8s; deny one step; retain resolution | Disarm on other action/Escape/timeout; expiry accurately records nonapproval; counts update consistently |
| Answer a question | Shared tray/list; pending specialist question | Choices or Answer in chat → explicit reply context → resolution record → work continues | Retain draft on send failure; prevent repeated answer; cancel returns without inventing answer |
| Connect a slot | Slots → Add; engine/provider chosen | Existing login / dedicated / API key → owner connection → validate → healthy → return | Explain failed probe; retry/cancel preserves nonsensitive choices; credentials only owner form/vendor flow |
| Validate / replace / retire | Existing slot; supported state and effects | State prerequisite/consequence before action; report actual probe/replacement/retirement | Agent never reads or enters credentials; permission/data effects outside default scope; blocked action explains why |
| Login / quota / switch | Actionable slot or parked work notice | Sign in or choose allowed replacement; name what resumes and where; honest usage/reset reading | Preserve same worktree and evidence; unknown stays unknown; failure offers supported recovery |
| Setup five steps | Setup on scratch state; existing configuration distinguished | Detect engines → connect/validate → repo/check profile → meta slot → first-request summary | Step counts/prerequisites consistent; Back/Continue/cancel do not discard draft or report false completion |
| Prompts | Settings → Prompts; real catalogue/revision | Select/edit → save bar → save revision → truthful running-attempt revision notice | Preserve stale/failed draft; compare new default to override/history before accepting replacement |
| Models | Settings → Models; real tier/availability information | Understand configured ladder and provenance; supported edits persist with feedback | No fabricated availability/prices; unavailable data explained; failed save keeps draft |
| Policy and remaining Settings tabs | Five actual tab labels from app, real schemas | View/edit supported configuration → validate → save revision/hash; one save bar | Recoverable field/schema error, stale draft retained; no shell crash; do not invent absent tab features |
| Backups | Settings/Commands; supported backup operation | Explain included/excluded data → pending → actual completed run/list | No fake list/success; retry supported failure; restoration/migration excluded from default scope |
| Global actions | Rail/Commands; clear scope | Cmd+K routes/actions, theme, navigation, Pause all/Backup only with actual supported operation | Escape closes; focus restored; drafts survive route changes; global pause clearly distinguishes pending/resumed state |

## Acceptance and flags

- Each covered journey has a written entry → outcome case plus failure, retry/cancel and keyboard-only return case.
- No Settings tab crashes the shell; no detail view remains indefinitely loading; no live record shows invented fixture data.
- Human request titles identify work consistently; IDs stay in folded details. Progress expresses actual known state.
- Setup step labels match the actual sequence and prerequisites. All supported connection paths are reachable from Slots.
- Reply routing, approval consequences and completion are explicit; drafts survive recoverable failures.
- Both themes, narrow layouts, visible focus, modal semantics, focus return, reduced motion and meters meet design §§8/10. Axe has no violations; Lighthouse accessibility reaches ≥95 per route.
- Builder supplies relevant failing-then-passing regressions and mutants; verifier supplies independent real-behavior evidence. Synthetic tests do not establish real-engine gates.
- Changed/new unfinished paths stay behind a proposed local `journeyUx` flag, default off; the flag is not currently implemented. Complete existing-behavior bug repairs need no flag when independently verified. Each flagged slice has a documented enable/disable path, old-path fallback and cleanup criterion. No flag grants authority or bypasses a confirmation.

## Guardrails verified on 5 November

Read-only GitHub API inspection: `main` requires nine checks with `strict:true`: static, suites A/B on Node 22/24, production audit, credential-path compliance, install smoke on Ubuntu/macOS. Required PR reviews are null; rulesets are empty; linear history required; force-push/delete forbidden. Admin enforcement is off, but bypass is prohibited. Auto-merge is disabled. Latest merged PR #23 has a Copilot COMMENTED review; that is not a required approval. Standing 22 October review rules override the older blanket cross-review wording.

`apps/web/playwright.config.ts:10–12` explicitly excludes screenshot tests from CI; they use mocked API routes. No axe/Lighthouse enforcement or existing UX rollout flag was found in the inspected source. Existing screenshots/unit suites do not establish a real-store or real-engine journey.

`apps/desktop/src/release.ts:494–526` separately requires every check to succeed. Its `--merge` at line 563 conflicts with linear history and the handoff's squash requirement; plan a targeted compatible release-path correction rather than bypass it. If the owner wants the standing no-wait-for-CI policy applied remotely, only the owner runs `gh api --method DELETE repos/MubitLabs/mubit-engineering-control/branches/main/protection/required_status_checks`; no such change has been made, and it alone would not change MEC's application gate. Until reconciled, current checks remain binding.

Tag release workflow runs full check → tarball → Linux/macOS install smoke → GitHub Release. npm publish remains disabled/owner-gated. Remote push/PR/merge uses journalled confirmation cards, never raw commands. Decision #8 authority expires at R2 exit per #9; the execution agreement must establish current authority.

## Risks, rollout and recovery

- Installed bundle, this clean checkout and the heavily dirty `/Users/shankhadutta/code/mec` are distinct. Do not infer the observed runtime defect's source without reproducing on the chosen candidate. Leave the dirty checkout untouched.
- No credential reads or agent-handled credential entry. No sends or store/config submissions during planning; transient UI selections/theme changes were exercised and Auto restored. Scratch data must respect SQLite consistency and avoid copying keystore material. Do not casually copy active WAL files independently; use an approved consistent database snapshot when needed.
- Preserve real action semantics when replacing mocks; missing source data means unavailable, not guessed content. Bound reads and show errors without hiding evidence failures.
- Recovery is disable the new local flag or reinstall a preserved prior versioned artifact; neither reverses database writes. Avoid migrations/data deletion in this pass. Existing installer overwrites app files before native build and has no automatic rollback, so preserve prior artifacts before any authorized reinstall.
- Verify the packaged candidate in scratch state first. Enable only the agreed environment/slice, independently verify behavior after installation and hard refresh, and pause dependent rollout on failure.

## Roles and review boundary

Coordinator owns scope, dependencies and evidence. Separate implementer agents own bounded web/server slices; a different verifier exercises acceptance against the candidate and installed artifact. Do not let a builder review its own change. Default merges use builder regressions and mutants, without unnecessary independent review; one blockers-only review remains required for permissions/sign-in/secrets, money, stored-data deletion/migration, or public posts to another repository. Human reviews and existing remote checks remain binding.

## Approval needed before execution

Proposed default rollout is the existing local install only, after scratch verification; no npm publishing, vendor/account changes, credential handling, stored-data deletion or migration. Review this proposed plan and preview. The execution prompt must name release environment, rollout authority (including local reinstall/restart and any real-engine quota allowance), and scope limits. Planning has not approved implementation, PR creation, merge, tag, release, or configuration changes.

Workflow source: the requested home and repository `AGENT_WORKFLOW.md` paths were absent; the coordinator read `/Users/shankhadutta/Downloads/AGENT_WORKFLOW.md` and the user's pasted standing instructions. User instructions win where they differ.
