# MEC v4.1 — Two-person parallel split

Companion to `spec.md` (3 November 2026). It divides the v4.1 backlog into two streams that can start on the same day and meet at five handshakes. Section numbers (§) and backlog ids (V01–V30) refer to the plan.

## 1. The split in one line

**Stream A — Core and workflow (the brain):** store, effects queue, domain, guardrails, scheduler, intake and receipts, meta-agent runtime, `mec-tools`, specialists, integration and PRs, prompt bundles, chat/inbox/work UI.

**Stream B — Engines, slots and runtime (the hands):** engine adapters (Claude, Codex, OpenCode), slots and authentication, process supervision and isolation, worktrees and checks, repositories, Slots UI and first-run wizard, launcher/status/doctor/packaging, fake CLIs and provider fixtures.

The seam is the one the architecture already has: **A owns everything that decides; B owns everything that executes.** A never needs a real coding-agent CLI (it runs against an in-process fake engine); B never needs the meta agent (it runs attempts from a scripted brief). They meet through a small set of contracts fixed in the first three days.

Who takes which: A suits whoever is stronger in domain modelling, state machines and UI; B suits whoever is comfortable with process supervision, OAuth and CLI quirks, sandboxes and wire protocols. Both are full-stack TypeScript; neither is "backend" or "frontend".

## 2. Ownership map

| Package / area | Owner | Notes |
| --- | --- | --- |
| `packages/contracts` | **shared** | Changes need both reviewers and a fixture update (§5) |
| `packages/domain` | A | state machines, stages, graph validation, caps, holds, receipts, slot states, in-memory repositories |
| `packages/effects` | A | effects queue, passes, health board (B's parts claim entries through its interface) |
| `packages/policy`, `packages/prompts` | A | |
| `packages/mec-tools` | A | the MCP server, read resources, permission-bridge implementation; B only needs its URL and token |
| `packages/runtime` | B | supervisor, env allowlist, shims, gitconfig, journal, worktrees, checks, isolation profiles, background caps |
| `packages/engines` | B | adapter interface implementation per engine; `classify`, report mapper, capability probe |
| `packages/slots` | B | homes, login orchestration, keystore courier, probes, provider profiles, usage models, redaction patterns |
| `packages/git` | B owns; A adds | B: clone cache, worktrees, head/diff. A: `mergeNoFF`, conflict state, impact diff — same package, file-level ownership |
| `packages/testkit` | split | A: in-memory repositories, scripted `FakeEngine`, domain fault rig. B: fake CLIs (one per engine), provider error fixtures, protocol fixture recorder |
| `apps/desktop` | B | launcher, `status`/`stop`/`restart`, `doctor`, `migrate` wrapper, `slot` CLI, packaging; the server bootstrap calls A's composition root |
| `apps/web` shell, chat, inbox, work view, settings (policy, prompts) | A | app shell lands in week 1 so B can mount its views |
| `apps/web` Slots view, terminal cards, first-run wizard, repositories settings | B | isolated routes/components mounted in A's shell |
| Store (SQLite, lock, migrations, event log) | A | part of V01 |
| Repositories (registration, bootstrap/check profiles, trust, UI-evidence flag) | B | V07 |
| Backups, restore drill, retention job, watchdog prompt | B | state-dir centric; A supplies the store backup API |
| Scorecards (projection, views) | B | moved from A to balance load; built on A's event schemas |
| `SETUP.md`, onboarding docs | B | |
| Plan documents, ADRs | A | |

CODEOWNERS enforces the table. A PR that touches the other stream's package gets that owner's review; small, trunk-based, feature-flagged where integration is incomplete.

## 3. Backlog by stream (ordered)

Estimates are the plan's phase estimates split by ownership; both streams total roughly 33–46 engineer-days. Weeks assume both people full-time from 3 November 2026.

### Stream A — Core and workflow

| Order | Items | Days | Target week | Needs from B |
| --- | --- | --- | --- | --- |
| A0 | Contracts sprint (with B, §5); monorepo skeleton, CI | 1.5 | 1 | — |
| A1 | V01 (store part): SQLite, directory lock, migrations with checksums, event log, config; V30: effects queue, passes, health board | 5–7 | 1–2 | — |
| A2 | V03: domain port — state machines, stages, task-graph validation, impact diff, caps, holds, report and question model, role-scoped core interfaces, receipts; in-memory repositories; scripted `FakeEngine` that replays B's golden fixtures | 6–8 | 2–3 | fixture format (A0) |
| A3 | V26: `mec-tools` MCP server, attempt tokens with generation fencing, per-role tool exposure, bounded read resources, batch semantics, permission-bridge implementation; V02 (shell part): web app shell, routing, settings scaffolding | 4–6 | 3 | — |
| A4 | V08: meta-agent runtime — wakes and notes, turn loop, context compiler, acknowledgements, routing, four-invalid-proposals escalation; V09: chat UI, decision cards, inbox by stage, secrets-in-chat guard; V12: scheduler (passes, caps, pools, reserved wake slot, parking/resume, retry, budgets) against the Slots contract with fake slots | 8–10 | 4–5 | H1 runtime for real attempts; H2 slots |
| A5 | V13: guardrails — confirmation classes, CAS resolve, stale/expiry, policy file + version hash, policy-change notes, holds; V10/V11: specialist registry, scope and delivery sections, slot classes, ad-hoc roles; V18 (A part): agent graph, work-item pages, search, glossary | 7–9 | 5–6 | — |
| A6 | V16: integration queue (merge functions in `packages/git`), V17: PR/merge via gh, yield-to-duplicate, CI gating | 6–8 | 6–7 | B's worktree/check APIs (H1), isolation profiles (H3) |
| A7 | V14: receipts, follow-up ownership, hand-back, release on end, question routing; V15: prompt bundles, revisions, default-updated flow, model-surface tests; V20 (core part): fault suite for domain/effects/intake scenarios, pause, retention eligibility | 6–8 | 7–8 | B's fault rig for runtime scenarios |
| A8 | Full-acceptance support: wizard hooks for policy defaults, final §23 run, docs | 1–2 | 9 | H5 |

### Stream B — Engines, slots and runtime

| Order | Items | Days | Target week | Needs from A |
| --- | --- | --- | --- | --- |
| B0 | Contracts sprint (with A); V01 (launcher part): `mec` binary, `status`/`stop`/`restart` contract, intentional-stop marker, `doctor` skeleton | 2–3 | 1 | — |
| B1 | V04: supervisor (process groups, generation ownership), env allowlist + name scrub, shims and gitconfig with integrity checks, journal (fsync, ack cursor, replay), worktrees and clone cache (`packages/git`), check runner, background caps, recovery notes; V05: Claude adapter — capability probe against the installed CLI, stream-json normalisation, `rate_limit_event`, permission-prompt bridge call, `classify(error)`, report mapper; fake Claude CLI + golden fixture recorder; V27 (Claude part): `--settings` sandbox profile, `--restricted` profile, `--setting-sources user`, `--strict-mcp-config` | 8–10 | 1–3 | store write API and `CoreForEngines` facts (contract; stubbed until A1) |
| B2 | V06: slot layer — homes per engine, slot state machine, login terminal cards (node-pty + xterm.js), serialised logins, link-existing, identity capture, local probes, usage models, parking/resume, switch with handoff packs, pairs; V28: keystore courier, fingerprints, zero-token validators, rotation, shred, redaction patterns, Gemini free-tier warning; V29: compliance guard; Slots view; V07: repositories, bootstrap/check profiles, trust level | 7–9 | 3–5 | A's shell (A3) to mount views; scheduler contract for `reserve`/`release` |
| B3 | V20 (runtime part): backup/restore with credential exclusions + drill, watchdog prompt, runtime fault scenarios (engine death, sleep/wake, stalled attempt, capability drift); V19: scorecards projection and views | 4–6 | 5–6 | A's event schemas (A1), A's fault rig conventions |
| B4 | V22: Codex adapter — `CODEX_HOME` slots, browser/device-code login cards, app-server login when proven, `--with-api-key` courier, app-server bridge, `exec --json` read-only path, `account/rateLimits`, sandbox, fixtures; mixed-engine acceptance | 7–10 | 6–8 | H3 core for mixed-engine runs |
| B5 | V23: OpenCode V2 adapter — XDG slots, `OPENCODE_CONFIG`, GLM + Gemini profiles and courier, serve + SSE bridge, permissions list, project-config lock, V1 detection, fixtures; V21: packaging with prebuilds, onboarding wizard, `SETUP.md`, `mec slot` CLI, update flow; four-configuration acceptance | 8–11 | 8–9 | H4 |

If one stream runs more than a week behind at a handshake, the next self-contained item moves across: scorecards, retention, SETUP.md, the agent-graph view and docs are the designated movable pieces.

## 4. Handshakes

```
week   1      2      3      4      5      6      7      8      9
A   ──A0─A1────A2────A3───────A4──────────A5────────A6──────A7──A8
B   ──B0─────B1──────────B2───────────B3──────B4─────────────B5──
          │          │           │            │              │
         H0         H1          H2           H3        H4   H5
```

| Handshake | When | What must be true | Owner of the demo |
| --- | --- | --- | --- |
| **H0 — contracts frozen** | end of day 3 | `packages/contracts` v0 merged: event schemas, adapter/runtime/slots/bridge interfaces, `CoreForEngines` facts, store and health-board interfaces, fixture format, CODEOWNERS, CI green with both empty suites | both |
| **H1 — one attempt end to end** | end of week 2 (slips to mid-week 3 at worst) | A's effects queue launches an attempt through B's runtime and Claude adapter on the fake CLI; journal → store; checks run on a pinned base; a permission request from the engine reaches A's bridge and returns a decision; `rate_limit_event` fixture parks the attempt. This is the L2 exit gate | B drives, A's core underneath |
| **H2 — real request via chat** | end of week 4–5 | a user message in chat → acknowledgement → plan card → specialists on two real Claude slots created through the login card → reports and a question back in chat; a `claude-api` slot added by pasting a key; the L3 exit gate | A drives, B's slots underneath |
| **H3 — §23 against a real GitHub repo** | end of week 6–7 | integration queue, PR via gh, confirmation cards, isolation profiles proven on macOS and Linux; the L5 exit gate | A |
| **H4 — fault suite green + Codex** | end of week 8 | the §26 table green on fake CLIs (A's and B's halves merged into one suite); Codex slot signs in, mixed-engine delivery; backups and restore drill | both |
| **H5 — full acceptance** | end of week 9 | OpenCode slots on GLM and Gemini, four configurations, one `npx` install, first run without docs, agent-guided SETUP.md run by a coding agent; the L8 exit gate | B |

Between handshakes the streams do not block each other: A uses `FakeEngine` and fake slots until H1/H2; B uses a scripted brief and a stub `CoreForEngines` until A1 lands, then the real store.

## 5. Contracts fixed in the first three days

All of these live in `packages/contracts` as Zod schemas plus a one-page markdown note each; the fixture files in `packages/testkit/fixtures` are the executable truth both suites consume.

**Day 1 — events and briefs**
- `EngineEvent` (normalised, engine-agnostic): `session_started {session_id}` · `message {role, text}` · `tool_call {name, input, output?}` · `permission_request {request_id, operation, evidence}` · `usage {tokens, cost?}` · `rate_limit {window, status, utilization?, resets_at?}` · `report {kind, summary, question?, artifacts, head_sha?}` · `error {class, detail}` · `exit {code, terminal_reason}`.
- `AttemptBrief`: role revision, original message(s) verbatim or by read pointer, task objective, owned paths, acceptance checks, routing note (≤ 50 words), budget, bundle revision, tools URL/token, env additions.
- `Report` and `Question` exactly as §10 (closed vocabulary; reuse/replace/clear semantics).
- Fixture format: one `.jsonl` per scenario of `EngineEvent` lines, recorded redacted from real engines by B, replayed by A's `FakeEngine` and asserted by B's adapter tests.

**Day 2 — the four interfaces**
```ts
interface EngineAdapter {                       // B implements per engine
  probe(slot: SlotRef): Promise<Capabilities & AuthHealth>
  launch(spec: LaunchSpec): Promise<AttemptHandle>   // argv + env already built by the runtime
  send(h: AttemptHandle, input: Input): Promise<void>
  interrupt(h: AttemptHandle): Promise<void>
  stop(h: AttemptHandle): Promise<void>
  events(h: AttemptHandle): AsyncIterable<EngineEvent>
  classify(error: unknown): 'quota' | 'auth' | 'provider_down' | 'engine_bug' | 'repo_failure'
  mapReport(final: unknown): Report
}
interface Runtime {                             // B implements
  launchAttempt(attempt: AttemptRef, brief: AttemptBrief, profile: IsolationProfile): Promise<void>
  deliver(attempt: AttemptRef, input: Input): Promise<void>
  stop(attempt: AttemptRef): Promise<void>
  replay(attempt: AttemptRef): Promise<void>    // journal → CoreForEngines facts after a restart
}
interface Slots {                               // B implements
  list(): Promise<Slot[]>
  healthy(filter: SlotFilter): Promise<Slot[]>
  reserve(slot: SlotId, attempt: AttemptRef): Promise<Reservation | 'full'>
  release(r: Reservation): Promise<void>
  usage(slot: SlotId): Promise<UsageReading | 'unknown'>
  probe(slot: SlotId): Promise<SlotState>
}
interface PermissionBridge {                    // A implements; the runtime calls it
  request(attempt: AttemptRef, operation: Operation, evidence: Evidence, deadline: Date): Promise<'allow' | 'deny' | 'expired'>
}
```
- `CoreForEngines` (A implements; the runtime reports facts, past tense): `attemptStarted`, `inputsDelivered`, `inputsRead`, `turnEnded`, `reportReceived`, `questionRaised`, `permissionRequested`, `rateLimitObserved`, `attemptExited`, `deliveryFailed`.
- `Workspaces` (B): `prepareWorktree(repo, baseSha, branch) → path`, `headSha(path)`, `diff(path, base)`; `Checks` (B): `run(profile, path) → CheckResult` with the passed/failed/could-not-start distinction.

**Day 3 — infrastructure seams**
- `Store` repositories and `atomic`, `Effects.enqueue(kind, key, payload)` with `Later`, `HealthBoard.claim(name)`; `MemoryRepositories` with the store's ordering and nested rollback so B's unit tests need no SQLite.
- `IsolationProfile` (A asks, B builds): sandbox strictness, allowed domains, credential deny lists, blocked commands, background cap.
- `mec-tools` handshake: A's `issueToken(attempt, role, generation)`; B places `MEC_TOOLS_URL`/`MEC_TOOLS_TOKEN` into the attempt env and the engine's MCP config.
- Error codes: `UserError(code, values)` list shared by API, panel and cards.

After H0, a contract change is a PR with both reviewers, a fixture update and a changelog line; nothing else about the split needs agreement.

## 6. What each person does on day one, alone

**A:** scaffold the monorepo and CI; write the store (open with lock, migrations, event log) and the first domain state machines with tests on in-memory repositories; start the `FakeEngine` against a hand-written fixture.

**B:** install the three CLIs on both machines and record their versions; write the capability probe for the installed Claude Code (flag presence, `auth status --json`, `rate_limit_event` availability); write the supervisor (process groups, generation ownership, SIGTERM escalation) and the first fake CLI that emits a fixed stream-json script; create two `CLAUDE_CONFIG_DIR` homes on macOS and confirm distinct Keychain items — the first finding goes into the fixtures.

## 7. Working agreements

1. **Contracts first, then diverge.** Three days together on §5; nothing else is designed jointly.
2. **One fixture library.** B records redacted real-engine streams; A replays them. A scenario that breaks one suite breaks both.
3. **Owner review across the seam.** CODEOWNERS routes PRs; a change in the other stream's package waits for its owner, who answers within a working day.
4. **Trunk-based, flagged.** Short-lived branches; incomplete integrations behind `MEC_FAKE_ENGINE`, `MEC_FAKE_SLOTS` and `MEC_SKIP_SANDBOX` flags that only tests set.
5. **A daily note, a weekly handshake.** One line a day on what changed at the seam; thirty minutes at each handshake with the demo in the table, not a status meeting.
6. **The plan is the spec.** Behaviour questions are answered from `spec.md`; a change to it is a PR from A with B's review, and the §26 table is updated in the same PR.
7. **Secrets never cross the seam in a fixture.** The fixture recorder redacts before writing; the compliance guard (V29) runs in CI from week 3.
8. **Rebalance at handshakes only**, by moving one of the designated movable items (§3), never by splitting an item in two.

## 8. Risks specific to the split

| Risk | Mitigation |
| --- | --- |
| A's scheduler and B's slot layer disagree on reservation semantics | `reserve`/`release` are in the day-2 contract with a fixture of concurrent reservations; fake slots implement the same contract |
| The permission bridge timing differs per engine (Claude blocks on the MCP tool; Codex and OpenCode answer a request id) | the bridge contract carries a deadline and returns `expired`; each adapter maps its native semantics in B's package, A never sees engine specifics |
| H1 slips because B's runtime and A's store both land late | B stubs `CoreForEngines` in memory for week 1–2; A's effects queue runs against `MemoryRepositories`; H1 only needs the fake CLI, not real logins |
| Engine versions move during the build (OpenCode ships near-daily) | B pins versions per machine in week 1 and re-probes deliberately at H4/H5; fixtures carry the version they were recorded from |
| Two people touching `apps/web` | A owns the shell, routing and chat; B's views are self-contained routes with their own components; no shared stateful components until H3 |
