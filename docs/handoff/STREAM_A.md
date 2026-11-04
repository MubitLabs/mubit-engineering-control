# MEC v4.1 — Stream A brief: core and workflow

Hand-off brief · 3 November 2026 · read with `spec.md` (the spec), `CONTRACTS.md` (the shared interfaces) and `KICKOFF.md` (rules, handshakes, the prompt to paste).

## 1. Mission

Build everything that **decides**: the store and effects queue, the domain rules, guardrails and policy, the scheduler, chat intake with receipts and ownership, the meta-agent runtime and its tools, the specialist registry, the integration queue and PR flow, prompt bundles, and the chat, inbox and work views. You never need a real coding-agent CLI: you run against an in-process `FakeEngine` that replays Stream B's fixtures, and against fake slots, until the handshakes replace them with the real thing.

Read first, in this order: plan §0–§2, §6, §10–§13, §17, §16, §14–§15, §18, §19–§20, then §5 and §9 for what B builds. The dsh-superagent patterns you are implementing are mapped in Appendix A of the plan.

## 2. Ownership

You own and are the only one who edits:

- `packages/domain` — state machines, stages, task-graph validation, impact diff, caps, holds, receipts, report and question model, slot states, role-scoped core interfaces
- `packages/effects` — effects queue, passes, health board
- `packages/policy`, `packages/prompts`
- `packages/mec-tools` — the MCP server, read resources, permission bridge
- the store (SQLite, lock, migrations, event log) inside `packages/domain` or a `packages/store` you create
- `packages/git`: `merge.ts`, `conflict.ts`, `impact.ts` only (B owns the rest of the package)
- `packages/testkit`: `memory-repositories.ts`, `fake-engine.ts`, `fake-slots.ts`, `memory-core-for-engines.ts`, the domain fault rig
- `apps/web`: the shell, routing, chat, inbox, work view, settings for policy and prompts, search, glossary
- `docs/` plan documents and ADRs; `CODEOWNERS`

You do not edit `packages/runtime`, `packages/engines`, `packages/slots`, `apps/desktop`, the Slots view, terminal cards, the wizard, or any fixture under `packages/testkit/fixtures` (B records those). A need in those places is a stub on your side or a PR request to B.

## 3. Stubs you build and keep green

| Stub | Replaces | Contract | Retired at |
| --- | --- | --- | --- |
| `FakeEngine` | `EngineAdapter` | replays `events.jsonl` fixtures; honours `interrupt`/`stop`; emits `permission_request` and calls the bridge like a real adapter | never — stays for the fault suite |
| `FakeRuntime` | `Runtime` | wraps `FakeEngine`; reports `CoreForEngines` facts; writes no journal | H1 for real runs; stays for domain tests |
| `FakeSlots` | `Slots` | configurable slots, states, usage readings, `reserve` with capacity, `slot.changed` events, concurrent-reservation fixture | H2 |
| `MemoryRepositories` | `Store` | same ordering and nested rollback as SQLite; also shipped to B on day 3 | never |
| `MemoryCoreForEngines` | `CoreForEngines` | recording stub B uses until the store lands (you ship it day 3) | A1 |

## 4. Work items, in order

Each item lists its deliverables, the definition of done (DoD: tests that must pass), the plan sections, and what you stub. Estimates are from the split; weeks assume a 3 November start.

### A0 — Contracts sprint and skeleton (days 1–3)

- Monorepo skeleton: pnpm workspaces, TypeScript strict, Biome, Vitest, CI running both suites, `CODEOWNERS`, `docs/log/`.
- The contracts PR from `CONTRACTS.md` in three parts (events/briefs/reports/bridge → adapter/runtime/slots/core facts → store/effects/health/errors/fixtures), reviewed by B; tag `contracts-v0`.
- `MemoryRepositories` and `MemoryCoreForEngines` in `packages/testkit` (B needs them on day 3).
- DoD: `pnpm check` green; every schema has its valid/invalid samples; the empty conformance suite runs; `contracts-v0` tagged. → **H0**

### A1 — Store, effects queue, passes, health board (5–7 days, weeks 1–2)

- Store: SQLite (WAL), directory lock on `~/.mec` (a second process refuses to start), numbered migrations with checksums (a newer schema refuses to open), JSON documents with generated columns and indexes over active sets, `atomic` with nested rollback and `afterCommit`, the event log (append-only, gap-free per stream, same transaction as the state change).
- Effects queue: one row per kind and key with coalescing, oldest-first within concurrency, exponential backoff, `Later`, ordered kinds (`relay`, `note`) where a failure holds later ones, drain on shutdown; passes every two seconds and on demand; health board with one writer per entry, `error` after three consecutive failures, cleared by the next success. Plan §17, §19.
- DoD: store round-trips every contract schema; migration tests (fresh, upgrade, refuse-newer); effects tests for coalescing, `Later`, order, backoff, drain; a health entry claimed twice throws; `MemoryRepositories` and SQLite pass the same repository test file.

### A2 — Domain port (6–8 days, weeks 2–3)

- Port from v1: state machines for work item, task, attempt, confirmation; task-graph validation (cycles, missing deps, unknown checks/roles, path conflicts, budget sums, slot availability); impact diff; caps.
- New: the **stage** projection as a first-match table (plan §10) tested row by row; **holds**; the **report and question** model (reuse/replace/clear); the **receipt ladder** with `read` counted only after a report or turn end; mandate operations (create, withdraw, revoke) and revalidation; the slot lifecycle (state machine only — B drives it); role-scoped core interfaces (`CoreForChat`, `CoreForMetaAgent`, `CoreForPerson`, `CoreForEngines`, `CoreForScheduler`, `CoreForSettings`) with imperative commands that may throw `UserError` and past-tense facts that may not.
- `FakeEngine` and `FakeRuntime` against B's first fixtures (`claude/<version>/smoke`).
- DoD: v1 domain tests pass in the new tree; stage table has one test per row and an exhaustiveness test (every open item matches exactly one row); hold, question and receipt semantics each have a spec; the conformance suite passes with `FakeEngine` on every fixture present.

### A3 — `mec-tools` and the web shell (4–6 days, week 3)

- `mec-tools`: streamable-HTTP MCP server on `127.0.0.1`, random port; attempt-scoped bearer tokens encoding (attempt, role, generation); per-role tool exposure (meta agent: all tools; specialists: `report`, `ask_user`, `request_confirmation`, `handback`, `read` of their own task); stale generation → empty tool set and a clear error; the `PermissionBridge` implementation (`mcp__mec__confirm` for Claude; in-process `request` for other adapters) with deadline → `expired`; bounded read resources (plan §6: page sizes, cursors, every id readable, nothing shows an unreadable id); batch semantics with per-item results; a stdio shim.
- `apps/web` shell: routing, layout, design tokens, settings scaffolding with save bars and revisions, a mount point for B's Slots view and terminal cards. Plan §18.
- DoD: token fencing test (stale generation rejected; specialist token cannot call `spawn_agent`/`propose_plan`); resource paging tests; bridge timeout test; the shell renders with an empty store and B's placeholder route mounts. → the shell is what B needs to mount views in week 3–4.

### A4 — Meta-agent runtime, chat UI, scheduler (8–10 days, weeks 4–5)

- Meta-agent runtime: wake vs note classes (plan §6), event-driven turn loop, context compiler (chat, stages, confirmations, holds, budgets, slot health and utilisation, notes since last turn), canonical transcript ownership, acknowledgements (one sentence, idempotent per message), routing (`attach` on explicit reference only, new work, stop, hold, conversation), four-invalid-proposals escalation, no-wait (no shell, no sleep), re-read summaries after compaction.
- Chat UI: conversation, acknowledgement cards, plan cards, decision cards (confirmations and questions with evidence one click away), inbox ordered by stage, secrets-in-chat guard (redact before durability, point to Slots). Plan §12, §18.
- Scheduler: passes, caps (incl. utilisation ceiling and spend caps), slot pools through the `Slots` contract (fake until H2), lowest-utilisation preference, reserved meta-agent unit, reserved wake slot for a user's message, parking/resume, retry semantics, budgets, one-live-attempt unique index. Plan §11.
- DoD: wake-vs-note spec (`progress` and own actions never start a turn; `ready`, `blocked`, questions, resolved confirmations do); acknowledgement idempotency across a simulated restart; routing spec (reference binds, similarity does not); reserved-wake-slot test (every slot busy, a follow-up still reaches its specialist before a queued launch); a full fake run: message → acknowledgement → plan → `FakeRuntime` attempts → reports → result in chat. → **H1** needs the effects queue and bridge from A1/A3; **H2** is this item on real slots.

### A5 — Guardrails, policy, specialists, work views (7–9 days, weeks 5–6)

- Guardrails: confirmation classes (incl. slot switch, spend, unsandboxed run, close own PR), binding hash, CAS resolve, stale on input change, expiry is never consent; policy file (`~/.mec/policy.yaml`, per-repo overrides that only tighten), version hash recorded with mandates and plans, policy-change notes to affected live attempts and the meta agent, pairs, pre-authorised classes recorded per use; holds enforcement. Plan §13.
- Specialist registry: built-in roster, scope and delivery sections, preferred slot class per role, pinning; ad-hoc roles (schema, compiler, validation, immutable revisions). Plan §7.
- Work view: agent graph, work-item pages (originating message, mandate, policy version, hold, questions, handoffs, outcome), task board, search by reference, glossary. Plan §18.
- DoD: confirmation race test (one authoritative resolution); stale and expiry tests; policy change delivers a note and never cancels; hold persists across restart and new attempt; compiler rejects invalid ad-hoc roles with actionable errors; graph renders from a fixture store.

### A6 — Integration queue and PR flow (6–8 days, weeks 6–7)

- `packages/git` merge primitives (`merge --no-ff`, conflict state, mid-merge worktree setup, diff/impact); integration worktree per work item; dependency-ordered merges with checks on the exact merge SHA; mid-merge repair tasks; `basePolicy` integration vs contract. Plan §14.
- PR flow via the user's `gh`: yield-to-duplicate check (human branch/PR containing the change → `dropped`), PR body from the release agent, push and PR creation through `external` effects with uncertain-send reconciliation, merge confirmation, CI gating, re-run on target-branch movement. Plan §14, §15.
- DoD: parallel-branches and integration-conflict scenarios from §26; `external` reconciliation test (uncertain send, idempotency marker); yield test. → **H3** on a real GitHub repo, using B's isolation profiles and worktrees.

### A7 — Prototype patterns, prompts, fault suite (6–8 days, weeks 7–8)

- Receipts and ownership: delivered/read/handled/settled, follow-up ownership (meta agent may only stop while owned), hand-back once with reason, release on end, question routing to where the message was written, exactly one copy after redelivery. Plan §12.
- Prompt bundles: layers with the engine layer and generated sections last, provenance, revisions naming their base, 409 on stale base, identical-to-default override removed, **Default updated** flow with diffs, proposal area, model-surface tests (tool schemas, bundle text, skills, cards within size budgets; built-in text states each enforced rule). Plan §16.
- Fault suite, core half: every §26 scenario that is domain, intake, effects, guardrails or scheduler; pause processing (no launch/deliver/relay/outbound; deadlines shift); retention eligibility rules (the job itself is B's).
- DoD: the §26 rows owned by A green on `FakeEngine`; the suite is one file tree with B's half. → **H4**

### A8 — Full acceptance (1–2 days, week 9)

- Wizard hooks for policy defaults; the §23 run on four configurations with B; plan and docs updated with what changed. → **H5**

## 5. What you need from B, and when

| Need | From | By |
| --- | --- | --- |
| First real fixture (`claude/<version>/smoke`) | B0 | day 2 |
| Review of the contracts PR against the installed engines | B0 | day 3 |
| Runtime + Claude adapter on the fake CLI, `Workspaces` and `Checks` | B1 | H1, end of week 2 |
| Slot layer (`Slots` contract) and login cards | B2 | H2, week 4–5 |
| Isolation profiles on macOS and Linux | B1/B2 | H3, week 6–7 |
| Runtime half of the fault rig (engine death, sleep/wake, stalled attempt, capability drift) | B3 | H4, week 8 |

## 6. Handshake obligations

- **H0**: the tag, the skeleton, `MemoryRepositories` and `MemoryCoreForEngines` delivered.
- **H1**: effects queue and `PermissionBridge` ready to receive B's runtime; a scripted brief runs through your core.
- **H2**: you drive the demo: chat → plan → specialists on real slots → question → result.
- **H3**: you drive the §23 run on the test repo.
- **H4**: merged fault suite; **H5**: acceptance support.

## 7. Working notes

- Every command on the core is imperative and may throw `UserError`; every fact from the runtime is past tense and may not be refused. Keep that naming.
- One writer per state: the table in plan §17 is enforced by tests that grep for writes outside the owner.
- No table, event or log line may carry a credential; the redaction filter runs on every write path and a fixture test proves it.
- When the spec and v1 disagree, the spec wins; note the deviation in `docs/adr/`.
- Report at the end of each item: what landed, what is stubbed, which §26 rows are green.
