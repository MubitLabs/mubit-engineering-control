# Orchestration and reliability research — planning only

Reviewed 5 November 2026 in `/Users/shankhadutta/code/mubit-engineering-control`, source base `a102313`. No code changes, tests, engine calls, credentials, store reads, or remote mutations. This report concerns the checked-out source, not proof of parity with the user's installed bundle. Other sessions own UI/API and observability research.

The product outcome is a repo-attached request that the meta agent plans, delegates, monitors, repairs and finishes while the person communicates only with the meta agent. The owner has now chosen **a separate meta conversation/work history per repository; automatic planning and local execution for normal requests; a tested PR ready for review as the delivery target; explicit confirmation before each push, PR creation or merge, with merge a separate decision**. If a required confirmation is pending, show that actual stage rather than claim the PR target was delivered. These are product decisions, not permission to implement or release in this planning session. Preserve stricter policy/security gates and the user's standing review exceptions.

## Main finding

The most consequential gap is incomplete composition, rather than a missing orchestration framework. Useful pieces exist: deterministic scheduler and state machines, engine adapters, worktrees, checks, journal, integration decisions and release confirmations. The default executable does not join them into a durable specialist execution loop. A polished screen over the current loop could still show an indefinitely queued request.

### What is connected, and what is not

1. `apps/desktop/bin/mec.js:19–20,69–71` chooses bundle or source and calls `serveMain`; `apps/desktop/src/serve.ts:56` calls `startServer` in `composition.ts`.
2. `apps/desktop/src/composition.ts:180–223` wires a real Claude planning brain and current capability/availability suppliers. `packages/meta/src/real-brain.ts:178–191` delegates production turns to the nine-tool `PlannerBrain`; it is not only the old three-tool canary implementation. The planner has its own real MCP/tool execution path. Do not mislabel all MCP/planner tools as unimplemented.
3. `packages/meta/src/service.ts:623–644,744–770` commits task records, queued attempts and launch effects. This proves admission/placement, not process execution.
4. `apps/desktop/src/composition.ts:366–371` returns immediately from a launch handler unless `MEC_FAKE_ENGINE=1`; only the fake path executes an adapter there. Other registered effect kinds use `async () => {}` at `composition.ts:339–349`. The general specialist MCP server throws “tool execution is not wired” at `composition.ts:138–143` and uses a deny-only bridge at `:36–41`.
5. `AttemptJournal`, `Supervisor`, `runChecks`, `nextIntegrationStep` and git/worktree operations are real helpers with separate tests. Source searches found no production composed worker consuming a real queued launch and driving that full lifecycle. `apps/desktop/test/h1.real.test.ts:119–160` directly builds/launches a real adapter; this is meaningful canary evidence but is not the default chat-to-worker path.

`docs/log/HANDSHAKES.md:111–112` says the composed planner “places and launches,” but its explicit proof is `launchesEnqueued`. H3/H4 records show real deliveries and must retain that credit; they do not establish the unattended composition path missing in the current source. Release verification must name the actual entrypoint and installed revision used.

## Evidence-backed gaps and proposed repairs

### O1 — P0: a launch effect can finish without launching a specialist

**Trigger/consequence:** a real plan queues an attempt, then the composition's non-fake handler returns. The request cannot progress through the expected coding journey and the queue may consider the effect handled. Likewise generic delivery/reply handlers currently acknowledge no-op work.

**Sources:** `composition.ts:339–371`; specialist MCP path `:135–145`; meta enqueue `service.ts:744–770`. Exact queue settlement semantics should be confirmed by the store research before claiming a specific persisted receipt state.

**Small repair:** introduce a focused production attempt runner and adapter registry, composed behind a disabled capability/feature flag. Load task, work, repo, mandate and slot; revalidate; materialize the pinned worktree; compile the original request and pinned bundles; resolve the model; mint scoped MCP capability; launch the adapter; redact and journal events before projection; persist actual terminal state; schedule the next decision. Specialist tokens expose only their allowed report/read/permission tools, never meta authority or approval capabilities; stale generations are fenced. A handler must distinguish started/ongoing/completed/uncertain from unsupported or failed. Unsupported paths fail explicitly and never advertise success. Reuse existing helpers rather than replace them. Stage a Claude-only composed path first if that reduces proof cost, then prove existing Codex/OpenCode adapters through that same path without vendor/model upgrades.

**Acceptance:** from the packaged `mec` entrypoint in isolated state, one registered repo and one small real-engine task produce admitted → planning → queued → actually running → implementation complete → checks on exact SHA → local result. The user sends one request to the meta agent and never dispatches a worker manually. A missing adapter produces a bounded actionable failure. There is no remote write without a separate confirmation. Real-binary proof is separately quota-authorized; fake tests cannot close it.

### O2 — P0: repository attachment and task identities are not enforced at admission

**Trigger/consequence:** the service accepts only messageId/text/reference at `service.ts:208–212`. New work saves only the originating message in its mandate at `:439–454`. Plan tasks use unqualified planner-local IDs at `:623–644`; no repository or pinned base is attached there. Independent plans commonly reuse `task_1` or `implement`; a global document store can overwrite the earlier task, and the runner has no authoritative repo to work on.

**Sources:** intake/work/task writes above. The observability researcher confirmed `packages/store/src/migrations.ts:92–99` has global `PRIMARY KEY(id)` and `packages/store/src/store.ts:122–138` saves by that ID. This is source evidence, not a performed destructive reproduction.

**Small repair:** admission requires a registered repo identifier and pinned base/profile revisions. Scope the conversation/work item to it; children inherit immutable repo identity. Resolve planner-local task keys to globally unique task IDs and rewrite dependency references atomically, retaining a local display key. Replanning adds explicit revisions rather than silently replacing prior identity. Before launch, require task/attempt/work/repo agreement. No automatic rewriting of legacy data: expose unattached records honestly and design a reviewed compatibility/migration policy separately.

**Acceptance:** two repos with two simultaneous requests both containing local task key `implement` remain independent, with distinct task IDs/worktrees/check evidence; dependencies resolve within their own plan; a cross-repo reference is rejected before any side effect. Switching the visible repo does not retarget existing work.

### O3 — P1: follow-ups bypass the meta agent and do not reach a running specialist

**Trigger/consequence:** explicit references take `#noteAttached`, and unreferenced messages while work exists take `#noteConversation`; both persist an acknowledgement without a brain call or delivery enqueue. A user can say “change the requirement” or “stop” and receive a note while no coordination action happens. New-work routing is also restricted when any work is live.

**Sources:** `service.ts:218–230,391–429`; `packages/meta/src/routing.ts:31–44`. This contradicts the “user message always wakes” classifier at `packages/meta/src/wakes.ts:36–40` and spec §§6/12.

**Small repair:** every user message enters the same durable meta turn pipeline with explicit repo/work context and admission intent; preserve deterministic reference binding, do not infer authority from text similarity. The meta agent may clarify once, attach/replan, create independent work, hold or stop. Material changes are delivered through a durable receipt ladder to the affected attempts, while original request and revision history remain intact. Support a visible “New request” action even while other work is active.

**Acceptance:** a scoped follow-up wakes the meta once and is durably delivered/read or reports a bounded failure; a fresh request beside active work gets independent admission; ambiguous context asks once rather than silently attaching. A stop-plus-new-work message yields a stopped original and a separately admitted request.

### O4 — P0 before real execution: terminal/hold authority is not fenced at turn commit

**Trigger/consequence:** `onWake` accepts an existing work ID without checking its current mandate/terminal state; `#commitPlan` changes any found work record to executing. A late answered question or stale planner result can revive stopped work. Attempt stop merely changes a doc to interrupted; it does not stop a process. These become especially costly when a real worker is connected.

**Sources:** `service.ts:311–351,610–614,844–897`; hard invariant spec §13.4; domain's explicit terminal/state machine `packages/domain/src/states.ts:66–89`.

**Small repair:** commands validate against current work state, hold, mandate and generation at commit, including after any awaited engine turn. Use the existing transition tables, not direct ad-hoc state writes. Stop withdraws authority and sends an owned process-group stop request; state reflects requested/confirmed outcome. Hold and global pause block new dispatch/delivery/outbound actions while preserving evidence; a question, timer or stale confirmation never lifts them. Retry/cancel runs through the same command boundary.

**Acceptance:** stop while the planner is running, then allow it to return; zero new launches. Answer an old question after stop; work remains stopped. Hold persists through retries and restart. Stop confirms the owned process group is gone; a stop failure remains visible. Duplicate or stale-generation tool calls cannot mutate current work.

### O5 — P1: crash replay does not follow the intended same-message path

**Trigger/consequence:** if a crash leaves a message and planning work but no ack, replay first runs global routing. That live work causes `conversation`/`attach` rather than resuming `#startNewWork`, contrary to its stated crash semantics. A question answer is committed before a synchronous `onWake` call; the wake itself has no durable ID/queue in this method, so crash-between-answer-and-turn needs explicit recovery.

**Sources:** `service.ts:213–230` versus comment/implementation `:432–443`; answer commit then wake `:366–387`; fresh wake identifiers `:311–315`.

**Small repair:** persist an inbox command/turn identity and status before engine work; resume receipt-less admissions by original message and existing work first, before new routing. Use durable, deduplicated wake effects keyed to the originating report/question/confirmation/event. Retry engine turns with generation fencing and reconcile effects before repeats. Coalesce informational notes; do not poll the meta continuously.

**Acceptance:** fault at each boundary (message stored, work created, planner returned, plan committed, wake queued, wake acknowledged); restart produces one admitted request, one authoritative plan revision, one live attempt per task and one user receipt. An answered question can always be traced to a processed or pending wake.

### O6 — P1: initial placement is one snapshot, not a continuing dependency scheduler

**Trigger/consequence:** `#commitPlan` schedules only tasks with no unresolved dependency in its new plan; it computes all prerequisite states as ready. No production consumer was found that accepts terminal worker reports, integrates tasks and runs a fresh dispatch for dependents. Deferred reasons are computed but not persisted in this method. A valid multi-task plan can wait forever after its first wave.

**Sources:** `service.ts:676–742`; pure scheduler contract `packages/domain/src/scheduling.ts:3–7`; integration's caller-owned decision design `packages/integration/src/queue.ts:1–17`. Search found `nextIntegrationStep` called only in tests. General effect handlers are no-op (`composition.ts:343`).

**Small repair:** add event-driven scheduling passes after authoritative reports, check completion, integration, slot/capacity changes and relevant confirmations. Recheck gates and atomically reserve capacity immediately before launch. Persist defer/block reasons and the event that can release them. Report ready/blocked/failed/dropped wakes the meta; progress becomes a note, following the existing classifier.

**Acceptance:** a two-task dependency chain proceeds without another user message; a failed prerequisite blocks its dependent; an accepted but not integrated prerequisite respects `basePolicy`; freed capacity launches the next eligible work fairly. Concurrent scheduling passes never double-place the same task or exceed slot/global caps.

### O7 — P1: model and slot decisions are not enforced by placement

**Trigger/consequence:** tools parse a requested model/tier and explicit slot ID, but ready placement carries only optional `slotClass`. Healthy slot views omit slotClass and force `inUse:0`/concurrency 1; requested slot ID and model constraints do not participate. A future runner could execute a different model/provider than the plan showed, or a slot-class request could defer despite a suitable real slot.

**Sources:** parser `packages/meta/src/tools.ts:341–381`; ready/slot conversion `service.ts:702–734`; matching `packages/domain/src/scheduling.ts:106–108`. `packages/runtime/src/model.ts:137–225` is an existing strict resolution helper to reuse.

**Small repair:** produce capability-compatible candidates from authoritative slot state, requested model/tier, pin/class, policy and current usage. Record placement rationale, actual resolved model/effort and any allowed degradation before launch. Recheck at reservation; unavailable never silently becomes default. Count actual active work and preserve unknown usage as unknown. Bound total turns/time/spend with an explicit ledger rather than only carrying budget suggestions.

**Acceptance:** pin slot B while A sorts earlier; B actually runs. Model unsupported on A never places there. Concurrent work respects capacity. A requested unavailable model yields an actionable reason and no vendor spend. Tier degradation and actual model match the visible attempt record.

### O8 — P1: real checks and completion evidence are disconnected

**Trigger/consequence:** planner and commit validation use only `manual-review` as known check; real configured check names can be rejected. `report_result` accepts a summary/artifact reference without validating task completion, and `#persistExtras` only appends a result event. There is no composed task/check/integration completion controller.

**Sources:** `service.ts:559–574,631–634,872–879`; `packages/meta/src/tools.ts:372–399,642–680`; `packages/runtime/src/checks.ts:19–25,87–92`; `packages/integration/src/queue.ts:78–79` returns done when its accepted subset is drained, including nothing accepted—this must never be treated as whole-work success.

**Small repair:** load check profiles from the registered repo and pin their revision. Run checks through the existing argv-only runner; attach verdict/log evidence to the tested commit, invalidating it if HEAD changes. Task acceptance includes relevant reviewed findings only when review is required by the owner's standing rule. An authoritative completion reducer verifies all required tasks/acceptance and integration evidence; the meta summarizes that result, never invents it. Keep local-complete, PR-open, merged and deployed distinct. Explicitly excluded requirements retain a reason.

**Acceptance:** known real checks accepted; unknown check refused by name. Exit zero from the engine without checks cannot mark work ready. All accepted tasks integrated is insufficient if a required task is still ready/failed/cancelled. A changed SHA cannot reuse a prior green result. User receives a useful local artifact/result, and separate remote stages appear only after approved effects and observed receipts.

### O9 — P1: lifecycle ownership and recovery controls need composed truth

**Trigger/consequence:** boot changes running attempts to stalled but does not prove journal replay/process reconciliation/resume scheduling. Close stops the generic MCP/server and drains effects, but does not own/close the real planning brain created inline. Pause exists on `RunningServer` but is not passed to `buildServer` at `composition.ts:147–151`. CLI restart's production injection is `async () => {}`, while stop only writes a marker.

**Sources:** `composition.ts:83–86,93–118,218–224,231–246,315–335`; `apps/desktop/src/mec.ts:64–78,175–191`. The web/API owner should confirm which visible Pause control reaches which path before treating the UI control as proven broken.

**Small repair:** retain owned planner/runner handles in a lifecycle container; close in bounded order, await cleanup and release store lock last. Journal replay and process-generation reconciliation run before dispatch. Wire actual pause/resume/status through one authoritative command path; make unsupported CLI actions explicit until implemented. Persist intentional stop/pause semantics and distinguish reconnect, service stopped and slot attention.

**Acceptance:** exit/restart during plan, run, quota wait and pending external effect preserves state, creates no duplicate authoritative work, leaves no owned process running and retains the workspace. Global pause genuinely stops new relevant effects; resume shifts deadlines once. Restart command actually restarts or states clearly that the operator must do so.

## Bounded implementation sequence and dependencies

The coordinator should integrate this with UI/observability slices rather than make a separate backend rewrite. Proposed independently mergeable foundation increments:

1. **Truthful runtime capabilities:** stop acknowledging unsupported effect kinds; expose runtime capabilities and finite blocked reasons. Existing no-op behavior cannot be a passing capability. Post-install verify a real request is either actually runnable or explicitly blocked.
2. **Repo admission and identity:** repo/pinned profile/base association, global task identity mapping, plan revisions and compatibility reads. Depends on a product decision about repo conversations; do not mutate existing data silently. Verify two same-key requests on two scratch repos.
3. **Durable command and authority boundary:** resume incomplete admissions, deduplicated wakes, terminal/hold/generation checks, explicit stop/pause command receipts. Run meaningful crash and late-result faults before enabling real execution.
4. **One real specialist vertical slice:** reuse adapters/worktrees/model/env/isolation/journal/checks, bind scoped MCP and process ownership, finish locally with actual SHA-bound proof. Enable only in the authorized scratch/local environment; budgeted real canary is mandatory for real-engine claims.
5. **Dependency scheduling and coordination loop:** real structured reports, next-wave dispatch, user follow-up delivery and actionable asks. Verify parallel caps, dependency chain, one interruption/replan and no need for manual worker control.
6. **Integration and result/release flow:** required acceptance, exact-SHA integrated checks, bounded repair, original constraints preserved, truthful final summary; journalled confirmation before each remote push/PR/merge. Verify no accepted-subset shortcut to work done.
7. **Recovery and multi-engine expansion:** crash/uncertain external effects, quota/auth resume and allowed slot switch, then additional adapters proven through the same runner. Do not certify all engines using only one engine's proof.

Internal extraction should be narrow: `MetaAgentService` is a 995-line mixture of admission, persistence, routing and placement; `composition.ts` should wire lifetimes, not become the next orchestration monolith. Add focused admission/command handlers, attempt runner, scheduler/integration controller and adapters around existing domain functions. Avoid frameworks, distributed services or a new datastore. Introduce new optional fields only when needed; frozen contracts changes require fixture updates and CONTRACTS §10. Preserve redaction-before-durability, role-scoped reads, `.mec/` exclusion, single-writer state and mandatory confirmation limits.

## Decision points for the owner

- **Settled in this conversation:** normal requests can automatically plan and execute local work; each push, PR and merge requires asking. A separate meta conversation/work history belongs to each repository. Default delivery is a tested PR ready for review; merge remains a separate decision. Agent cannot widen its authority. Special security/money/data actions still respect policy and the standing blockers-only review rule.
- **Cross-repo scope:** one work item binds to one registered repo. A future multi-repo goal would need an explicit parent plan with separately authorized repo-scoped work, not silent retargeting; it is not required for this pass.
- **Delivery stages:** preserve locally complete as an honest intermediate stage while a push/PR approval waits, then verify actual PR state and head/check evidence before saying ready for review. Process exit, check pass, task integration, PR-ready, merged and deployed are separate facts. No remembered preference silently preauthorizes remote effects.
- **Legacy unattached records:** recommend read-only “repository not recorded” history plus explicit owner re-admission for new work; repair/migration requires a separate data decision.
- **Cost and rollout:** choose the first repo/engine, real-turn and spending limits, and local install/flag authority during execution agreement. Planning alone does not authorize quota use or release.

## Verification limits

All defects here are source-path findings; no tests or real engine calls were run. Some helper tests and historic handshake records exist, but their prior results do not verify a changed candidate. For each new invariant, builders must supply failing-then-passing behavior tests and meaningful mutants (e.g. remove hold guard, ignore repo scope, bypass generation, reuse task ID, return success without launch, reuse stale check SHA). A separate verifier must drive the packaged entrypoint and actual app journey. Report synthetic, real-store, real-process and vendor-binary evidence separately. Never store raw personal traces or credentials in proof artifacts.
