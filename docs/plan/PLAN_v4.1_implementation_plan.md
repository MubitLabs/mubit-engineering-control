# Mubit Engineering Control — Full Product Implementation Plan

**From the current scaffold to a fully built product** · 3 November 2026
Companion to `PLAN_v4.1_local_meta_agent.md` (the spec: what the product is and how it behaves), `PLAN_v4.1_parallel_split.md` and the hand-off kit (how two streams build it). This document answers two questions the spec does not: *what does "fully built" mean, release by release, and what is needed — people, machines, accounts, money, time, decisions — to get there?*

---

## 0. How to read this

- **§1** defines the releases R0–R6 and the acceptance criteria that make each one "done". Everything else serves those gates.
- **§2** states where the build stands today and the audit that must pass before more building.
- **§3–§5** are the work: engineering by release, product work that is not engineering, and the calendar.
- **§6** is the consolidated "what is needed" list. **§7** quality and release gates. **§8** risks. **§9** the decisions only the owner can make. **§10** operating the product after it ships.

The spec's backlog ids (V01–V30) and verification rows (§26) are referenced, not repeated.

---

## 1. What "fully built" means

| Release | Name | One-line definition | Acceptance (all must hold) |
| --- | --- | --- | --- |
| **R0** | Scaffold | the two streams' packages exist, contracts frozen, tests green on fakes | `contracts-v0` tagged; CI green on macOS and Linux; the §2 audit passed |
| **R1** | Core — Claude only | one person, one laptop, one or more Claude subscription slots, real deliveries to a real GitHub repository | spec §0 "core acceptance"; handshakes H1–H3 passed on real binaries; §26 rows for core, slots and Claude all green; fault suite incl. pause, secrets guard, park-on-rejected; `mec backup`/`restore` drill passed; a week of daily use by the owner on a private repo with the scorecard showing zero lost work |
| **R2** | Full — four configurations | Claude, Codex, OpenCode-GLM and OpenCode-Gemini slots, mixed-engine deliveries, `npx` install, first run without docs | spec §0 "full acceptance"; H4–H5 passed; real (not synthetic) fixtures for all three engines; `npx mubit-engineering-control` on a clean macOS and a clean Linux machine reaches a healthy slot in under two minutes per engine; a coding agent completes `SETUP.md` end to end; security review (§7.4) closed; docs site live |
| **R3** | Proactive — GitHub as a source | the agent watches a repository: issues, PRs, review comments and CI as triggers, with off/observe/auto admission and mandates revalidated before resume | spec §24 later phase 1; admission table, subscriptions, three-facts assessment, bot round budgets; a month in `observe` on a real repo with the recorded "would accept" decisions reviewed; a human stop persists across every trigger kind |
| **R4** | Learning — scorecards to experiments | prompt and role changes are evaluated on captured cases before promotion | spec §24 later phase 2; case capture from real deliveries; paired candidate-vs-incumbent trials; human-reviewed promotion; a default-prompt upgrade shipped through the pipeline |
| **R5** | Breadth | more providers on existing engines (`codex-glm`), Gemini CLI as an engine, a direct-API adapter, multi-repo deliveries | spec §24 later phases 3–4; every addition goes through the same slot layer, conformance suite and §26 rows; one multi-repo delivery with a compatibility manifest and one PR per repo |
| **R6** | Team edition | multi-user, grants, hosted deployment on the v3 design | separate plan; starts only on evidence of demand (§9); not part of "fully built" for the local product |

**"Fully built" for the local product = R2.** R3–R5 complete the product vision in the spec; R6 is a different product line that reuses the foundations. A release ships only when its acceptance holds on real binaries, real accounts and a real repository — never on fakes, however many tests pass.

---

## 2. Where the build stands, and the audit gate

The report of 3 November describes a large scaffold produced in one day: fifteen packages, `contracts-v0`, a fastify server and React workbench, a `mec` CLI with the status contract, real Claude fixtures from four recordings, synthetic Codex and OpenCode fixtures, and an acceptance run on a fake engine with a fake brain. By its own account it has not reached any real-binary handshake: no slot was created through a login, no real engine ran an attempt, no PR was opened, the pty for login cards is absent, and five §26 rows are open. Two of the bugs it found — tests that agreed with a wrong header, CI green while native builds silently didn't run — show that author-written tests cannot be the evidence.

**Audit gate (R0 exit).** A fresh reviewer instance that did not write the code, on a cold clone, on both machines:

1. `pnpm check` green on macOS and Linux; the native modules actually built (`node-pty`, `better-sqlite3` load in a smoke script).
2. Every "proven" row of `docs/fault-suite.md` tied to a test file and, where the row concerns an engine, to a fixture with `recorded_by: 'real'`; rows proven only on fakes are relabelled.
3. The safety-bearing paths exercised for real, not mocked: a real `ANTHROPIC_API_KEY` in the parent shell is absent from a spawned engine process; the redaction filter catches each provider's real key shape; the compliance guard fails on a planted `readFileSync('.credentials.json')`; confirmation CAS under a concurrent race; two processes on one `~/.mec` — the second refuses.
4. `contracts-v0` diffed against `CONTRACTS.md`; drift resolved by a reviewed change, not silently.
5. Tests that assert nothing, mock the unit under test, or snapshot their own output are listed and either fixed or deleted.
6. The report's claims rewritten into `docs/STATUS.md` as what is verified, what is on fakes, what is absent.

Only then does R1 work start. Expected: two to three days.

---

## 3. Engineering work by release

Owner streams are the ones in the hand-off kit: **A** core and workflow, **B** engines, slots and runtime. Estimates are engineer-days of focused work with coding agents assisting; calendar time is longer because every gate needs real logins, real vendors and real repositories.

### R1 — Core, Claude only (≈ 30–40 days; target end of week 7, mid-December 2026)

| # | Work | Owner | Spec refs | Gate |
| --- | --- | --- | --- | --- |
| R1.2 | **H1 on the real binary**: a dedicated `CLAUDE_CONFIG_DIR` slot via `claude auth login`; scripted brief through the real runtime and adapter; sandbox profile on macOS and Linux; `--restricted` for a read-only role; permission-prompt bridge through `mec-tools`; checks on the pinned base; verify-on-install items (auth status fields, `rate_limit_event` shape and units, `--bare` default status); real fixtures replace synthetic Claude ones | B, A for the bridge | §5.3, §8, §9 | H1 |
| R1.3 | **Login cards for real**: node-pty with prebuilds (`node-pty` 1.1.x or `@homebridge/node-pty-prebuilt-multiarch`), xterm.js card, URL detection, serialisation, timeout, identity capture, re-login card that resumes parked work | B | §5.6 | H2 |
| R1.4 | **The real brain**: meta agent on a Claude slot through `mec-tools`; wakes and notes; acknowledgements; routing; questions; the chat loop end to end with real specialists | A | §6, §12 | H2 |
| R1.5 | Keystore courier and `claude-api` slots; zero-token validators; Slots view | B | §5.4, §5.7, §18 | H2 |
| R1.6 | Close the open §26 rows: park-on-rejected wiring from real `rate_limit_event`, secrets-in-chat guard, pause, and the remaining two; merged fault suite | A, B | §26 | before H3 |
| R1.7 | **H3 on the GitHub test repo**: integration queue, release agent, yield-to-duplicate, PR via `gh` behind confirmation cards, merge confirmation after CI, target-branch re-run | A | §13–§15 | H3 |
| R1.8 | Guardrails and policy file end to end: classes, pre-authorisation, pairs, spend caps, policy-change notes, holds | A | §13 | H3 |
| R1.9 | Prompt bundles: revisions, default-updated flow, model-surface tests; specialist roster with scope and delivery sections | A | §7, §16 | H3 |
| R1.10 | Backups, restore drill, retention; `mec doctor`; scorecards v1 | B | §19–§21 | R1 |
| R1.11 | **Owner's week of daily use** on a private repository with default guardrails; every surprise becomes an issue; the scorecard confirms zero lost work and shows messages-per-delivery | owner | §0 success measures | R1 |

### R2 — Full, four configurations (≈ 25–35 days; target end of week 11–12, late January 2027)

| # | Work | Owner | Spec refs | Gate |
| --- | --- | --- | --- | --- |
| R2.1 | **Codex adapter on a real ChatGPT login**: `CODEX_HOME` slots, browser and device-code login cards, app-server bridge, approvals mapping, `account/rateLimits`, sandbox, `exec --json` read-only path, generated protocol types pinned; real fixtures replace synthetic | B | §5, §9 | H4 |
| R2.2 | **OpenCode V2 adapter on real GLM and Gemini keys**: XDG slots, `serve --stdio` per slot, provider profiles, permissions list, project-config lock, V1 detection, SSE bridge; real fixtures | B | §5, §8, §9 | H5 |
| R2.3 | Mixed-engine deliveries: reviewer on a different provider, handoff packs across engines, pairs across engines | A | §5.10, §7, §15 | H4 |
| R2.4 | Packaging: `npx` distribution with prebuilds for macOS/Linux × arm64/x64, refuse-to-compile message, update flow, version pinning per slot, `mec slot` CLI | B | §21 | H5 |
| R2.5 | First-run wizard completion; `SETUP.md` run by a coding agent on a clean machine | B | §21 | H5 |
| R2.6 | Provider usage models verified on real limits (a deliberate GLM window exhaustion; a Gemini per-minute 429; a Claude `allowed_warning`) | B | §5.9 | H5 |
| R2.7 | Security review and threat model (§7.4) closed; compliance guard in CI; vendor-terms text in the Slots UI | both | §5.11, §22 | R2 |
| R2.8 | Documentation set (§4.1) and the diagnostics path for support | A | — | R2 |
| R2.9 | **Beta with three to five outside users** for two weeks: `mec doctor` bundles, a feedback issue template, fixes; nothing new | both | — | R2 |

### R3 — Proactive, GitHub as a source (≈ 15–22 days; target end of February 2027)

Built on the dsh-superagent admission model the spec reserves for this phase.

| # | Work | Spec refs |
| --- | --- | --- |
| R3.1 | GitHub source: polling through the user's `gh` (notifications, subscribed issues and PRs, CI changes; webhooks need a public endpoint and come later via an optional relay); triggers with actor metadata; threads and channels; read positions that survive restart | §24 phase 1; dsh 001/008 |
| R3.2 | Admission: allowed list in GitHub identities, admission table per receiving scope, bot list, strength explicit/inferred, accept modes `off/observe/auto`, policy version covering it, revalidation before resume | dsh 002 |
| R3.3 | Assessment: the three facts, one judgement per enabled rule, `unavailable` vs `ignore`, "would accept" records in observe mode | dsh prompts/admission.md |
| R3.4 | Subscriptions: later discussion fans out to the work it belongs to; PR threads bound to tasks; closes end work items; automated-reviewer round budgets per PR; review-by-outcome on GitHub | dsh 003, team/communication.md |
| R3.5 | Replies on GitHub through the outbox with the agent-disclosure line; human stop persistence across every trigger kind | §13, dsh 004 |
| R3.6 | A month in `observe` on a real repository; the recorded decisions reviewed before `auto` is offered | — |

### R4 — Learning, scorecards to experiments (≈ 20–30 days; target April 2027)

| # | Work |
| --- | --- |
| R4.1 | Case capture: every delivery becomes a replayable case (request, repo snapshot ref, plan, outcomes), private to the machine |
| R4.2 | Paired trials: a candidate bundle or role revision against the incumbent on captured cases, with the same slots and caps; cost and attention measured, not just pass/fail |
| R4.3 | Promotion: human-reviewed, recorded as a bundle revision with provenance; a default-prompt upgrade shipped through it |
| R4.4 | Views: which roles earn their keep, which providers suit which work, where attention goes |

### R5 — Breadth (≈ 25–35 days; target May–June 2027)

| # | Work |
| --- | --- |
| R5.1 | `codex-glm` and other `responses`-compatible providers on Codex; Gemini CLI as a fourth engine through the same slot layer; a direct-API adapter for users without a CLI subscription |
| R5.2 | Multi-repo deliveries: one plan across registered repos, one PR per repo, a compatibility manifest, dependency-aware integration (the v3 §14 design) |
| R5.3 | Optional GitHub webhook relay for R3 latency |

### R6 — Team edition (separate plan; months, not weeks)

Multi-user identity, grants, hosted deployment, fleet of runners — the v3 build plan, re-based on these foundations. Not scheduled; see §9.

---

## 4. Product work that is not engineering

### 4.1 Documentation (R1 minimum, R2 complete)

- `README.md`: what it is, the one command, the first five minutes.
- User guide: concepts (slots, work items, stages, confirmations, holds), the Slots panel, the policy file, prompt bundles, backups, troubleshooting by symptom (the dsh table format), vendor-terms summary.
- Reference: `mec` CLI, `policy.yaml` schema, the bundle layers, the §26 matrix as "what is tested".
- `SETUP.md` for agent-guided setup; `docs/engines.md` with pinned versions and the verify-on-install items.
- Contributor docs if open-sourced (§9): architecture (spec §3–§4), contracts, how to record a fixture, how to add an engine or provider.

### 4.2 Release engineering (R2)

- npm organisation and package name reserved (`mubit-engineering-control`, bin `mec`); semantic versions; changelog generated from PR labels; release checklist (§7.5).
- Prebuild matrix in CI: macOS arm64/x64, Linux arm64/x64; a smoke job that runs `npx` from the published tarball on a clean runner.
- Update flow tested across one real version bump, including a migration.

### 4.3 Support and feedback (R2)

- GitHub issues with a template that asks for the `mec doctor` bundle; a triage rota between the two of you; a "known limits" page kept honest.
- No telemetry by design (spec §22); the diagnostics bundle is the only data path, and the user sends it.

### 4.4 Legal and compliance

- Anthropic: the product runs the user's unmodified Claude Code with their own login, never intermediates tokens (spec §5.11). Obtain written confirmation from Anthropic sales that headless orchestration of the unmodified CLI under a personal subscription is "ordinary individual usage"; until then the UI keeps conservative defaults and recommends API-key slots for sustained parallel work. Naming: the legal page allows stating that the product runs Claude Code; it forbids using Claude or Anthropic names and logos in the product's own name or branding — "Mubit Engineering Control" is fine.
- OpenAI: no published restriction for Codex CLI in third-party harnesses; the same two rules (unmodified binary, user's own login) are applied anyway.
- Z.ai: the GLM Coding Plan forbids account sharing and limits use to supported tools; MEC drives supported tools and never pools keys.
- Google: free-tier prompts may be used to improve products; the Slots form warns and private repos refuse free-tier Gemini slots.
- Licence for MEC itself (§9); third-party notices for bundled dependencies.

### 4.5 Design

The workbench inherits v1's design language; the only design work is the Slots panel and the login card, and the inbox stage labels. One pass of a designer's eye before beta is a nice-to-have, not a gate.

---

## 5. Calendar

Weeks count from 3 November 2026; both people full-time with coding agents; one week of holiday buffer around the turn of the year.

```
wk 1   R0 audit (days 2–4) ─────────────────────────── R0 exit
wk 2–3 R1.2 H1 real · R1.3 login cards · R1.4 real brain
wk 4   H2 ───────────────────────────────────────────── chat → real specialists
wk 5   R1.5 keystore/api slots · R1.6 §26 rows · R1.8 guardrails
wk 6   R1.7 H3 on the test repo ─────────────────────── first real PR behind a card
wk 7   R1.9 prompts · R1.10 backups/doctor · R1.11 owner's week starts ── R1 (mid-Dec)
wk 8–9 R2.1 Codex on a real login · R2.3 mixed engines ─ H4
wk 10  (holiday buffer)
wk 11  R2.2 OpenCode on GLM + Gemini · R2.6 real limits ─ H5
wk 12  R2.4 packaging · R2.5 wizard + SETUP.md · R2.7 security review · R2.8 docs
wk 13–14 R2.9 beta ─────────────────────────────────── R2 (late Jan / early Feb 2027)
wk 15–18 R3 GitHub source, then a month in observe ───── R3 (end Feb; observe month to end Mar)
wk 19–23 R4 scorecards → experiments ─────────────────── R4 (April)
wk 24–29 R5 breadth, multi-repo ──────────────────────── R5 (May–June)
```

Slip rules: a gate slips, the next gate slips with it; no gate is passed on fakes to keep a date. If R1 slips past week 9, drop R2.3's cross-engine pairs from R2 and ship them in R5.

---

## 6. What is needed

### 6.1 People

| Role | Who | Load |
| --- | --- | --- |
| Stream A — core and workflow | one engineer + a Claude Code instance | full-time to R2, half-time R3–R5 |
| Stream B — engines, slots and runtime | one engineer + a Claude Code instance | full-time to R2, full-time R5 (adapters) |
| Reviewer | a fresh agent instance per audit, plus the other person | audit gate; every PR cross-reviewed |
| Owner / product | the person who answers "would you hand this to the meta agent again?" | the week of daily use (R1.11), beta triage, decisions in §9 |
| Beta users | three to five engineers with their own subscriptions | two weeks at R2 |

Skills that must exist between the two engineers: TypeScript/Node at depth, SQLite, process supervision on macOS and Linux, OAuth and CLI quirks, protocol work (JSON-RPC, SSE, MCP), React, and the patience to record fixtures before writing features.

### 6.2 Machines

- One macOS (Apple silicon) and one Linux (x64 or arm64) development machine; both OSes are first-class and the sandbox differs (Seatbelt vs bubblewrap + socat).
- CI: the existing self-hosted runners plus one macOS runner for prebuilds and the Keychain tests; a clean VM or container image for the `npx` smoke test.
- For R2: one clean machine per OS that has never had MEC installed, for the first-run acceptance.

### 6.3 Accounts and credentials (held by the engineers, never by the product)

| Need | For | From when |
| --- | --- | --- |
| Two Claude Pro/Max logins (one may be Team) | two Claude slots, failover and pairs, independent review | week 2 |
| One ChatGPT plan with Codex (Plus suffices; Pro removes the five-hour window) | Codex slots | week 8 |
| One GLM Coding Plan key (Lite suffices for tests; Pro for the owner's daily use) | OpenCode-GLM slots | week 11 |
| One Gemini API key on a billing-linked Google Cloud project | OpenCode-Gemini slots (free tier is refused for private repos) | week 11 |
| Anthropic and OpenAI API keys with low spend caps | `claude-api` / `codex-api` slots and validators | week 5 / week 8 |
| A GitHub organisation with a test repository that has CI and branch protection; `gh` signed in as each engineer | H3 onwards | week 5 |
| npm organisation and the package name | R2 packaging | week 12 |

### 6.4 Software, pinned

Node 24 (22 LTS floor), pnpm 10 (postinstall allowlist for native modules), git ≥ 2.32, `gh` ≥ 2.48, Claude Code 2.1.31x, Codex CLI 0.166.x, OpenCode V2 2.2.x, `bubblewrap` and `socat` on Linux. Versions are pinned in `docs/engines.md`; upgrades are deliberate, re-probed, and never mid-delivery.

### 6.5 Money (order of magnitude, per month while building)

| Item | Estimate |
| --- | --- |
| Claude subscriptions ×2 | $40–400 depending on tier (Max for realistic parallel tests) |
| ChatGPT plan | $20–200 |
| GLM Coding Plan | $18–80 |
| Gemini, Anthropic, OpenAI API spend for validators, canaries and API-slot tests | $20–100 with caps set |
| CI minutes / runners | existing self-hosted; a macOS runner if not already present |
| Total | roughly $150–800 per month through R2; mostly the subscriptions you would hold anyway |

### 6.6 Time

Engineer-days: R0 audit 3; R1 30–40; R2 25–35; R3 15–22; R4 20–30; R5 25–35; product work 15–25 across R1–R2. Total to R2 ≈ 70–100; to R5 ≈ 130–190. Calendar: R2 by late January 2027 with two people; R5 by mid-2027.

### 6.7 Decisions and permissions outside your control

Anthropic's written confirmation (requested at R1, needed before marketing R2), vendor documentation changes (watched weekly), npm name availability, beta users' consent to run on their machines with their own logins.

---

## 7. Quality and release gates

### 7.1 Test pyramid that is allowed to count

1. Domain and effects tests on in-memory repositories and SQLite sharing one test file.
2. Conformance suite: every engine fixture parsed by the real adapter and replayed by the fake engine, with `recorded_by: 'real'` required for any row marked proven.
3. Fault suite: the spec's §26 table, one test per row, run on fake CLIs in CI.
4. Real-engine canaries: a tiny delivery per engine on a real slot, run manually at each handshake and automatically on each pinned engine version change.
5. Acceptance runs on real binaries at each gate, recorded in `docs/log/HANDSHAKES.md`.

### 7.2 Review rules

Every PR is reviewed by the other stream's person or instance. Tests written by the author of the code count only when they consume shared fixtures or contract schemas; a test that mocks the unit under test is rejected. The audit gate repeats, in a lighter form, before R1 and R2.

### 7.3 Performance targets (pilot, not promises)

Chat wake-to-first-token under 5 s; confirmation card within 2 s of its event; parked-work resume under 10 s from a healthy probe; add-slot to healthy under 2 min per engine; `npx` first run under 5 min with one engine.

### 7.4 Security review (R2 gate)

Threat model written down: a malicious repository (hooks, plugins, MCP servers, instructions), a compromised engine process (reads its own credential, tries other slots' homes, tries `~/.mec/db`), a leaked diagnostics bundle, a pasted key in chat, a stale confirmation replayed, a second MEC process. For each: the control in the spec, the test that proves it, the residual risk stated. Dependency audit (`pnpm audit`), native-module provenance (prebuilds from pinned sources), the compliance guard's coverage checked by planting violations.

### 7.5 Release checklist

Version bumped; changelog; migrations tested fresh and upgrade; prebuild matrix green; `npx` smoke on clean runners; canaries green on pinned engine versions; `docs/engines.md` updated; `docs/STATUS.md` says what is real; known limits page updated; tag; publish; the owner installs it on a clean machine before announcing.

---

## 8. Risks

| Risk | Signal | Mitigation |
| --- | --- | --- |
| Anthropic tightens "ordinary individual usage" or enforcement against headless orchestration | a 429 pattern or account action during the owner's week | conservative caps by default; API-key slots first-class; written confirmation requested; never spoof, never pool |
| Engine protocol drift (OpenCode ships near-daily; Codex app-server is experimental) | conformance fails after an upgrade | versions pinned per slot; capability probe degrades the slot before any attempt; fixtures carry their version |
| macOS Keychain and `CLAUDE_CONFIG_DIR` quirks | `auth status` says logged out for a linked home | the default home runs with the variable unset; dedicated slots recommended; tested at pre-flight |
| Native prebuilds missing for a platform | `npx` compiles or fails | prebuild matrix in CI; refuse-to-compile with a clear message; `@homebridge` fallback for node-pty |
| Linux sandbox dependencies absent | attempts run unsandboxed | `mec doctor` check; policy decides fail-closed or degrade; documented install lines |
| API-key spend runaway | a reviewer loop on a Gemini or Anthropic key | spend caps per attempt, work item and day; review-round cap; park on 429 |
| Author-biased tests give false confidence | gates "pass" on fakes | audit gates; cross-review; real-binary handshakes are the only evidence |
| Scope creep from R3–R5 into R1–R2 | new concepts proposed proposed mid-stream | the spec's "few concepts" rule; later phases have their own plans |
| Two-person bus factor | one person unavailable | every package has docs and fixtures; the hand-off kit lets a third person or instance pick up a stream |

---

## 9. Decisions the owner must make

1. **Licence and openness.** Open source (MIT/Apache-2.0, with contributor docs) or source-available/closed. Affects §4.1 contributor docs, the beta, and whether fixtures (redacted) can be public.
2. **Product name and distribution.** `mubit-engineering-control` on npm with bin `mec`; confirm the name and whether a landing page is wanted at R2.
3. **Pricing.** Free tool, paid product, or free with a paid team edition later. Affects nothing before R2 except the website.
4. **Default conservatism.** The utilisation ceiling (80 %) and caps shipped by default versus what the owner uses personally.
5. **R3 scope.** Whether proactive GitHub intake is wanted at all for the single-user product, or deferred until a team edition.
6. **R6 trigger.** What evidence of demand starts the team edition (paying users, a team asking to share a fleet).
7. **Beta cohort.** Who the three to five outside users are, and whether they run Claude-only (R1) or all four configurations (R2).

---

## 10. Operating the product after R2

- **Vendor re-verification** every two weeks: the pages listed in spec §28, the pinned engine versions, a canary run per engine; a changed interface becomes an issue before a user hits it.
- **Update cadence**: a patch release when a canary fails; a minor release monthly; migrations always forward-only with a backup prompt.
- **Support loop**: issues with `mec doctor` bundles; the "known limits" page; the scorecard fields that tell you where attention and money go, used to decide what to fix first.
- **Deprecation policy**: an engine major version is supported for two releases after its successor is proven; V1 OpenCode is never supported.
- **Honesty rules that survive shipping**: unknown is never zero; a stopped work item stays stopped; nothing leaves the machine without a card; no credential ever enters the database. These are the product.

---

## Appendix A — Audit prompt for the reviewer instance

> You are reviewing, not building. Clone `MubitLabs/mubit-engineering-control` fresh. Read `docs/plan/PLAN_v4.1_local_meta_agent.md` §26 and `docs/fault-suite.md`. For each row marked proven, find the test and the fixture it uses and state whether the fixture is `recorded_by: 'real'` or `'fake'`; relabel accordingly in a PR to `docs/fault-suite.md`. Then run these checks for real, not through mocks, and report pass/fail with the command and output: (1) `pnpm check` on this machine with native modules loading; (2) spawn an engine process for a subscription slot with `ANTHROPIC_API_KEY=test` in your shell and prove it is absent from the child's environment; (3) feed each provider's real key format through the redaction filter; (4) plant `readFileSync('.credentials.json')` in an adapter and prove the compliance guard fails CI; (5) resolve one confirmation from two concurrent requests and prove exactly one wins; (6) start a second `mec` against the same `~/.mec` and prove it refuses. List every test that mocks its own unit, asserts nothing, or snapshots its own output. Finish by writing `docs/STATUS.md`: verified / on fakes / absent. Do not fix anything beyond relabelling; file issues.

## Appendix B — Gate demos

| Gate | Demo script (recorded in `docs/log/HANDSHAKES.md`) |
| --- | --- |
| H1 | real `claude` binary, dedicated slot, scripted brief, sandbox on, a permission request answered through the card, `rate_limit_event` fixture parks the attempt |
| H2 | login card creates a second slot; chat message → acknowledgement → plan → two real specialists → a question card → result in chat; a `claude-api` slot by pasted key |
| H3 | the §23 flow on the test repository: integration, PR behind a card, merge after CI behind a card; nothing pushed without a click |
| H4 | Codex slot signed in through the card; Claude implementer + Codex reviewer; restore drill; fault suite green with real fixtures for Claude and Codex |
| H5 | OpenCode slots on GLM and Gemini; four configurations; `npx` on two clean machines; `SETUP.md` completed by a coding agent |
| R3 | a mention on a GitHub issue becomes a work item under an explicit mandate; an unmentioned discussion is recorded as "would accept" in observe mode; a human "stop" ends it for good |
| R4 | a candidate prompt revision beats the incumbent on captured cases and is promoted with a recorded review |
| R5 | one request produces two PRs in two repositories with a compatibility manifest |
