# User journey and UI/API research

5 November 2026 · source revision `a102313` · planning only. Owned scope: web, HTTP surface, journey/spec alignment, prior guardrails. No code edits, tests, model calls, credential reads or remote mutations. The dirty sibling checkout was not inspected or changed during this research. File references below are relative to the repository and one-based.

## Goal and interpretation

The person talks to one meta agent about coding work attached to a repository. The meta agent owns coordination; the person can inspect every task, agent assignment, decision, check and outcome without becoming the scheduler. Observability is available on demand; routine tool noise stays out of chat.

This fits spec §10 (conversation → work → plan → tasks → attempts), §12 (receipts, ownership and questions), §14 (repository/workspace/PR), and §18 (chat-first, evidence on demand). “Meta agent only” needs one explicit clarification: §12.3 currently delivers a follow-up to its owning specialist while the meta agent must not answer/re-plan it. A single visible conversation is compatible; forcing every reply to be authored/interpreted by the meta agent would amend that rule.

Evidence labels: **Source** = inspected code path, not executed proof; **Observed earlier** = installed app computer walkthrough, not reproduced against this checkout; **Proposal** = desired behavior requiring implementation/verification; **Decision** = ambiguity requiring owner input.

## Owner decisions confirmed during planning

- Separate meta conversation and work history per repository; per-repo drafts/context. Optional global Work/Needs aggregation is read-only until an explicitly repo-labelled action is selected.
- Meta plans and runs local work autonomously under policy, then asks before push/PR/merge. This is product behavior, not authorization to execute this session.
- Default delivery target is a tested PR ready for review; merge is a separate explicit decision.

Planning defaults (not owner-confirmed): preserve legacy history; if repo association cannot be proven, show unassigned read-only. No guessed linkage or destructive automatic migration. Allocate globally unique IDs for new work transactionally. Per-repo drafts and explicit cleared context persist across refresh as a proposal.

## Principal findings

### 1. Repository context is not part of the chat interaction

**Source:** `apps/web/src/components/Composer.tsx:42` renders message/reply context but no repository selector. `apps/web/src/api.ts:376–387` sends only text and optional work reference. `apps/desktop/src/server.ts:459` accepts those plus setup mode; composed dispatch at `:553` supplies no repository field. Registration/listing exists at `:1096` and `:1179`, but registration alone does not expose which repository a new request targets. `/api/work` at `:666–684` returns no repository, title or origin. `apps/web/src/views/WorkView.tsx:10–11` has no repository filter. This proves the UI/API seam lacks explicit repo selection; runtime binding correctness belongs to the separate runtime investigation.

**Proposal:** persistent repository context above the one meta conversation; display “New request in [repository]” or “Following up on [title] in [repository]”. A selector lists registered repos and Add repository. Every admitted item gets an immutable repository association; switching UI scope never retargets existing work. Work supports All repositories plus per-repo views; every row names the repo. Before dispatch, the server validates the chosen repo and follow-up/repo consistency. No registered repo leads to one concrete setup action.

**Acceptance:** register A/B, start one request in each, switch views/reload, and prove each task/result retains the correct repo; unknown/inconsistent repo is refused without launching work. **Decision:** per-repo conversations vs one global conversation with explicit request scopes, and whether requests may span multiple repos (current §1 says one repo per work item, multi-repo later).

### 2. The UI silently chooses the first live item

**Source:** `ChatView.tsx:17` chooses first non-done/non-stopped work for title, Details, Hold and Stop. `workbench.tsx:494–499` fills a null reply context with the first such item whenever route/work changes. `components/Composer.tsx:55–58` shows the internal ID and Clear. `components/Work.tsx:116` opens details but does not select the chat work context. `router.ts:8–24` supports six top-level screens only, with no repo/work/task address. `state.ts:6–20` reply context is an in-memory singleton.

**Observed earlier:** Clear removes reply chip immediately; it returns after reload. The source also permits it to return on subsequent work refetch, because a new array triggers the effect. This is an intent/model issue, not proof that Clear failed to click.

**Proposal:** explicit New request versus Follow up selection; selecting a work item sets the inspection/action context and offers “Discuss this work” in the same meta chat. Clear remains new-request intent until the person chooses otherwise. History and controls refer to that selection, never the first live row. Add stable repo/work/task addresses so refresh and back/forward preserve context. Show titles; IDs belong in technical details.

**Acceptance:** two live items cannot make Hold/Stop/details target the wrong one; Clear survives event refetch; navigating inspection does not implicitly change send authority. **Decision:** whether Clear intent survives browser reload and whether selecting work also filters conversation history.

### 3. Existing client/server contracts disagree in core journeys

**Source — prompts crash path:** server `:1772–1784` returns `{revision, parts, overrides}`. `api.ts:553–556` asserts `PromptPart[]` without decoding; Settings stores the object at `SettingsView.tsx:65`, then render uses `parts?.find` at `:76`. The `.find` failure is a concrete source path consistent with the installed blank screen. `App.tsx:139–163` and `main.tsx:10–13` contain no error boundary around routes.

**Observed earlier:** Settings blanked the whole installed shell with `TypeError n.find is not a function`; reloading Settings stayed blank; full reload on Chat recovered. Source identifies a strongly matching cause, but this research did not reproduce the candidate bundle.

**Source — model table:** server `:1709` returns `{table, provenance, availability}`; client `api.ts:255–259` expects `{providers, rows, note}`, and `components/Settings.tsx:186/192` maps those absent fields. Fixing Prompts alone leaves Models vulnerable.

**Source — questions:** server `:1427–1443` returns `{question, options, status, workItemId, ...}` while client `api.ts:110–118` expects `eyebrow/what/why`. Server includes answered records; client counts every returned question unless locally resolved (`App.tsx:185–189`). POST uses `{option}` in `api.ts:577`; server requires `{answer}` at `:1448–1451`. Thus choices cannot succeed through this client call. “Answer in chat” uses text suffix detection and prefill only (`workbench.tsx:368–371`); it sets neither question ID nor work reference. Do not assume plain text closes the right question.

**Proposal:** explicit HTTP DTO decoders/adapters and actual-route consumer contract tests; do not cast arbitrary JSON into view types. Keep HTTP transport DTOs and UI view models separate without duplicating the frozen engine contract package. Add pane error boundaries and typed loading/empty/error/ready states. Questions carry stable question/work/repo identities; choices and free-text use one answer operation with compare-and-set. The visible respondent remains the meta conversation; evidence can attribute the specialist.

**Acceptance:** actual Fastify responses render Prompts/Models/questions; an invalid payload yields an actionable section error while rail/other routes work; answered questions stay resolved across reload; answering the chosen question wakes only its intended work.

### 4. Missing API GETs become HTML and indefinite loading

**Source:** built artifact `server.ts:1885–1904` sends the SPA shell for any unknown GET/HEAD, including `/api/...`. Client `request` always parses JSON (`api.ts:328–330`); fallback recognizes only a 404 (`:348–366`). Work/decision/task detail routes requested at `api.ts:425/441/449` are absent from this server's route list. `ContextPane.tsx:203–211` swallows failure and retains “Loading the work item…”. Same pattern appears at `:88–96`, `:165–174`, `:255–265` and Settings table/backups loaders. There is no request timeout/abort in `request`.

**Observed earlier:** work detail remained loading for about two minutes, with Close still usable. The missing API→HTML→JSON failure is a code-proven explanation for the shipped-route path, not an executed reproduction here.

**Proposal:** `/api/*` misses return JSON 404, while actual navigation keeps SPA fallback. Remove demo fallback from live-runtime reads; use real source data or an explicit unsupported/unavailable state. Central request decoding/error/cancellation, then detail loaders with retry and stale-result protection. No fake success on missing mutation routes.

**Acceptance:** missing API endpoint returns JSON error, detail failure terminates loading, retry recovers, navigation cancels irrelevant requests; packaged build tested as well as Vite/mocked routes.

### 5. “Full observability” is not reachable from the current drilldown

**Source:** `/api/work` at `server.ts:666–684` exports lifecycle as stage, without the §10 first-match projection, title/repo, action reasons or elapsed data. `Work.tsx:97–114` fetches missing detail separately for every row; `:139` falls back to ID. `WorkBody` at `ContextPane.tsx:219–226` renders task names/states as noninteractive text even when IDs exist. Plan rows *do* open tasks (`Conversation.tsx:125–136`), creating an inconsistent route. Task detail view at `ContextPane.tsx:253–275` exposes a key-value list/report but no checks/findings/diff/transcript navigation. Router cannot address individual attempts.

`Work.tsx:22–26` maps held and dropped to Working; `:14–18` says Done today while grouping contains no date filter (`:64–68`). `:53` calls all blocked work “Needs your approval”, and `:54` infers quota from parked. These statements can be false for other blocker/wait reasons. The source comment explicitly says projection is deferred.

**Proposal:** read models for list/work/task/attempt, derived from existing authoritative records/events. List payload includes title, repo, computed attention/wait reason, last meaningful event and next action; no per-row detail fetch for basic identity. Selected work shows goal/scope, versioned plan/dependencies, agent parentage, assignment/model choice reason, receipt state, task/attempt state, relevant checks/diff/findings, handoffs, outcome and links. Inspecting an agent is read-only; “Ask about this” returns to the meta conversation with explicit work/task context. Unknown cost/usage stays unknown. Keep completion distinct from agent idle, checks passed, PR created and merged.

**Acceptance:** one request is traceable message → admitted work/repo → plan versions → dependency/assignment → attempts → checks/reviews → result/PR; blocked/held/queued/quota/auth/dropped are distinguishable with true next steps; all rows and history labels match their contents. The runtime agent must confirm which records/events actually exist before the plan promises complete fields.

### 6. Sending loses important intent and receipt feedback

**Source:** Composer drafts are local state (`Composer.tsx:13`); only the route view is mounted (`App.tsx:154`), so navigating away discards an unsent draft. Send clears the field and restores it on failure (`Composer.tsx:33–40`), but a failure can overwrite new text typed during a pending send. Enter invokes send even while the Send button is disabled (`:76–89`); `workbench.tsx:402–425` has no in-flight guard and shares one idempotency key. This is a race risk requiring a regression, not executed proof of duplicate work. Failed attempts retain the same key, but editing the text/target before retry does not rotate it. `SendChatResult` at `api.ts:72` discards routing/ack/task/enqueue fields returned by server `:560–572`. ChatMessage type at `api.ts:58–68` lacks receipt ladder; message UI shows timestamp/pending only (`Conversation.tsx:72–90`).

**Proposal:** persistent draft scoped to explicit repo/work/question intent; one in-flight submission object freezes text, target, question and idempotency key. Retry the same submission with its key; edited/new intent gets a new key. Preserve concurrently typed text. Show concise actual received/delivered/handled state and failures when useful, with richer receipt ladder in details. No transport-success inference of read/completion (§12.4).

**Acceptance:** rapid Enter, retry-after-uncertain-response, editing while pending, route changes and reload cannot lose draft or retarget/duplicate work; message receipt remains truthful after restart.

### 7. First run and capacity management do not form one complete journey

**Source:** Setup Continue/Skip merely moves local step state (`SetupView.tsx:60–75`); no prerequisites gate Finish. “Try it” shows ready/missing and still offers Open Chat (`:433–449`). Slot connection hardcodes Claude for linked/dedicated paths (`:163/176`), despite multi-engine detection. `SlotsView.tsx:17` Add opens only API key. Setup's repo explanation promises README-based proposed commands (`:280`) but current save simply submits user text (`:253–268`); no proposal action appears there. Settings Repositories is a read-only list with no add/edit action (`SettingsView.tsx:125–156`). Meta-slot candidates include every non-retired slot (`SetupView.tsx:364`), and server validates only slot existence (`server.ts:1201`), not eligibility; runtime ownership must determine actual allowed engines.

**Source:** Switch slot sheet is explanatory-only (`Sheets.tsx:228–245`). Replace key opens an add form with incremented label (`Slots.tsx:117–121/144–147`); there is no in-place replace intent here. Retire is one click (`:125–130`) and calls a route that immediately shreds keystore data (`server.ts:942–949`) without confirmation in these layers. No credentials were accessed. This needs a sensitive-scope safety review if changed.

**Proposal:** reusable connection/repo forms shared by Setup and Settings; progress reflects saved prerequisites, with truthful resumability. Setup completion validates healthy usable meta slot plus repository and names the first request target. Add repo proposes commands only when real inspection supplies them, and asks to confirm trust/execution. One owner-entry connection path handles supported engine/provider combinations. Replace/retire name the affected capacity, running/queued impact and irreversible consequence; preserve authority gates. Switching must actually select an allowed slot while retaining the same worktree, or remain unavailable.

**Acceptance:** clean first run, partial return, failed probe, multiple engine paths, second repo, unavailable meta slot and cancel all have explicit next steps; Finish never implies readiness when prerequisites are missing. Do not run retirement/sign-in changes on the live state to demonstrate a plan.

### 8. Settings and global controls contain nonfunctional promises

**Source:** Policy is a placeholder (`SettingsView.tsx:41–50`). Prompt Save only sets a local notice, performs no API write, and does not update saved baseline (`Settings.tsx:145–152`); switching part/route loses the draft. Compare/default/full prompt buttons only call notices at `:112–128`, while real defaults/revisions/preview/changes routes exist (`server.ts:1844–1883`) and PUT persists stale-base-checked revisions (`:1791–1833`). Settings blanket not-served text is stale (`SettingsView.tsx:105–107`). Models has no user edit path despite server PUT. Backups/pause/hold/stop clients point to routes absent here (`api.ts:581–606`), and global palette still advertises Pause/Backup (`Palette.tsx:51–56`). Resume is absent from this HTTP/client surface. Selected work commands are ID-only (`Palette.tsx:57–64`); the palette searches commands, not §18's message/task/SHA/reference search.

**Proposal:** connect existing prompt revision/default APIs completely, retaining stale drafts and actual provenance. Add policy/model editing only with real validation, diff and explicit apply authority; settings suggestions remain meta proposals. Capability-driven controls either complete an effect or clearly state unavailable before the click. Global pause distinguishes scheduling pause from interruption/hold/stop; unpause is explicit. Add reference search after stable identities/read models; no broad new dashboard required.

**Acceptance:** save/reload proves durability; 409 preserves draft; compare shows actual old/new/override; settings proposed through chat require explicit apply; no “saved/paused/backup started” label precedes real acceptance. API availability, not comments or demo fixtures, drives capability display.

### 9. Freshness/errors can silently hide operational problems

**Source:** fetchAll catches each request using allSettled, applying only successes without exposing failures (`workbench.tsx:175–199`). Prior values stay indefinitely without stale/error annotation. SSE uses work/slot plus repositories/wizard streams (`:219–238`), but question answers journal to the question stream (`server.ts:1468`), prompts/models journal elsewhere; this specific subscription does not include them. No assertion here that another event never triggers catch-up. Existing ten-second interval refreshes status only (`workbench.tsx:240–250`).

**Proposal:** independent resource freshness/error state, server timestamps/cursors and explicit reconnect/catch-up status; retain useful cached data with “last updated” rather than silently treating it as current. Subscribe to relevant resource changes or invalidate them from a shared event contract. Paginate/filter history and lazy-load expensive detail. No high-frequency full-history refresh for every agent event.

**Acceptance:** simulated offline/reconnect, question answered in another tab, missed events, partial API failure and long history cannot produce fake healthy counts or silently stale action evidence. Preserve single merged SSE connection.

## Recommended journey increments for the assembled plan

These are UI/API candidates; integrate ordering with the separate runtime findings rather than promising runtime behavior here.

1. **Repair transport/view contracts and route recovery:** API namespace JSON errors; decoders for prompts/models/questions; route boundaries and finite async states. Actual server-to-UI regression. Independently restores basic navigation.
2. **Make repo/request intent explicit:** repo selection and validated request association, selected work versus New request, persistent drafts, stable addresses, retry identity. Requires one-repo-per-work invariant and an owner decision on conversation organization.
3. **Expose real work/task/attempt read models:** title/repo/stage/reason lists, graph drilldown, evidence/result links and freshness. Every field traced to authoritative data; honest unavailable states where runtime evidence is absent.
4. **Finish answering and action authority:** question identity/answer schema/wake, real exact-effect evidence, receipt/completion transitions, hold/stop/resume and pause only with runtime support. Permissions/sign-in/retirement changes get one independent blockers-only review.
5. **Complete setup and configuration:** shared connection/repo flow, readiness, second-repo management, durable prompt revisions/default comparisons, validated policy/model proposals and supported recovery.
6. **Close the observability/accessibility/release loop:** search and full history as scope permits; both-theme/narrow/keyboard/error matrix; real bounded meta→specialist→result run in scratch repository; packaged install and post-install evidence. Existing CI/protections remain binding unless the owner changes them.

Feature-flag incomplete new journeys by local capability/slice, default off; do not flag away essential error handling or replace working existing behavior with unfinished paths. Each increment needs a builder failing regression plus meaningful mutants, a separate verifier, and post-install behavior evidence before dependent rollout. Mocks stay test-only. No framework migration or broad dependency churn is justified.

## Decision log and remaining execution inputs

1. **Settled:** one meta chat and work history per repository. Cross-repo work stays separate work items under current §1.
2. **Plan interpretation:** meta is the sole conversational counterpart; specialist questions/replies can be transparently relayed unchanged through it and specialist activity inspected read-only. Preserve specialist ownership and original question/evidence per §12.3; no mandatory LLM restatement on every turn. Record any necessary spec amendment only after approval.
3. **Plan interpretation:** goal/plan/task/attempt/check/diff/artifact and result on demand; bounded redacted event/report summaries, no secrets or chain of thought. Missing financial/model usage measurements remain unknown.
4. **Settled:** routine local planning/execution is autonomous under policy; push/PR/merge ask. Tested PR ready for review is the delivery target; merge is separate.
5. **Recovery scope:** finish local UI + runtime behaviors without migrations/credential handling/npm/vendor changes, or explicitly expand? Real-engine budget and rollout environment are required in the later execution prompt.

## Guardrails reconciled from this day's earlier read-only inspection

Earlier on 5 November (not freshly queried here), GitHub main protection returned nine required checks, strict=true; human review requirement null; empty rulesets; linear history required; force push/delete disallowed; enforce_admins=false. Repository auto-merge disabled. PR #23 was merged at `a102313`, with a Copilot COMMENTED review, not an enforced approval. These are timed evidence, not promises of future remote state; recheck before executing release.

Source still defines static, Node22/24 A/B suites, audit, compliance and Linux/macOS install smoke in `.github/workflows/ci.yml`. Screenshot suite explicitly excluded from CI (`apps/web/playwright.config.ts:10–12`) and uses mocked routes; no axe/Lighthouse runner was found in the prior inspection. Release helper separately requires all checks (`apps/desktop/src/release.ts:494–526`) and uses `--merge` at `:563` despite linear history. Never bypass it; resolve the workflow/method mismatch in the approved plan. Standing user review rules override old blanket cross-review docs.

If applying the standing no-wait-for-CI policy, the owner-only command supplied previously was `gh api --method DELETE repos/MubitLabs/mubit-engineering-control/branches/main/protection/required_status_checks`; it has not been executed. It would not remove MEC's independent application gate. Current required checks stay binding. Remote push/PR/merge must use journalled confirmation cards. Decision #8 build authority expires at R2 exit (§9); execution must establish current environment/authority/limits.

Tag release workflow full-checks/builds/smokes before GitHub Release; npm publication stays commented/owner-gated. Installer overwrites app contents before native build, with no automatic previous-version rollback (`scripts/install.sh:27–37`); preserve a versioned prior artifact and independently verify scratch state first. Reinstall/flag rollback never reverses database writes.
