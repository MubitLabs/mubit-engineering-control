# Mubit Engineering Control v4.1 — Local Meta-Agent

**Implementation plan version 4.1** · 3 November 2026
Supersedes v4 (3 November 2026). v4.1 keeps v4's scope and engineering values and solidifies four things: a unified **authentication and slot model** that covers every launch configuration — Claude Code on a Claude subscription, Codex on a ChatGPT subscription, OpenCode on the GLM Coding Plan, OpenCode on a Gemini API key — without MEC ever becoming a credential intermediary; the **concrete engine mechanics** (headless interfaces, permission bridges, isolation), verified against vendor documentation on 3 November 2026; **compliance with the vendors' terms** for subscription use; and a deeper adoption of the **dsh-superagent-prototype** patterns (work stages, report vocabulary, attention and acknowledgement discipline, effects queue, holds, health and status contracts, agent-guided setup). The v3 plan (`docs/Mubit_Engineering_Control_Build_Plan.pdf`) remains the reference for a future hosted, multi-user edition.

## What changed from v4

| Area | v4 | v4.1 |
| --- | --- | --- |
| Slot model | one `CLAUDE_CONFIG_DIR` holding one native login | **slot = engine × provider × credential × isolated home**; seven slot kinds at launch (§5.2) |
| Credential custody | "MEC never stores credentials" — defined for OAuth only | two custody classes: vendor-held OAuth sessions MEC never touches; user-owned API keys couriered once into a slot-home keystore, fingerprint-only in the database (§5.4) |
| Login UX | a terminal card | terminal card as baseline, assisted overlays (open link, device code, paste code), serialised logins, link-existing quick start, re-login cards that resume parked work (§5.6) |
| Quota | "adapters classify usage-limit errors" | per-provider usage models with verified signals: Claude `rate_limit_event`, Codex `account/rateLimits`, GLM credit windows, Gemini 429 with `RetryInfo` (§5.9) |
| Vendor terms | unstated | hard rules: unmodified binaries, no token intermediation, no OpenCode on a Claude subscription, pacing within "ordinary individual usage" (§5.11, §22) |
| Platform tools | "validated platform tools" | `mec-tools`: one streamable-HTTP MCP server on 127.0.0.1 with attempt-scoped tokens; a permission bridge per engine; bounded, role-scoped read resources (§6, §9) |
| Isolation | "minimal environment" | env allowlist + name-based scrub, command shims, per-attempt git configuration, Claude Code sandbox profile, Codex sandbox, OpenCode permission config, repo-resident agent config neutralised (§8, §22) |
| Adapters | "restricted mode" named without mechanics | Claude Code `--restricted` (v2.1.248+) confirmed and assigned to read-only roles; verified flag sets per engine; Codex via app-server (exec cannot bridge approvals); OpenCode **V2** server API (§9) |
| dsh-superagent | seven adopted patterns | thirty-odd patterns adopted or adapted, each mapped to a section (Appendix A): stages, reports, attention, acknowledgements, holds, effects queue, health board, status codes, watchdog, prompt versions, model-surface tests, setup flow |
| Work model | states only | states plus a **stage** projection that drives the inbox; `held` and `dropped`; structured questions (§10, §12) |
| Roadmap | 56–80 engineer-days | 66–91 engineer-days; the slot layer is engine-generic from L3; OpenCode may move ahead of Codex (§24) |
| Backlog and verification | V01–V25; 15 scenarios | V26–V30 added; 23 new fault-suite scenarios (§25, §26) |

---

## 0. What we are building

> **Connect your coding agents. Talk to one meta agent. It plans, spawns specialists, runs the delivery loop end to end, and only interrupts you when a guardrail or a real decision needs you.**

One local application, started with a single command (`npx` → `mec`), serving a web workbench on `localhost`. Embedded SQLite storage, no containers, no cloud services, no accounts of its own. The user's existing coding-agent subscriptions and API keys — Claude Code first, Codex and OpenCode next — power every agent in the system, including the meta agent itself.

The user's attention is the scarcest resource (the dsh-superagent philosophy): the system acts when asked or when a rule allows it, and speaks only when a person must act or can use a result. Every message, card, setting and paragraph of documentation costs attention and has to give more value than it costs, or it is removed.

**Launch configurations.** v4.1 supports four engine/provider pairs end to end, each as one or more *slots* (§5):

1. Claude Code on a Claude Pro/Max/Team/Enterprise subscription (the first release);
2. Codex CLI on a ChatGPT subscription (or an OpenAI API key);
3. OpenCode on Z.ai's GLM Coding Plan (API key);
4. OpenCode on a Google Gemini API key.

**Core acceptance (L5, Claude-only).** On a laptop, one command starts the app; the user adds a Claude Code slot by signing in through Anthropic's own browser flow inside a card in the workbench, points it at a repository, and asks the meta agent in chat for a real change. The meta agent acknowledges in one sentence, proposes a plan, specialists implement, review and security-check it in isolated worktrees, checks run on exact SHAs, the integrator produces a tested branch, and a confirmation card asks the user to approve the pull request. A quota hit mid-delivery parks the work, preserves it, and offers an explicit switch to a second signed-in slot, which continues the same worktree with a recorded handoff. Nothing above requires a terminal, a token file, or a hosted service.

**Full acceptance (L8).** The same delivery runs with mixed engines: implementers on Claude slots, a reviewer on an OpenCode slot paid by the GLM Coding Plan, a security pass on an OpenCode slot with a Gemini key, and a Codex slot signed in with a ChatGPT account. Each API key was pasted exactly once and appears in no database row, event, journal, log or backup. Each OAuth login completed through the vendor's own flow and MEC never read a token.

**Operator responsibility** (from dsh-superagent, kept as product text): start narrow — few slots, default caps, nothing pre-authorised; tune for less noise by shortening and tightening prompts rather than adding explanations; do not use the system to produce volume; own what it says in your name.

**Non-goals for v4.1** (each is a later phase, §24): multi-user, hosted deployment, GitHub-driven proactive intake, evaluation experiments and automatic improvement, multi-repo deliveries, model training, MEC-held OAuth tokens of any kind.

---

## 1. Product boundaries and success criteria

### Required behaviour

1. Accept a repository (local path or remote URL), and conversations with a single local user through a chat-first UI.
2. Connect coding agents as **engines** (Claude Code, later Codex and OpenCode); run each through **slots**, where a slot binds one engine to one provider and one credential in an isolated home directory (§5).
3. Run a **meta agent** on a slot of the user's choice: it admits, plans, decomposes, selects or designs specialists, routes follow-ups, monitors, integrates and reports (§6).
4. Run **specialists** — implementer, code reviewer, PR reviewer, security checker, test author, integrator, repair agent, release agent — from a built-in, user-editable registry, plus ad-hoc task-specific roles (§7).
5. Execute every agent attempt in an isolated git worktree on a pinned base, with capability-probed adapters, a durable journal, and deterministic checks on exact SHAs (§8, §9, §14, §15).
6. Enforce **guardrails in deterministic code**: confirmations for push, PR, merge and destructive operations; policy caps on parallelism, fan-out, budgets and spend (§13).
7. Preserve work through every failure: quota exhaustion, expired logins, revoked keys, engine crashes, app restarts, laptop sleep (§20).
8. Record immutable evidence: every state change is an event; every attempt records its diff, checks, findings and outcome (§17, §19).
9. **Never intermediate credentials**: OAuth sessions stay inside the vendor CLIs' own stores; API keys are couriered once into the slot's home and never into MEC's database (§5.4, §22).
10. **Speak by the attention rule**: acknowledge once, stay quiet while working, ask one structured question at a time, report ready, blocked or dropped honestly (§12).

### Scope decisions

| Decision | v4.1 choice |
| --- | --- |
| Users | One local user. No login, no roles, no sharing. The OS user *is* the trust boundary. |
| Platform | The local machine is the runner. macOS and Linux are first-class. No remote runners, no fleet. |
| Storage | SQLite (WAL) + files on disk under `~/.mec`. No Postgres, no Redis, no object store. |
| Engines | Claude Code in the first release; Codex and OpenCode (V2) as follow-on adapters sharing one slot layer. Direct model APIs only as a later adapter, never a requirement. |
| Providers | Anthropic subscription and API; OpenAI/ChatGPT subscription and API; Z.ai GLM Coding Plan; Google Gemini API. Any provider reachable by an engine's documented configuration, never by patching the engine. |
| Credentials | Vendor-native login for OAuth engines; paste-once keys for API providers. MEC holds no OAuth token and no key in its database. |
| Compliance | Unmodified vendor binaries, each user's own credentials, no spoofed clients, no cross-vendor subscription use (§5.11). |
| Intake | Chat with the user is the only source. GitHub as an optional source is a later phase with off/observe/auto admission. |
| Delivery | One repository per work item. Multi-repo later. |
| Merging | PRs via the user's `gh` CLI. Merge always asks, unless a pre-authorised policy class says otherwise. |
| Concepts | Few: engine, provider, slot, conversation, work item, mandate, plan, task, attempt, confirmation, report, question. A need becomes an attribute of one of these or prompt text, not a new concept. Few settings: a default replaces a setting when one value suits almost everyone; behaviour described in words is prompt text. |

### Success measures

Elapsed time from request to reviewed PR; number of guardrail interruptions per delivery (few and meaningful); work lost to failures (target: zero); quota-park-to-resume time; time from "add slot" to a healthy slot (target: under two minutes for any engine); messages sent per delivery (fewer is better); and the user's answer to one question — *would you hand this to the meta agent again?* Concurrent agent count is not itself a success measure.

---

## 2. What we take from each source

### From the v1 codebase (ported, simplified)

| v1 asset | v4.1 fate |
| --- | --- |
| Durable event log + transactional outbox | Ported to SQLite; the outbox becomes one kind in a general effects queue (§17) |
| Domain state machines, task-graph validation, impact diff | Ported nearly as-is (they are pure functions) |
| Worktrees per attempt on pinned bases; checks with passed/failed/error distinction | Ported |
| Integration queue: merge per accepted task, checks on the exact merge SHA, mid-merge conflict repair | Ported |
| Journal-before-forward, ack cursor, replay, generation fencing | Ported (now guarding process crashes and app restarts, not remote runners) |
| Claude adapter: headless `-p` stream-json, strict MCP config, capability probe, stream normalisation, redaction | Ported; "restricted mode" becomes Claude Code's `--restricted` for read-only roles and a sandbox profile for writing roles (§8, §9) |
| Decision/approval records: binding hash, CAS resolve, stale/expired semantics | Ported as confirmation cards |
| Testkit: fake CLI, fixture repos, scripted fake agent | Ported, extended per engine and per provider error shape |

### From dsh-superagent-prototype (adopted and adapted)

Reviewed in full at commit `8c32a9d` (31 October 2026): the numbered documents 000–008, `SETUP.md` and every prompt file. v4 took the first seven patterns; v4.1 takes the rest that survive a single-user, chat-first, local product. Appendix A maps each pattern to its dsh source and its MEC section.

1. **Philosophy**: take as little human attention as possible; speak only when someone must act or can use a result; few concepts, few settings; documents read in order; operator responsibility (§0, §12).
2. **Intake discipline**: every unit of work starts from an admitted trigger and carries a **mandate** (origin, scope, policy version, budget, expiry) that is revalidated before resume and withdrawn only by a person's stop or a policy that no longer holds it. Accept modes `off / observe / auto` govern proactive work (later phase); chat is always explicit (§10, §13).
3. **Follow-up routing and ownership**: a later message binds to the work it points at (reference binds; similarity is context only); while a specialist owns a follow-up the meta agent may only stop; a specialist hands back what is beyond its task, once, with a reason; messages an ending work item never handled return to intake (§12).
4. **Receipt ladder**: received → delivered → read → handled → settled, with read counted only once a report or turn end follows; a crash between stages never marks an input handled; exactly one copy of a redelivered message (§12).
5. **Report vocabulary and attention**: progress · waiting · ready · blocked · failed · dropped, each with a checkable definition; a question for a person is a structured field, never free text; raised while work continues, asked where the person wrote (§10, §12).
6. **Stages**: an open work item has one stage from a first-match table whose rows say whom it waits for and what it needs; the stage drives the inbox (§10, §18).
7. **Acknowledgement and communication policy**: confirm concretely, once, naming the object and the intended result; one sentence by default, 100 words hard ceiling; technical evidence stays in the PR and the internal report; never announce an unfinished PR; honest delivery (§12, §15).
8. **Holds**: a person's "wait" persists across follow-ups, new attempts and restarts until the person lifts it; automated feedback never resumes held work (§10, §12).
9. **Scope discipline**: stop by impact, not effort; no fixed LOC allowance; preserve partial work as an explicitly incomplete draft; yield to a human's duplicate PR (§7, §15).
10. **Separation of roles**: the orchestrator routes and never rewrites the request; the original request travels verbatim with every task; workers recheck scope against the original ("acceptance by the orchestrator is not proof") (§6).
11. **The orchestrator never waits**: reports and events arrive as messages; it ends its turn when nothing remains; wakes for what needs a decision, notes for everything else; no redundant notice for its own actions (§6).
12. **Layered prompt bundles** with provenance, revisions that name their base, refused conflicting saves, dynamic sections last, sessions recording the revisions they used, model-surface tests (§16).
13. **Effects queue**: stored first, done after commit; one row per kind and key with coalescing; backoff; `Later` defers without counting a failure; per-kind concurrency and order; a health entry per kind (§17).
14. **Health board, status codes and watchdog**: one writer per health entry; `starting | ready | paused | error`; error only after three consecutive failures and cleared by the next success; a status command with four exit codes; an hourly check run by the user's own agent that repairs only what a restart fixes and respects an intentional stop (§19, §21).
15. **Pause processing**: stops launches, deliveries and outbound messages; running turns finish; deadlines shift by the pause length (§20).
16. **Execution hygiene**: command shims first on `PATH`, blocked commands fail by name, a worker git configuration that replaces the operator's, environment variables with KEY/PASSWORD/SECRET/TOKEN in their names removed, integrity checks on what the host wrote, and the honest statement that these are defaults, not a security boundary (§8).
17. **Worker slots with a reserved slot for a person's message**: a person's follow-up never waits behind new launches (§11).
18. **Background work rules**: long jobs continue after a turn within a cap; jobs left for a person to try live until the attempt ends (§8).
19. **Bounded read resources for models**: paged, size-limited, role-scoped pages where every id shown is readable and nothing shows an id that nothing reads by (§6).
20. **Decision-first panel**: three questions (does anything need me now? is the system healthy? what happened to one piece of work?), precise mutually exclusive categories, one place per concept, honest counts, quiet by default, one save bar per block, search by reference, a glossary (§18).
21. **Agent-guided setup**: one question per message with a recommended one-word answer, no secrets in chat, one plan message, execute after confirmation, verify and hand over with three rules (§21).
22. **Rejected concepts** as a first-class table so later readers do not reopen them (§27).

### From vendor documentation (verified 3 November 2026)

The engine mechanics in §5 and §9 — credential homes, login commands, headless flags, permission bridges, rate-limit signals, sandbox settings and the vendors' terms for subscription use — were checked against the current Claude Code, Codex, OpenCode, Z.ai and Gemini documentation and, for Codex and OpenCode, their source trees (sources in §28). Everything marked *verify on install* in §9 is re-checked by the capability probe on the user's machine, because these interfaces move weekly.

### Explicitly dropped from v3

Multi-user identity, sessions, grants and delegation; employee-owned remote runners, enrolment, WebSocket protocol, fleet management; Postgres and the droplet deployment; MLflow/OTLP and the experiment/promotion machinery (a lightweight scorecard survives, §19); fairness scheduling across employees (simple caps replace it).

---

## 3. End-to-end architecture

```
┌──────────────────────────────  localhost  ──────────────────────────────┐
│                                                                          │
│  Browser ── chat-first workbench (React + Vite, served by the app)       │
│      │  chat · inbox (stages) · agent graph · diffs · checks · slots     │
│      │  terminal cards (login flows only)                                │
│                                                                          │
│  MEC core (Node, Fastify)                                                │
│   ├─ intake: chat → admission → work items + mandates · receipts        │
│   ├─ meta-agent runtime: wakes and notes, event-driven turns             │
│   ├─ mec-tools: platform tools + read resources as a streamable-HTTP     │
│   │            MCP server (127.0.0.1, attempt-scoped tokens, validated)  │
│   ├─ specialist registry + ad-hoc role compiler                          │
│   ├─ scheduler: passes, caps, slots as pools, reserved wake slot         │
│   ├─ guardrails: confirmation records, policy checks, holds              │
│   ├─ integration queue: merges, checks on exact SHAs, PR via gh          │
│   ├─ slots: homes, login orchestration, keystore courier, probes, usage  │
│   ├─ effects queue (launch · deliver · relay · note · reply · external)  │
│   ├─ SQLite (WAL): state, event log, effects — one writer, dir lock      │
│   └─ local runtime: supervisor, env + shims + gitconfig, worktrees,      │
│      journal, isolation profiles, health board                           │
│      │                                                                   │
│  Engine adapters ──────────┼──────────────┐                              │
│   Claude Code         Codex (L7)      OpenCode V2 (L8)                    │
│   ▸ per-slot homes: CLAUDE_CONFIG_DIR · CODEX_HOME · XDG_* dirs          │
│   ▸ providers: Anthropic sub/API · ChatGPT sub/OpenAI API ·              │
│                GLM Coding Plan · Gemini API                              │
│   ▸ per-attempt headless sessions in worktrees, engine sandboxes         │
│                                                                          │
│  ~/.mec: db · lock · engines/<engine>/<slot>/ · repos/ · work/ ·         │
│          journal/ · prompts/ · policy.yaml                               │
└──────────────────────────────────────────────────────────────────────────┘
        │ (only on explicit confirmation)
        ▸ git push · gh pr create / merge  →  GitHub
        │ (only through the engines, with the slot's own credential)
        ▸ api.anthropic.com · chatgpt.com · api.z.ai · generativelanguage.googleapis.com
```

Authority lives in the MEC core. Engines are executors. The browser is a view. The only path to GitHub is the guarded outbox; the only path to a model provider is an engine process running with its slot's credential.

---

## 4. Repository and module layout

Fresh monorepo (TypeScript, pnpm, Biome, Vitest — the v1 toolchain):

```
apps/desktop        launcher (mec), server, static web host, status/doctor/slot CLI
apps/web            chat-first workbench UI (incl. terminal cards via xterm.js)
packages/contracts  Zod schemas: chat, mandate, plan, role, report, question, events, receipts, slots
packages/domain     pure rules: state machines, stages, graph validation, caps, receipts, holds,
                    slot states, in-memory repositories for tests (same order and rollback as the store)
packages/engines    adapter interface + claude/ (+ codex/, opencode/ later)
packages/slots      credential homes, login orchestration (node-pty), keystore courier,
                    probes, provider profiles, usage models, redaction patterns
packages/mec-tools  platform tools and read resources as an MCP server; permission-bridge contract
packages/runtime    supervisor, env allowlist + shims + gitconfig, journal, worktrees, checks,
                    isolation profiles, background-work caps
packages/effects    the effects queue, passes, health board
packages/git        argv-only git: clone cache, worktrees, merges, diffs
packages/policy     guardrail classes, policy file loading, version hash, change effects
packages/prompts    bundle compiler, defaults, provenance, revisions, pinning
packages/testkit    fake CLIs (one per engine), fixture repos, scripted agents, fault rig,
                    provider error fixtures (429 shapes, rate-limit events), model-surface checks
```

Domain state transitions stay in pure, tested functions; storage and engines sit behind narrow interfaces. One process owns SQLite and holds a lock file on `~/.mec` so a second instance refuses to start. Each caller receives only its role's view of the core (`CoreForChat`, `CoreForMetaAgent`, `CoreForPerson`, `CoreForEngines`, `CoreForScheduler`, `CoreForSettings`); commands are imperative and may be refused with a fixed error code, facts reported by adapters are past tense. Native modules (`node-pty` for terminal cards, `better-sqlite3`) must ship prebuilt binaries for macOS and Linux on arm64 and x64, because `npx` installs must not require a compiler (§21).

---

## 5. Engines, providers, credentials and slots

This section replaces v4 §5. It is the authentication design for all engines.

### 5.1 Vocabulary

- **Engine** — an installed coding-agent CLI MEC drives headlessly: Claude Code, Codex CLI, OpenCode (V2). MEC runs the binary the user installed, unmodified.
- **Provider** — who serves the model: Anthropic (subscription or API), OpenAI (ChatGPT subscription or API), Z.ai (GLM Coding Plan), Google (Gemini API). An engine reaches a provider only through the engine's own documented configuration.
- **Credential** — either an **OAuth session** that a vendor CLI created and holds in its own store, or an **API key** the user owns.
- **Provider profile** — the non-secret settings that point an engine at a provider: base URLs, region, model map, default model, reasoning effort.
- **Slot** — engine + provider + credential + provider profile + an isolated home directory + MEC metadata. Slots are the unit of login, health, quota, pinning and scheduling. A machine can hold several slots per engine (two Claude subscriptions; one GLM and one Gemini slot on OpenCode).

### 5.2 Launch matrix

| Slot kind | Engine | Provider | Credential | Login path | Local health probe | Usage signal |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-sub` | Claude Code | Claude Pro/Max/Team/Enterprise | OAuth session, vendor-held | `claude auth login` in a terminal card: Anthropic's browser flow with the code-paste fallback | `claude auth status` (JSON; exit 0/1) | `rate_limit_event` in stream-json |
| `claude-api` | Claude Code | Anthropic API | API key | paste once | `claude auth status` + zero-token `GET /v1/models` | 429 / retry-after; `total_cost_usd` in `result` |
| `claude-glm` | Claude Code | GLM Coding Plan, Anthropic-compatible endpoint | API key (plan key) | paste once | opt-in minimal request | 429 and the plan's credit windows |
| `codex-sub` | Codex CLI | ChatGPT Free/Go/Plus/Pro/Business/Enterprise | OAuth session, vendor-held | `codex login` (browser, loopback 127.0.0.1:1455) or `codex login --device-auth` in a terminal card | `codex login status` (exit 0/1) | `account/rateLimits/read` and `account/rateLimits/updated` on the app-server |
| `codex-api` | Codex CLI | OpenAI API | API key | paste once (`codex login --with-api-key` reads stdin) | `codex login status` + zero-token `GET /v1/models` | 429 / retry-after |
| `opencode-glm` | OpenCode V2 | GLM Coding Plan (`zai-coding-plan` provider) | API key (plan key) | paste once | `opencode auth list --format json` + opt-in minimal request | 429 and the plan's credit windows |
| `opencode-gemini` | OpenCode V2 | Google Gemini API (`google` provider) | API key | paste once | `opencode auth list --format json` + zero-token `GET /v1beta/models` | 429 `RESOURCE_EXHAUSTED` with `RetryInfo` |

Not supported, by design: OpenCode (or any non-Anthropic client) on a Claude subscription — Anthropic prohibits it and OpenCode removed the login in 1.3.0 (22 March 2026); OpenCode's `claude-agent` provider, which shells out to an installed Claude Code, is not used either because MEC drives Claude Code itself; Codex on anything but OpenAI-compatible `responses` providers; any slot whose credential MEC would have to hold as an OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, Codex access tokens).

`claude-glm` exists because Z.ai documents an Anthropic-compatible endpoint for Claude Code; it is a cheap way to run the same engine on a different provider. Z.ai also documents Codex (`model_provider = "ZAI"`, `base_url = https://api.z.ai/api/v1`, `wire_api = "responses"`); a `codex-glm` kind follows the same keystore mechanism and is a later addition.

### 5.3 Credential homes

Every slot has an isolated home that the engine itself treats as "its" configuration directory. MEC creates the directory, sets the engine's environment variable to it for every process it launches for that slot, and never writes into the user's default home.

| Engine | Home variable | What lives there | Caveats |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR=~/.mec/engines/claude/<slot>` | `settings.json` (incl. the `env` block MEC uses for provider profiles), `.credentials.json` on Linux and as the macOS fallback, the relocated app state file (onboarding state, per-project trust), `projects/` session transcripts, plugins | On macOS the Keychain entry is keyed to the config directory (official docs), so two slots hold two separate logins. A Claude Console "sign in without an API key" profile lives in `~/.config/anthropic`, outside the directory, and is therefore **not** slot-isolated; MEC refuses that login type for slots. Setting `CLAUDE_CONFIG_DIR` explicitly to the default `~/.claude` selects a *different* Keychain item than leaving it unset (issue #92252), so a linked default home runs with the variable unset. |
| Codex CLI | `CODEX_HOME=~/.mec/engines/codex/<slot>` (must exist before launch) | `auth.json` (0600; ChatGPT tokens or API key; `cli_auth_credentials_store` defaults to `file`, and the optional keyring entry is keyed per home), `config.toml` (providers, MCP servers, sandbox and approval defaults), `sessions/` rollouts, SQLite state | One home = one login. Sessions are tied to the home and scoped to the signed-in account. |
| OpenCode V2 | `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` → `~/.mec/engines/opencode/<slot>/{data,config,state,cache}`; `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG` → the slot's config | credentials and sessions in `opencode.db` (SQLite, 0600) under the data dir; the slot `opencode.json` under the config dir | OpenCode merges a project-level `opencode.json` from the repository and registers a background service under `XDG_STATE_HOME`; MEC runs each slot `--standalone`/`--stdio` (never `--service`) and neutralises project config (§8). V1 (`opencode-ai` 1.x) stores `auth.json` and speaks a different API; a V1 binary degrades the slot to `engine_unsupported` with upgrade instructions. |

Slot 0 ("link existing") may point at the engine's default home instead (`~/.claude` with the variable unset, `~/.codex`, the user's XDG dirs). It is the zero-login quick start, with three consequences the UI states plainly: MEC's sessions appear in the user's own history, the user's own hooks/plugins/settings apply to MEC attempts, and interactive use shares the same quota. Dedicated slots are the recommendation after the first try.

### 5.4 Custody rule — two classes of credential

1. **Vendor-held OAuth sessions** (Claude subscription, ChatGPT subscription). MEC never reads, copies, exports, refreshes, probes with, or stores them. Sign-in always completes through the vendor's own flow, run by the vendor's unmodified CLI inside the slot home. Health comes only from the CLI's own status command and from the engine's event stream. No undocumented endpoints are ever called with these tokens (the usage endpoints third-party monitors use are off-limits by design).
2. **User-owned API keys** (Gemini, GLM, Anthropic API, OpenAI API). The user pastes a key once into the Slots panel. MEC writes it to the **slot keystore** — `~/.mec/engines/<engine>/<slot>/keys/<provider>.key`, mode 0600 — and to nothing else. The database keeps a **fingerprint** (provider, last four characters, SHA-256 of the key with a per-install salt) for display and exact-match redaction. MEC reads the keystore in exactly three code paths: launching an engine process for that slot (to pass the key by the engine's documented mechanism, §5.7), the zero-token validity probe, and the redaction filter. The key never enters events, journals, logs, chat transcripts, scorecards, diagnostics bundles or backups.

Corollary stated honestly: an agent can read the credential it runs with (the vendor store is readable by the engine, and a shell tool runs as the same OS user). Isolation exists *between slots* and *between agents and MEC's state*, not between an agent and its own key. Engine sandboxes narrow this further where available (§8); for isolation beyond that, a dedicated OS user is the recommendation.

### 5.5 Slot lifecycle

```
draft ─create home─► home_ready ─login/paste─► login_pending ─probe ok─► healthy
                                                     │ cancel/timeout        │
                                                     └──────────────────────► degraded
healthy ⇄ degraded { auth_expired · key_rejected · quota_exhausted(resets_at?) ·
                     engine_missing · engine_unsupported(version) · provider_unreachable }
healthy/degraded ─user─► retired   (home kept on disk until the user deletes it)
```

Only `healthy` slots receive work. Every transition is an event with its evidence (probe output, classified error). `quota_exhausted` carries the reported reset time when the provider gave one and `unknown` otherwise — never a guess. `auth_expired` and `key_rejected` carry the exact action that clears them (sign in again; replace key).

### 5.6 Login orchestration (OAuth engines)

- **Terminal card.** The workbench opens a card backed by a `node-pty` session (xterm.js in the browser) running the vendor's login command with the slot's environment: `claude auth login` for Claude Code (the login URL and the code-paste prompt appear in the card; MEC opens the URL in the user's default browser with `open`/`xdg-open` when the CLI prints it), `codex login` for Codex (loopback callback on 127.0.0.1:1455, falling back to 1457; the device-code variant for machines where the browser cannot reach the callback — a beta that the user enables in ChatGPT security settings). The login stream is **never journaled or persisted**; MEC records only the exit code and the subsequent probe result.
- **Assisted overlays.** Above the raw terminal, MEC adds buttons it can justify from fixtures per engine version: *Open sign-in page*, *Copy code*, *Paste code*. For Codex, the app-server's `account/login/start` method (`chatgpt`, `chatgptDeviceCode`) can drive the same flow without a terminal; it is used when the installed version proves it. When a fixture does not match the installed version, the overlay disappears and the raw terminal remains; the baseline always works.
- **Serialised.** One login at a time per machine, queued in the UI. Vendor CLIs use fixed loopback callback ports, so two concurrent logins would collide.
- **Bounded.** A login times out after ten minutes; cancel kills the process group; the slot returns to `home_ready` with nothing half-written by MEC (vendor stores are the vendor's business).
- **Verified.** After exit, MEC runs the engine's local status command inside the slot env and records the non-secret identity it returns (Claude: `authMethod`, `email`, `orgName`, `subscriptionType`, `configDirectory`; Codex: the mode its status line names) as slot metadata.
- **Re-login.** When an attempt is classified `auth_required`, the inbox shows one card — "Slot max-1: login expired — sign in again" — which opens the same terminal card. Parked attempts resume automatically once the probe reports healthy; nothing is switched silently.
- **Expiry foresight.** Claude Code warns three days before a subscription login expires and reports an expired login in its status output; MEC surfaces the same warning on the slot card. Codex and OpenCode have no advertised expiry warning; MEC relies on classification (§5.9).

### 5.7 API-key courier and provider profiles

The Slots panel form: provider → key (masked field, never echoed) → region/endpoint → default model and model map → *Validate* (zero-token probe where the provider offers one) → *Save*. The key lands in the slot keystore and reaches the engine through the engine's own mechanism:

| Slot kind | How the engine receives the key | Provider profile written by MEC (non-secret) |
| --- | --- | --- |
| `claude-api` | `ANTHROPIC_API_KEY` injected into the process env at launch (in `-p` mode an API key present in the environment is always used) | `model`, optional `ANTHROPIC_DEFAULT_*_MODEL` aliases |
| `claude-glm` | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` in the slot's `settings.json` `env` block (file mode 0600, inside the slot home), exactly as Z.ai's own installer does | model map (`ANTHROPIC_DEFAULT_OPUS_MODEL`, `…_SONNET_MODEL` → `glm-5.3[1m]`, `…_HAIKU_MODEL` → `glm-5.3-flash[1m]`), `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `API_TIMEOUT_MS` |
| `codex-api` | `codex login --with-api-key` with the key on stdin, stored by Codex in the slot's `auth.json`; `CODEX_API_KEY` in env is the per-invocation alternative | `config.toml`: model, `model_reasoning_effort`, sandbox and approval defaults |
| `opencode-glm` | `providers.zai-coding-plan.settings.apiKey: "{file:…/keys/zai.key}"` in the slot's `opencode.json` (V2 `{file:}` substitution), or `ZHIPU_API_KEY` in env at launch | provider entry, default model `zai-coding-plan/glm-5.3`, permissions |
| `opencode-gemini` | `providers.google.settings.apiKey: "{file:…/keys/google.key}"`, or `GOOGLE_GENERATIVE_AI_API_KEY` in env | provider entry, default model (e.g. `google/gemini-3.8-flash`), permissions |

Rules: the form is the only way a key enters MEC; a key pasted into chat is redacted before durability and answered with a pointer to the Slots panel; the agent-guided setup never sees a key (§21); rotating a key replaces the keystore file and re-probes; deleting a slot shreds its keystore; `mec backup`, `mec doctor` and retention never touch `engines/*/keys/`, `.credentials.json`, `auth.json`, `opencode.db` or Keychain items. The Gemini form warns that the free tier's prompts may be used to improve Google's products and recommends a billing-linked project for private code; a repository marked private in policy refuses free-tier Gemini slots.

### 5.8 Health probes

| Probe | Engine/provider | Cost | Cadence |
| --- | --- | --- | --- |
| `claude auth status` (JSON: `loggedIn`, `authMethod`, `email`, `orgName`, `subscriptionType`, `configDirectory`; may refresh the token — the vendor's own call) | Claude Code | local | every few minutes; before scheduling; after login |
| `codex login status` (text on stderr; exit 0/1; reads stored credentials only) | Codex | local | same |
| `opencode auth list --format json` + provider entry present | OpenCode | local | same |
| `<engine> --version` + capability probe (§9) | all | local | on slot creation, after any engine upgrade, at app start |
| `GET /v1/models` (Anthropic, OpenAI), `GET /v1beta/models` (Gemini, `x-goog-api-key`) with the slot's key | API-key slots | network, zero tokens | on *Validate*, after `key_rejected`, before resuming parked work |
| GLM validity | GLM slots | network; no free endpoint is documented, so a minimal request on `glm-5.3-flash`, opt-in | on *Validate* only |

Never: periodic network probes against quota-metered plans (a GLM probe consumes plan credits), any probe that needs a vendor OAuth token outside the vendor CLI, any probe that burns subscription usage.

### 5.9 Usage models and quota signals

Each provider gets a small, explicit usage model. Readings come from engine streams and provider error bodies; MEC never estimates silently.

| Provider | Windows | Signal MEC consumes | MEC behaviour |
| --- | --- | --- | --- |
| Claude subscription | five-hour window, seven-day windows (all models; Opus and Sonnet families), optional overage | `rate_limit_event` in Claude Code's stream-json: `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`), `status` (`allowed`, `allowed_warning`, `rejected`), `utilization` (present once a threshold is crossed), `resetsAt` (units verified on install) | `allowed_warning` → slot card shows utilisation and reset time, scheduler prefers other healthy slots for new attempts; `rejected` → park `quota_wait` until `resetsAt`, then re-probe. `CLAUDE_CODE_RETRY_WATCHDOG` is not used: MEC parks instead of letting the engine spin |
| ChatGPT subscription | five-hour window (plan-dependent; Pro is documented without one) and weekly limits; credits | app-server `account/rateLimits/read` and `account/rateLimits/updated`: `primary`/`secondary` windows with `usedPercent`, `windowDurationMins`, `resetsAt` (unix seconds), `planType`, `credits`; the limit error text ("You've hit your usage limit… try again after …") as `turn/completed` status `failed` | same as above; unknown reset → `quota_wait` with manual resume and a reminder |
| GLM Coding Plan | credits per five-hour window and per week by tier (Lite/Pro/Max: 2,000/12,000/28,000 per five hours; 10,000/60,000/140,000 per week; off-peak at half price); concurrency by tier | HTTP 429 and the plan's error text; the dashboard is the only full reading | park with reset `unknown` (the exhaustion response is not documented); resume on a healthy opt-in probe or user action; default concurrency 1 for Lite, 2 for Pro/Max |
| Gemini API | requests/min, tokens/min, requests/day per tier, **per Google Cloud project** (not per key); daily reset at midnight Pacific; rolling spend caps | HTTP 429 `RESOURCE_EXHAUSTED` with `QuotaFailure.violations[].quotaId` (per-minute vs per-day) and `RetryInfo.retryDelay` | per-minute: retry after `retryDelay`; per-day: park until the daily reset |
| Anthropic / OpenAI API keys | organisation rate limits and spend | 429 with retry-after headers; cost reported by the engine | retry with backoff; spend caps per slot and per work item in the policy file (§13) |

Missing readings stay *unknown* — the slot card says "no reading yet", never 0 %. Adapters never switch models or providers to conceal a failure; a fallback model is used only when the policy names one for that slot.

### 5.10 Parking, resume, switch and failover

| Stage | Behaviour |
| --- | --- |
| Detect | Adapters classify usage-limit, auth and provider errors from the engine stream with per-engine fixtures; the local probe refreshes auth health every few minutes. |
| Park | Affected attempts move to `quota_wait`, `auth_required` or `provider_down`. Worktrees, branches and transcripts are preserved. |
| Inform | Chat and the slot card say which slot hit which limit, with the reset time when one was reported: "max-1: five-hour window, resets 18:40" or "glm-1: plan window exhausted, reset unknown". The meta agent gets the same facts as a note and plans around them. |
| Resume | A reported reset time makes parked attempts eligible automatically once the probe confirms health. Unknown resets resume on the next healthy probe or on an explicit user action. |
| Switch | An explicit **Switch slot** action moves affected work to another healthy slot — same engine or a different one. MEC re-probes the target, records a handoff (from-slot, to-slot, reason, time) on each affected work item, and continues as a **new attempt on the same worktree** with an engine-neutral handoff pack (plan, diff-so-far, transcript summary, open questions, holds). Engine sessions are never resumed across slots or engines. |

**Auto-failover is opt-in**, configured as explicit slot pairs in the policy file ("if `max-1` parks, continue on `max-2` without asking"; pairs may cross engines). Default is explicit. There is no silent account switching; every switch is a recorded event.

### 5.11 Vendor terms — hard rules

Verified against Anthropic's legal and compliance page for Claude Code (3 Nov 2026), its February 2026 clarification, and OpenAI's public statements:

1. **Unmodified binaries, documented interfaces.** MEC runs the vendor CLI the user installed, as published, through its documented headless mode. MEC does not embed, patch, proxy or re-implement a client, does not alter client telemetry or headers, and does not use the Claude Agent SDK with subscription credentials (Anthropic requires API keys for SDK-based products).
2. **The user's own credentials, their own flow.** Each slot is the user's own account; sign-in completes inside the vendor's flow; MEC never collects, stores or intermediates Claude.ai or ChatGPT credentials or session tokens. This is exactly the condition under which Anthropic permits an end user to sign in to the unmodified Claude Code binary with their own subscription inside a platform that hosts it.
3. **No cross-vendor subscription use.** A Claude subscription is used only through Claude Code; OpenCode and Codex slots use API keys or their own vendor's subscription. Anthropic's February 2026 clarification bans subscription OAuth in any other product, and OpenCode dropped the option.
4. **Ordinary, individual usage.** Anthropic states that advertised Pro/Max limits assume ordinary individual use. MEC's caps default low, the scheduler paces by reported utilisation, and the slot card shows the utilisation the engine reports. For sustained parallel workloads, API-key slots (`claude-api`, `codex-api`) are the first-class, pay-as-you-go alternative and the UI says so when a subscription slot spends most of its time parked. Obtaining written confirmation from Anthropic that headless orchestration of the unmodified CLI under a personal subscription is within "ordinary individual usage" is an open item (§27); until then defaults stay conservative.
5. **One human, one subscription per slot.** No pooling, no sharing, no serving other people's requests from a subscription slot — the single-user scope makes this structural. GLM's plan terms forbid account sharing too.

OpenAI has published no comparable restriction for Codex CLI in third-party harnesses (its Codex lead publicly endorsed such use in February 2026); MEC applies rules 1, 2 and 5 to Codex anyway.

### 5.12 Agent environment construction

Every engine process gets an environment MEC builds from scratch:

- **Inherited allowlist**: `PATH` (with the attempt's shim directory first, §8), `HOME`, `USER`, `LANG`/`LC_*`, `TERM`, `TMPDIR`, `SSH_AUTH_SOCK`, proxy variables, `XDG_RUNTIME_DIR`. Nothing else from the user's shell.
- **Scrubbed always**: every variable whose name contains `KEY`, `PASSWORD`, `SECRET` or `TOKEN`; `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, `GEMINI_*`, `GOOGLE_*`, `ZAI_*`, `ZHIPU_*`, `OPENCODE_*`, `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, `GH_TOKEN`, `GITHUB_TOKEN`. A subscription slot must never inherit an `ANTHROPIC_API_KEY` from the user's shell, because Claude Code's `-p` mode would silently use it.
- **Slot layer**: the home variable(s) of §5.3; provider variables from the keystore per §5.7; engine hygiene variables (for Claude Code: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1` by policy, `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`, `CLAUDE_CODE_PROJECT_DIR_NAME=<attempt>` to keep transcripts per attempt, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; for OpenCode: `OPENCODE_DISABLE_PROJECT_CONFIG=1` unless the repository is marked trusted).
- **Attempt layer**: `MEC_ATTEMPT_ID`, `MEC_WORKTREE`, `MEC_BASE_SHA`, `MEC_TASK`, `MEC_TOOLS_URL`, `MEC_TOOLS_TOKEN` (attempt-scoped, §6), `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT=0`, the attempt's port range and test-database namespace. Each attempt variable is registered with a description; the prompt bundle's environment section lists the same variables with their values, so agents read what shell commands read.

---

## 6. The meta agent

The meta agent is a **platform role, not a vendor feature**: a prompt bundle + validated platform tools + MEC-owned state, executed on a slot of the user's choice. Swapping slots or engines preserves the role; MEC holds the canonical transcript.

### Separation of roles

The meta agent admits, plans, routes, monitors and reports. It does not implement, does not inspect code beyond its read-only planning pass, does not read specialist transcripts to invent plans, and does not solve blockers itself. The plan it proposes is a decomposition, not a rewrite of the request: **the original message travels verbatim with every task brief** (with a read pointer when long), the meta agent's routing note is bounded (50 words) and labelled as context, and specialists recheck scope against the original — acceptance by the meta agent is not proof that the direction is settled. Standing rules reach specialists through their bundles, not through the brief.

### Turn model

MEC owns the conversation. The meta agent runs in **event-driven turns** — it is woken with a reason, decides, and stops. Inputs come in two classes:

- **Wakes** (start a turn): a user message · a specialist report `ready`, `blocked`, `failed` or `dropped` · a structured question from a specialist · a confirmation resolved · work parked with no automatic resolution · an integration conflict that needs a plan change · a slot degraded that affects a live plan · a timer the meta agent asked for.
- **Notes** (appended to the next turn, never a wake): `progress` and `waiting` reports · attempt started · checks passed on a task not yet ready · slot health improved · settings or prompts saved · anything the meta agent did itself (it never receives a notice of its own action).

Each turn: MEC compiles the context (chat history, work-item stages, pending confirmations, holds, budgets, slot health and utilisation, the notes since the last turn) → invokes the engine headless with the platform tool set → tool calls execute against the core (validated) → the final structured result is recorded and, when useful, spoken to the user. **The meta agent never waits**: it has no shell, no sleep, no polling; it ends the turn when nothing remains. After its session's context is compacted or reconstructed, it re-reads work-item summaries through the read resources before acting, to avoid duplicate work. Between turns nothing burns quota; within a slot, sessions resume natively (Claude Code `--resume <session-id>`, Codex `exec resume`/`thread/resume`, OpenCode `--session`) when the adapter has proved it for the installed version, otherwise MEC reconstructs context from its own transcript.

### The platform tool set (the meta agent's only write channel)

```
acknowledge(message_id, text)                   → one sentence, idempotent per message
propose_plan(work_item, tasks[], deps[])        → validated; repairs returned
spawn_agent(task, role, slot_class or slot)     → bounded by caps, mandate and budget
route(message_id, decision, target?, note?)     → attach to live work · new work · stop · conversation
request_confirmation(operation, evidence)       → creates a card; never self-approves
ask_user(question, for_message_id?)             → one concrete question; awaited or async
report_result(work_item, summary, artifacts)    → spoken to the user
read(resource, cursor?)                         → bounded, role-scoped pages
stop_agent / cancel_task                        → scoped cancellation
```

Batch semantics: a call that carries several items (several route decisions, several spawns) processes each independently and returns one result per item; a refused item does not stop the others. An accept is idempotent by message id.

### Transport: `mec-tools`

Platform tools and read resources reach every engine the same way: MEC runs **one MCP server** (streamable HTTP on `127.0.0.1`, random port) and hands each attempt a URL and an **attempt-scoped bearer token** that encodes the attempt and its generation. Each engine is pointed at it through its documented MCP configuration — Claude Code via `--mcp-config` (HTTP server with headers) plus `--strict-mcp-config`; Codex via `[mcp_servers.mec]` with `url` and `bearer_token_env_var` in the slot's `config.toml` (or a `-c` override per launch); OpenCode via `mcp.servers.mec` (`type: "remote"`, `headers`, `oauth: false`) in the slot's `opencode.json`. The server resolves the token to (attempt, role, generation) and exposes only that role's tools; a stale generation gets an empty tool set and a clear error — the journal's generation fencing applies to tool calls too. A stdio shim exists for an engine version that cannot speak HTTP MCP.

**Read resources** are paged and bounded (a text page 4,000 characters by default and 8,000 at most; a list 20 items by default and 50 at most; `next` cursors): `work_items`, `work_item/<id>`, `task/<id>`, `attempt/<id>` with `/report`, `/diff`, `/checks`, `/findings`, `/transcript` (pages), `slots`, `confirmations`, `settings`, `prompts/<revision>`. Every id a page shows is readable through one of these, and nothing shows an id that nothing reads by. A specialist's token reads only its own task, attempt, the messages that reached it and the prompt revisions it ran under; the meta agent reads everything but transcripts in full (summaries and report pages, not step-by-step tool activity).

Deterministic code validates every call (graph validity, caps, mandate scope, budget, slot health, holds). The meta agent can never: widen its own authority, approve a confirmation, edit the policy file or prompt defaults, exceed fan-out, or spawn outside the work item's mandate. Four consecutive invalid proposals from a meta agent turn escalate to the user — the v1 coordinator discipline, kept exactly.

### What the meta agent does not do

It does not implement code itself (specialists do); it does not push, open or merge PRs (guardrails do, after confirmation); it does not run shell commands at all — its Claude Code profile is `--restricted` with file reading and search tools plus `mcp__mec__*` (the equivalent on other engines); it never handles credentials and has no tool that touches slots beyond reading their health; it never asks for keys or tokens in chat.

---

## 7. Specialist registry and ad-hoc roles

### Built-in roster (editable prompt bundles, §16)

| Role | Purpose | Notes |
| --- | --- | --- |
| implementer | code changes in a worktree | the workhorse; runs repo bootstrap + acceptance checks; stops by impact (below) |
| test author | writes/extends tests for a task | shares the task's contract |
| code reviewer | correctness review of a diff | read-only profile; findings bound to SHA; prefers a different slot and, when available, a different provider than the implementer |
| PR reviewer | reviews the integrated change against the plan and the original request | runs on the integration SHA |
| security checker | runs configured scanners + model review for dangerous patterns | findings by severity; blocking per policy |
| integrator | dependency-ordered merges, combined checks | deterministic core + agent for conflict repair |
| repair agent | fixes failures/conflicts with exact evidence | gets failures, both sides of conflicts |
| release agent | prepares PR body, migration notes, decision log; checks for a human's duplicate PR | never merges |

**Scope discipline for writing roles** (from dsh-superagent's scope section, adapted): a focused change goes through implementation, relevant checks and self-review without asking; file counts, failing tests and layout defects are reasons to fix, not to stop; there is no fixed LOC allowance. Work stops with a `blocked` report when it would break existing caller expectations, change module responsibilities, need a coordinated redesign across independent modules, require a product or design decision the request did not settle, or when feasible approaches repeatedly fail to progress — naming the specific interface, caller impact or missing prerequisite. Partial work is preserved as an explicitly incomplete draft (branch, checks that ran, what remains); nothing is fabricated to have a deliverable; a stop by the user holds until the user lifts it.

**Provider diversity is cheap now.** With OpenCode slots on GLM or Gemini, a reviewer can run on a different model family than the implementer for a fraction of a subscription's budget. The registry records a *preferred slot class* per role (`same engine, different slot` / `different provider` / `any healthy`); the scheduler honours it when a healthy slot exists and records when it could not.

### Ad-hoc roles (AgentSpec, simplified)

The meta agent may design a task-specific specialist (a migration author, a compatibility reviewer) as a typed role definition: instructions, input/output schema, allowed tools, context policy, checks, budget. The compiler validates schema, tool registration, adapter support and policy ceilings; invalid proposals return actionable errors with bounded repair. Compiled roles are immutable and versioned; running attempts stay pinned.

### Agent graph

Every agent instance records parent, role revision, engine, slot, provider, worktree, budget and outcome. The UI shows the live graph: parentage, handoffs, waiting states, findings — with per-agent transcripts one click down.

---

## 8. Local agent runtime

The runtime supervises processes and workspaces on the local machine.

1. **Processes**: argv arrays only (never shell strings); one process group per attempt; stop = SIGTERM to the group → escalate → confirm gone. Ownership is (attempt, generation), not PID. OpenCode is the one exception in shape: one `opencode serve --stdio` process per slot, supervised like an attempt group, with one session per attempt inside it.
2. **Environment**: built per §5.12 — allowlist, scrub, slot layer, attempt layer. Engine credentials reach engines only through slot homes and keystores; git credentials reach git only through the user's ambient credential helpers; agents never see MEC's database, policy or prompt store as writable paths.
3. **Command shims and git configuration** (dsh-superagent's execution hygiene): each attempt gets `<worktree>/.mec/bin` first on `PATH`, containing shims for **blocked commands** that fail by name with a one-line reason — `mec`, `claude`, `codex`, `opencode` (an agent must not start other agents or consume other slots), and the user's personal CLIs listed in policy — and wrappers that remove the shim directory from `PATH` before running their target. `GIT_CONFIG_GLOBAL` points at a MEC-written `<worktree>/.mec/gitconfig` (`GIT_CONFIG_NOSYSTEM=1`): commit identity from policy, the user's credential helper pinned for the repository's host, no terminal prompts, no personal settings such as proxies. A shim or gitconfig file MEC did not write (hash mismatch) refuses the attempt; a worktree whose repository configuration adds credentials or `http.*.extraheader` fails the attempt with the setting named. Honest note: shims and environment are defaults, not a security boundary — a process can run a binary by absolute path; the OS-level boundary is the engine sandbox below.
4. **Isolation profiles** per engine, applied to every attempt:
   - *Claude Code*: a per-attempt settings JSON passed with `--settings` (a trusted scope the repository cannot override) that enables the Bash sandbox (`sandbox.enabled`, `allowUnsandboxedCommands: false`, `failIfUnavailable` per policy), limits writes to the worktree and the attempt's temp dir (`sandbox.filesystem.allowWrite`), denies reads of `~/.mec` outside the worktree, other slot homes, `~/.ssh`, `~/.aws`, `~/.config/gh` and the slot's own credential files (`sandbox.filesystem.denyRead`, `sandbox.credentials.files`), and allows network only to the registries the repo's bootstrap profile names (`sandbox.network.allowedDomains`, `strictAllowlist`), plus `disableAllHooks`. `--setting-sources user` keeps the repository's `.claude/settings.json` (hooks, `env`, `apiKeyHelper`) out; `--strict-mcp-config` keeps its `.mcp.json` out; `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` is available per policy for repositories the user marks untrusted. Read-only roles add `--restricted` and `--permission-prompts none`. On Linux the sandbox needs `bubblewrap` and `socat`; `mec doctor` checks and the policy decides whether a missing sandbox fails the attempt or degrades to permission prompts.
   - *Codex*: app-server threads with `sandbox: workspace-write` on the worktree and `approvalPolicy` routed to the permission bridge (§9); worktrees are never marked trusted, so a repository's `.codex/` config, hooks and MCP servers never load (Codex loads them for trusted projects only); AGENTS.md is read as instructions, capped by `project_doc_max_bytes`.
   - *OpenCode V2*: no OS sandbox; the slot's `permissions` list allows edits inside the worktree, denies `external_directory`, `webfetch` and `websearch` by default, and routes `shell` outside the bootstrap/check profiles to the bridge as `ask`; `OPENCODE_DISABLE_PROJECT_CONFIG=1` keeps a cloned repository's `opencode.json`, `.opencode/plugins/*.ts`, commands and MCP servers from loading (the repository's instructions reach the agent through the bundle's conventions layer instead); a repository the user marks trusted may load project config, in which case the slot config overrides `mcp.servers` and `plugins` by name.
   Owned paths in briefs are coordination instructions, not a sandbox — isolation comes from process env, worktree scoping and the engines' own restricted modes.
5. **Background work**: inside an attempt the engine's own background-job mechanism applies (Claude Code's background tasks; Codex and OpenCode turn timeouts). MEC bounds it per policy — Claude Code `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, a wall-clock cap per attempt (default 30 minutes of background work after the last turn) — and kills the process group at attempt end. A job a specialist leaves running for the user to try (a dev server named in a `ready` report) lives until the attempt ends and is listed on the task card with its port.
6. **Journal**: every engine event is appended to `~/.mec/journal/<attempt>/events.jsonl` and fsynced before it touches the database; ack cursor and replay survive crashes (v1 port). Sequence checks, dedupe and generation fencing behave as in v1 — now guarding against duplicate work after app crashes and restarts, not remote runners. Redaction (pattern-based for every provider's key format, exact-match for keystore fingerprints) runs before the append.
7. **Wake-ups**: laptop sleep, engine death and node exits are all classified; the workspace is always preserved and a supported resume is offered. A resumed or retried attempt starts with a **recovery note**: check the worktree, git history and the outbox record before repeating any outside action.
8. **Ports and services**: unique port ranges per attempt; test databases namespaced per attempt.

---

## 9. Agent adapters

One contract; each adapter reports capabilities honestly and falls back to the terminal-free path when a capability is missing. Every flag below is probed on the installed version before use; unproven flags are reported unsupported (v1 behaviour).

| Engine | Headless interface | Permission bridge | Resume | Isolation | Verify on install |
| --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.31x (L2) | `claude -p --verbose --output-format stream-json --input-format stream-json --session-id <uuid> --settings <attempt.json> --setting-sources user --mcp-config <json> --strict-mcp-config --allowedTools … --disallowedTools … --max-turns N --model <alias>`; `--max-budget-usd` on API-key slots (a client-side estimate); read-only roles add `--restricted --permission-prompts none`; `--bare` is **not** used (it ignores subscription logins and CLAUDE.md and is slated to become the `-p` default — the probe must detect that change and pass the explicit opt-out) | `--permission-prompt-tool mcp__mec__confirm`: the engine asks MEC's tool; MEC creates a confirmation card and answers allow/deny by policy or user; `permission_denials` in `result` are recorded | `--resume <session-id>` in the same slot home | sandbox profile (§8); env allowlist | flag set; `system/init` fields (`apiKeySource`, `claude_code_version`, `permissionMode`, `mcp_servers`); `rate_limit_event` shape and `resetsAt` units; `result` subtypes (`success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`) and `terminal_reason`; `auth status` JSON fields; Keychain-per-directory on macOS; `--bare` default status |
| Codex 0.166.x (L7) | `codex app-server` (JSON-RPC over stdio: `initialize`/`initialized`, `thread/start {cwd, model, approvalPolicy, sandbox, config}`, `turn/start`, `turn/steer`, `turn/interrupt`, `turn/completed` with status `completed`, `interrupted` or `failed`, `thread/tokenUsage/updated`); `codex exec --json --sandbox read-only` only for roles that need no approvals, because `exec` hard-codes `approval_policy = never` and auto-rejects every approval | app-server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput` answered `accept`, `acceptForSession`, `decline` or `cancel` by policy or card | `thread/resume` / `codex exec resume <id>` in the same `CODEX_HOME` | `sandbox: workspace-write`; no project trust; env allowlist | protocol types generated with `codex app-server generate-ts` for the installed version; approval method names; `account/rateLimits/*` fields; login callback port; device-code availability; `wire_api` (`responses` only) for third-party providers |
| OpenCode V2 2.2.x (L8) | `opencode serve --hostname 127.0.0.1 --port 0 --stdio` per slot with a MEC-generated `OPENCODE_PASSWORD` (HTTP Basic, user `opencode`); `POST /api/session {location: {directory}, agent, model}`, `POST /api/session/:id/prompt`, `POST /api/session/:id/interrupt`, `GET /api/event` (SSE: `permission.asked`, `session.step.*` with cost and tokens, `session.idle`, `session.usage.updated`); `opencode run --format json` only for roles that need no approvals (without `--auto`, `run` rejects every permission request) | `permission.asked` events answered through `POST /api/session/:id/permission/:requestID/reply` with `decision` set to `once`, `always` or `reject` and an optional `message` | server session id in the same data dir (`--session` for `run`) | slot `permissions` list; `OPENCODE_DISABLE_PROJECT_CONFIG=1`; env allowlist | V2 vs V1 binary; `mcp.servers` schema and `{file:}` substitution; provider ids (`google`, `zai-coding-plan`); XDG honouring; `OPENCODE_DISABLE_PROJECT_CONFIG` gating all project discovery (source-inferred); release cadence is near-daily, so the probe runs on every version change |

Common rules (v1): capability flags advertised separately (structured_stream, questions, tool_approval, interrupt, resume, usage, rate_limit_events, sandbox); native request IDs map to exactly one MEC confirmation; timeouts expire the request and verify whether the tool ran; replayable redacted protocol fixtures per adapter version; upgrades are per-slot, probe-gated, never forced mid-delivery. Every adapter must also implement `classify(error)` → `{quota, auth, provider_down, engine_bug, repo_failure}` with fixtures per provider error shape, and a report mapper that turns the engine's final structured output into a MEC report (§10).

---

## 10. Work model

```
Conversation ──message──► WorkItem(mandate) ──plan──► Tasks(graph) ──attempts──► AgentInstances
```

- **Conversation**: the chat with the user; the primary source. Every message gets a receipt ladder (§12).
- **WorkItem**: one admitted unit of work ("add audit-log viewing", "review PR #12"). Carries a **mandate**: origin message, scope, policy version, budget, expiry. Only three operations change a mandate: admission creates it, the user's stop withdraws it, failed revalidation revokes it. Stopped or expired mandates never resume silently; revalidation happens before every resume. A work item may be **held** by the user ("wait", "hold on"): the hold records its source message and persists across follow-ups, new attempts and restarts until the user lifts it; automated events never lift it; a status question gets an answer without resuming.
- **Plan**: the task graph the meta agent proposes and the deterministic validator checks (cycles, missing deps, unknown checks/roles, path conflicts, budget sums, slot availability for pinned roles). Plans are versioned; changes carry an impact summary (v1's impact diff, ported). A task id in a plan is a key local to its work item; the stored id is canonical. Within one work item, a key reused by a replan is the same task: it keeps its canonical id, history, attempts and status, and status is never reset. A task whose meaning truly changes uses a new key (decision #19).
- **Task**: a node with objective, the original request (verbatim or by read pointer), owned paths, acceptance checks, depends_on, base policy (integration vs contract), max attempts, budget, slot class preference.
- **Attempt**: one agent execution of a task: role revision, engine, slot, provider, worktree, generation, journal, receipts, reports.
- **Report**: what an attempt says about itself, in a closed vocabulary — `progress` (internal; never wakes the meta agent), `waiting` (the turn ended with nothing pending), `ready` (reviewed implementation with the relevant checks passed — not "a PR exists"), `blocked` (cannot proceed; a person must act; names the blocker and what remains), `failed` (the attempt errored), `dropped` (nothing for a person to do: not reproducible, superseded, already done; ends the task without a message unless policy says otherwise). A report may carry a **question**: one concrete question in a structured field, optionally bound to the message that raised it; repeating the same question reuses the open request, a different question replaces it, and a `ready` report or an explicit clear closes it. Waiting-for-a-person is never inferred from free text.

### States (ported, simplified)

| Object | Progression | Parked / failure states |
| --- | --- | --- |
| WorkItem | proposed → admitted → planning → executing → reviewing → integrating → done | blocked (reason); held (by the user); stopped by the user; dropped |
| Task | ready → active → awaiting_review → accepted → integrated | cancelled; blocked (dependency/capacity/confirmation); dropped |
| Attempt | queued → running → work_complete → succeeded / checks_failed | quota_wait; auth_required; provider_down; interrupted; stalled; failed (terminal, from queued or running: it could not run or errored) |
| Confirmation | pending → approved / denied | expired; stale (input changed) |
| Slot | draft → home_ready → login_pending → healthy | degraded (reason); retired |

`work_complete` only means the agent stopped. Checks make it `succeeded` or `checks_failed`. Review makes the task `accepted`. Integration makes it `integrated`. Merged is confirmed by GitHub, never assumed. An idle work item is not a completed one.

### Stages (projection, first match wins)

An open work item has exactly one stage, computed from facts, never stored. The label says whom it waits for and what it needs; the inbox and the chat use these labels, not state codes.

| Stage | Condition | Label |
| --- | --- | --- |
| person / decision | a pending confirmation or an open question | Needs your answer · Needs your approval |
| person / login | a slot the plan needs is `auth_expired` or `key_rejected` and no healthy pinned alternative exists | Sign in again · Replace key |
| person / review | the release agent reported `ready` (branch tested; PR open or prepared) | Ready for review |
| person / blocked | the latest report is `blocked` or `failed` and no user message reached the item since | Blocked · Failed |
| held | the user asked to wait | Held by you |
| waiting / quota | every runnable attempt is parked `quota_wait` and no pair or switch applies | Waiting for quota (resets hh:mm) |
| working / queued | tasks are ready and no slot capacity is free | Queued |
| idle | the latest report is `waiting` and nothing is runnable | Waiting for a trigger |
| working | everything else | Working |

A `person` stage means the item cannot continue without the user. A new user message releases a blocked or failed item to its specialists (through the ownership rules of §12), so it moves to the next matching stage.

---

## 11. Scheduling and concurrency

Deterministic, local, simple:

- **Passes**: one pass at a time, every two seconds and whenever a command asks: due effects first (§17), then the scheduler. A source of work (a user message, a timer, a slot probe) reaches the core through a pass; nothing runs between passes.
- **Caps** (policy file): global active attempts (default 4), per-slot (default 2; GLM Lite 1), per-work-item (default 2), fan-out per parent (3), agent depth (1), repair attempts per task (2), review rounds per task (3). API-key slots add **spend caps** (per attempt, per work item, per day); subscription slots add a **utilisation ceiling** (default: start no new attempt on a slot whose last reported utilisation is above 80 %).
- **Reserved capacity**: the meta agent's slot keeps one concurrency unit reserved so specialists cannot starve planning and reporting; and one extra global slot exists only for **wakes caused by a user's message or status request**, so a person continuing existing work never waits behind new launches. Wakes take the next free slot before any launch.
- **Ordering**: work-item priority (user-pinned first, then age), then dependency readiness. Slots are independent pools; the scheduler picks a healthy slot matching the role's pinning or slot class, preferring the slot with the lowest reported utilisation, then round-robin. Launches run concurrently, so a slow bootstrap delays only its own task.
- **Parking**: quota/auth parking removes the attempt from the pool but keeps the worktree; parked work resumes in place. A stalled attempt (process died, journal silent) reconciles before any replacement starts — one live attempt per task, enforced by a unique index (v1 port).
- **Retry**: a retry ends the current attempt and starts a new one on the same worktree, branch and (when resumable) session, with the inputs that were waiting; a retry is offered only for `person / blocked`, `person / login` and failed deliveries, never as a loop.
- **Budgets**: per attempt and per work item in turns, wall-clock and (for API-key slots) money; reported token usage and cost are recorded when engines report them and never estimated silently. Child agents draw from the parent's remaining budget.
- The meta agent may *recommend* priorities and slots; deterministic code grants every claim.

---

## 12. Chat intake, follow-ups and receipts

1. **Admission.** Each registered repository has its own conversation and work history (decision #10): a message carries its repository, and one repository's live work never routes another's request or reaches its planner turn. A message naming an unknown repository, or referencing work in another repository, is refused before anything is written. A user message is recorded (received) and admitted: it starts a new work item (explicit — chat is always authorised), routes to the live work it references, stops or holds work, or is conversation (context, no authority). Reference binds: "fix the tests in that audit task" routes by explicit reference — a task name, a PR or branch, the acknowledgement it replies to, or a recent change with exactly one matching work item; similarity alone is a new request or conversation, never an attachment. Ambiguity asks the meta agent to confirm routing with the user — cheaply, once.
2. **Acknowledgement.** Every admitted request gets one acknowledgement in chat before substantial work: one sentence that names the object and the intended result ("On it: adding audit-log viewing to the console and the API, with tests"), never a generic "I'll handle it", never an implementation plan. It is idempotent per message id across restarts; a new message in the same work item gets its own; quick questions are answered directly without one.
3. **Ownership of follow-ups.** A message that routes to live work is delivered to the specialist that owns the attempt it concerns; while that specialist owns it, the meta agent may only *stop* on the user's request — not re-route, re-plan or answer. The specialist handles an in-scope request (and acknowledges it), or **hands it back** once with a one-sentence reason when it is beyond its task or belongs elsewhere; the meta agent then routes it with the reason, never back to the same attempt. A message the owning attempt neither acknowledged, answered nor handed back when the work item ends is **released** to the meta agent as a fresh candidate, so nothing is dropped silently.
4. **Receipt ladder** per message: received → delivered (handed to the engine) → read (the engine took it into its session, counted only once a report or turn end follows) → handled (acknowledged, answered or handed back) → settled (result or rerouting recorded). A crash between stages preserves the message at its true stage; nothing is inferred from a successful transport write; a redelivery after a retry or restart removes the copy still waiting in the engine so exactly one copy exists.
5. **Stops and holds.** "Stop" ends the work item, withdraws its mandate and interrupts running attempts; nothing resumes it without a new admission; the rest of the message may be admitted as new work. "Wait" holds the item (§10); questions and new clues do not lift a hold; the user's explicit go does.
6. **Questions.** A specialist asks through the report's question field — one concrete question with evidence — and continues unambiguous authorised work meanwhile. The meta agent forwards it unchanged as a decision card where the triggering message was written (the chat thread for the request), without translating it into its own technical decision. Routine implementation preferences are decided, not asked; the same decision is never requested twice; a question is never left only in a transcript.
7. **Communication policy** (the bundle's shared section, enforced by length limits in code): speak when the user must act or can use a result; default to one sentence with the user-visible outcome, the link and any necessary next action; 100 words is a hard ceiling, not a target; a second sentence only for a limitation that changes what the user can do; no library names, file paths, commit hashes, test counts or investigation chronology in chat — they live in the PR and the attempt record; no unchanged status, no "PR exists" announcements, no progress narration; blockers only after checking alternatives, stating the smallest action that unblocks. Before sending, each clause must survive the question "would deleting this prevent the user from understanding the result or acting?".
8. **Secrets in chat**: a message that matches a known key format is redacted before durability, the user is told the key was not stored, and the Slots panel is offered. The meta agent's bundle forbids asking for keys or tokens in chat.
9. Outbound chat replies and receipts go through the effects queue (`reply`); uncertain sends reconcile by id before retry; a reply that can never be delivered is recorded as dropped with its reason and never queued again.

---

## 13. Guardrails and executable policy

Policy lives in deterministic code and a user-owned policy file (`~/.mec/policy.yaml`, plus optional per-repo overrides that can only *tighten*). Agents never write it; its version hash is recorded with every mandate and plan. A policy change never cancels live work: MEC computes which open work items the change bears on (a cap they exceed, a pre-authorisation they relied on, a slot pair that no longer exists) and delivers a **policy-changed note** to those items' live attempts and to the meta agent; mandates are revalidated against the current version before any resume.

### Confirmation classes

| Class | Default | Examples |
| --- | --- | --- |
| Always confirm | on, cannot be turned off by policy | `git push` to a remote; PR create/edit; PR merge; branch delete; force operations; any write outside a registered repo worktree; deleting a slot or its keystore |
| Confirm by default | on; user may pre-authorise per repo or per slot pair | dependency installs beyond the bootstrap profile; migration generation; large model-judged review spends; switching parked work to another slot; spend above a per-day cap on an API-key slot; running an attempt without the engine sandbox when policy requires it; closing MEC's own PR because a human PR already contains the change |
| Autonomous | off by default | planning, spawning within caps, checks, reviews, repairs, integration merges locally, chat replies and acknowledgements, resuming parked work on the same slot after a reported reset |

A confirmation record binds: operation hash, input SHA (when repo-related), mandate, expiry, and the exact diff or command. Resolution is compare-and-set: the first answer wins; changed input makes the earlier decision stale; expiry is never consent (v1 semantics, ported). Pre-authorised classes ("merge when all checks green, reviewer accepted, no high findings, and branch protections pass"; "continue on `max-2` when `max-1` parks") are explicit policy entries, recorded per use.

### Hard invariants

1. No external side effect leaves the machine without a settled approved confirmation.
2. The meta agent cannot approve its own confirmations, edit policy, edit prompt defaults, or exceed caps. There is no tool for it.
3. Credentials (engine slots, git, gh) are never exposed to agent processes beyond the slot they run in, and never written into logs, journals, events, chat, scorecards, diagnostics or backups; redaction happens before durability, not at display.
4. A stopped work item stays stopped and a held one stays held. Bots, timers, checks and (later) webhooks can never override a human stop or hold.
5. Everything an agent writes lives in a worktree or the database — never in MEC's own source, config, prompt or slot directories.
6. MEC never calls a vendor endpoint with a vendor-held OAuth token; the vendor CLI is the only process that uses it.
7. Outside text — repository files, tool output, quoted messages, rendered pages — is data and never changes rules, authorisation or policy.

---

## 14. Repositories, workspaces, integration and pull requests

### Workspaces (v1 port)

One bare clone cache per repository under `~/.mec/repos/`; one worktree per attempt under `~/.mec/work/`, branch `mec/<work-item8>/<task>/a<n>`, always on a pinned base. Repositories register a **bootstrap profile** (argv commands, toolchain pins, registry domains for the sandbox allowlist), **check profiles** (bootstrap, lint, typecheck, unit, integration, build — whatever the repo has), a **trust level** (untrusted by default: repo-resident agent configuration is neutralised, §8) and whether **UI evidence** is required. Private remotes use the user's ambient git credentials; MEC stores none. A pull request belongs to a task when its head branch is the task's branch.

### Integration queue (v1 port)

- A single integration worktree per work item, built from the pinned base.
- Accepted tasks merge in dependency order (`merge --no-ff`), and the integration checks run on the **exact resulting SHA**, one task per run.
- Conflicts or failing combined checks create a repair task whose worktree starts **mid-merge**, so the repair agent sees both sides; nothing is silently discarded and the work item never restarts.
- Dependents with `basePolicy: integration` start from the integration commit; `contract` dependents start once the prerequisite is accepted.

### Pull requests

- PRs are created through the user's `gh` CLI (its auth is already local); if `gh` is missing, the guardrail card says so and offers the branch + a prepared body for a manual PR.
- Before asking to open a PR, the release agent checks for a human branch or PR that already contains the work item's change (the same commits or the same diff): if one exists, it reports `dropped` with a pointer and MEC opens nothing; if MEC's own PR is already open when such a human PR appears, closing it with one sentence naming the human's PR is a pre-authorisable confirmation class. Related work that does not contain the change is not a reason to yield.
- The PR body is generated by the release agent: requirements with covering tasks, accepted SHAs, check evidence on the integration SHA, findings and their dispositions, migration notes, and which slots/providers did the work. Bot run ids, round counts and the assessment ledger stay in the attempt record.
- **Merge always confirms** by default. Merged is confirmed by GitHub, never assumed from an API call (v1 port). Target-branch movement re-runs required checks on the updated integration branch.

---

## 15. Validation, review and security evidence

- An agent ending its turn is not success. Separate states — implementation complete, checks passed, review accepted, integrated, merged — each with its own evidence. A report of `ready` requires reviewed work with the relevant checks passed on the reported SHA; a draft is `blocked` with what remains, never `ready` with a disclaimer.
- Checks capture exit status, duration, tested SHA, log tail, and distinguish *failed* from *could not start* (v1 port).
- **Independent review**: the code reviewer and PR reviewer roles never run on an attempt that shares the task's implementing session (different engine session; a different slot when pinned; a different provider when one is healthy). Findings bind to the reviewed SHA; actionable ones route to a repair with exact evidence; dispositions are recorded.
- **Review by outcome, bounded rounds**: a finding that is fixed and verified is resolved silently; a declined finding gets one factual sentence; the review → repair loop per task is capped (review rounds 3, repair attempts 2, policy-settable), the round count travels in the reports so a later attempt continues the count, and after the cap the task is delivered with any material unresolved finding stated honestly. Reviewers — model or scanner — are fallible input, not a completion gate: a suggestion is accepted only when it clearly improves the code; a critical finding is investigated promptly but verified rather than blindly applied.
- **Security checker**: runs the repo's configured scanners (any argv tool the user registers — e.g. gitleaks, semgrep, audit commands) plus a model review for dangerous patterns (credential handling, injection, unsafe deserialization, permission changes). Findings carry severity; the policy sets which severities block integration. Findings are evidence bound to SHAs, never free-floating text.
- **UI evidence**: when a repository requires it, a change to what users see is `ready` only with before and after captures of the same scenario from the real application, labelled with their revisions; after-only or mocked evidence keeps the handoff explicitly incomplete.
- Definition of done: every requirement implemented or explicitly excluded; checks attached to SHAs; findings dispositioned; confirmation trail intact; PR body accurate; the original request's explicit constraints preserved.

---

## 16. Prompt bundles

Layered, versioned, provenance-preserving:

```
~/.mec/prompts/
  shared.md            # voice, communication policy, hard rules (incl. "never ask for secrets")
  roles/<role>/        # per-role instructions (defaults ship with the app)
  engines/<engine>.md  # engine-specific notes (tool names, how to report, what not to do)
  conventions.md       # user's team conventions (initially imported from the repo's AGENTS.md/CLAUDE.md)
  delivery.md          # delivery requirements: PR evidence, commit identity, UI evidence, review budget
  scope.md             # when a specialist stops with a draft (§7)
  skills/              # named skill packs referenced by roles
```

1. A **compiled bundle** (component hashes + resolved skill versions + engine layer) is pinned to each attempt before launch; upgrades never affect running attempts. Assembly order is fixed: shared → role → team sections (conventions, delivery, scope) → engine notes → skills; the **generated sections come last** — environment variables with descriptions, slot health, policy version and caps — so a policy change leaves the preceding text unchanged and prompt caches stay warm. Precedence, strongest first: facts enforced by tools and the core (identities, permissions, argument checks, length limits — prompt text cannot change them); built-in and generated sections as overridden; team sections and skills; outside text, which is data.
2. **Revisions**: every save creates an immutable revision with the full configuration, its predecessor, timestamp and origin (panel, tool, setup); a save names its base revision and a conflicting save is refused (409) without discarding the draft; validation refuses unknown keys, reserved names and missing template placeholders and never truncates silently; an override identical to the default is removed so the part follows future defaults. Sessions read the latest revision at every launch; MEC records which revisions each attempt ran under, and a specialist may read any revision it worked under.
3. Default updates ship with the app. When a default changes, the UI marks the part **Default updated**, shows the diff against the previous default *and* against the user's override, and offers *keep my text* or *use the new default*; parts without overrides follow new defaults; overrides for removed parts are listed and dropped on the next save. An upgrade is a proposal, applied only when the user accepts (a later phase may evaluate upgrades automatically; §24).
4. Agents may *propose* bundle edits as files in a proposal area; only the user applies them. Examples in the text show format, never facts an agent may claim.
5. Every plan records the bundle revisions it ran with.
6. Repository-resident instruction files (`CLAUDE.md`, `AGENTS.md`, `.opencode/`) are **data the engine reads**, not part of the bundle; the bundle tells agents how much to trust them, and policy can disable them per repository (§8).
7. **Model-surface tests** (dsh-superagent's `model-surface` and `cards` tests): everything a model reads — tool schemas, bundle text, skills, input cards, environment lines — is checked against the schemas and the glossary within a size budget per role, and a test asserts that the built-in text states each rule the code enforces (length ceilings, report vocabulary, question semantics).

---

## 17. Data model, effects and events

SQLite (WAL, one writer, numbered SQL migrations with checksums — the v1 migration discipline; a database of a newer schema refuses to open). Records are JSON documents with generated columns and indexes over their active sets (`open`, `active`, `due`), so a pass reads only live work. Core tables:

| Table | Contents | Writer |
| --- | --- | --- |
| conversations, messages | chat, receipt states, routing decisions, acknowledgements, dropped replies with reasons | intake |
| work_items | mandate (origin, scope, policy version, budget, expiry), state, hold, blocker reason | core |
| plans, tasks | revisions, graph, validation results, impact summaries, original-request pointers | core |
| attempts, reports | role revision, engine, slot, provider, worktree, generation, base/head SHAs, diff summary; reports with their questions and round counts | core (facts from the runtime) |
| agents | instance registry: parent, role, engine, slot, budget, outcome | core |
| confirmations | class, operation hash, binding SHA, status, expiry | guardrails |
| events | append-only, gap-free per stream (`work:<id>`, `slot:<id>`, `fleet`), the source of truth | core (same transaction as the change) |
| effects | the effects queue: one row per kind and key, payload, order, failed attempts with the last error, due time | effects |
| receipts | outbound messages and external effects by idempotency id: pending, uncertain, sent, dropped with reason | outbox |
| artifacts, check_results, findings | SHAs, logs, scanner/review outcomes | runtime, integration |
| engines | installed binaries: path, version, capability probe result, probe time | slots |
| slots | engine, provider, kind, home path, credential kind, **key fingerprint only**, identity metadata from status output, state + reason, last probe, usage snapshot (`unknown` default), pinning, pair config | slots |
| handoffs | from-slot, to-slot, reason, attempt ids, handoff pack ref | slots |
| settings, prompt_revisions | revisioned blocks with origin and predecessor; policy version per revision | settings, prompts |
| scorecards | per-attempt outcome records incl. provider cost when reported (§19) | projection |

**One writer per state** (the table's last column) is enforced in code review and tests; every other part reads or asks that writer. State changes and their events commit in one transaction (v1 rule, kept exactly). Events drive the UI, the meta agent's wakes and notes, and later exports. No table, column or event payload may contain a credential; the redaction filter runs on every write path and a schema test asserts the invariant on fixtures.

### Effects queue

What MEC does after a decision — launching an attempt, delivering an input, waking the meta agent, sending a reply, pushing a branch — is **stored first and done after commit**. A command enqueues `(kind, key, payload)` inside its transaction; execution starts only after the commit. One row per kind and key: re-enqueuing a waiting key replaces its payload and makes it due at once without changing queue order. Handlers run due rows oldest first up to the kind's concurrency; failures retry with exponential backoff; a handler may answer `Later` to defer without counting a failure (no slot free; processing paused). Each kind has a health entry that turns `error` after three consecutive failures of one item.

| Kind | Handler | At once | Retry |
| --- | --- | --- | --- |
| `launch` | runtime: bootstrap, worktree, engine start | free slot capacity; none while paused | a passing failure (provider or network: 408, 429, 5xx, connection reset/timeout) retries 5 s doubling to 300 s, three times; any other failure, and a failed bootstrap, fails the attempt |
| `deliver` | runtime: inputs to a running attempt, in order | 4; none while paused | 2 s doubling to 60 s; a delivery that waits for a slot defers |
| `relay` | meta-agent runtime: a wake with its report, question or follow-up | 1, in queue order | 2 s doubling to 60 s; a failed relay holds back later ones |
| `note` | meta-agent runtime: context appended without a wake | 1, in order | same |
| `reply` | outbox: a chat message or receipt | 1; none while paused | 5 s doubling to 300 s; a message waits behind an earlier one of the same work item until that one has failed three times |
| `external` | outbox: `git push`, `gh pr …` after a settled confirmation | 1 | uncertain-send reconciliation by idempotency marker before any retry |
| `probe` | slots: local status and capability probes | 2 | bounded |

Shutdown finishes the jobs in flight, starts none and loses no rows; a restart resumes them.

---

## 18. The local workbench UI

Chat-first, decision-first. Opening the workbench answers three questions in order: *does anything need me now?* — *is the system healthy and doing the right things?* — *what happened to one piece of work, from message to PR?*

1. **Chat** (home): the conversation with the meta agent — acknowledgements, plans as cards, status as quiet updates, questions as inline decision cards with the evidence one click away. Routine tool activity stays out of the chat (it lives in traces).
2. **Inbox**: open work items in a `person` stage first, ordered by what unblocks the most work; then problems that need a person (a login card, a key to replace, a part in error); each card shows the exact operation, diff/SHA, requesting agent, and consequences in plain language, and offers its action directly. A healthy state takes no space.
3. **Work view**: work items by stage (open, queued, working, waiting, held, ended), the live agent graph (parentage, roles, slots, providers, states), per-attempt reports, transcripts, diffs, checks and findings; a work item's page shows its originating message, mandate, policy version, hold, questions and handoffs; ended items show their outcome (merged, closed, stopped by you, dropped).
4. **Slots view** (v4's fleet view, repurposed): one card per slot — engine and version, provider, identity (email/org/plan), state and reason, last probe, reported utilisation and reset time, pinning, pair config, actions (*Sign in again*, *Replace key*, *Validate*, *Drain*, *Switch work*, *Retire*). *Add slot* is a wizard: engine → provider → sign in or paste key → validate → done; the terminal card appears only for OAuth engines.
5. **Settings**: policy file (edited here, with validation and a version hash), prompt bundles with diffs and history, check profiles, isolation profiles, backups, pause. Each block has one save bar, visible only while a draft exists, a save runs or a save failed; a stale revision is refused and the draft kept.

Principles (dsh-superagent's panel principles, adopted): every element answers one of the three questions or is removed; categories have checkable, mutually exclusive, exhaustive definitions (the stage table); one place per concept; honest state — a count equals the length of the list it links to and no state contradicts another fact; quiet by default — problems shown must be actionable, a one-off network error is not; destructive actions confirm; internal identifiers appear only in folded details. The header search finds a message by text or id, a work item by title, a task by name, an attempt by id, and anything by a reference such as `#12`, a GitHub URL or a SHA. A (?) button opens the glossary of §1's concepts.

Design language (amended 5 November 2026, owner-approved design direction): a calm engineering workspace with system typography, sentence-case status labels and no tiny uppercase labels, fine separators, restrained controls, and amber only where owner attention is needed. Tokens and measures are `apps/web/src/next/tokens.css`; the amendment record is `docs/changes/2026-11-05-visual-foundation/CHANGE.md`. The new shell is behind a default-off local flag, and the classic shell keeps the earlier compact language until the new one replaces it.

Presentation names: the new shell shows Chat as *Conversation*, Inbox as *Needs you* and the Slots view as *Connections*. These are presentation names only. Hash addresses (`#chat`, `#needs`, `#slots`), HTTP APIs, stored records and the concepts in this spec keep their names.

---

## 19. Observability-lite, health and scorecards

**Health board.** Each part claims exactly one health entry (a second claim is refused): `runtime`, `scheduler`, `effects:<kind>`, `outbox`, `slot:<id>`, `engine:<id>`, `integration`, `meta_agent` (model retries and budget waits), `backup`. States are `starting | ready | paused | error`, with a detail and a time; `error` is set only after three consecutive failures of the same item and is cleared by that part's own next success. The overview shows errors only; `mec status` exposes them (§21).

**Scorecards.** The durable event log is the authority; a projection builds per-attempt **outcome records**: checks, review findings and dispositions, repair and review rounds, turns, duration, quota parks, slot and provider used, reported tokens and cost, messages sent to the user. Views answer: which roles earn their keep, which engines, providers and slots perform best on which work, how much repair and review effort each delivery costs, where time goes (waiting on quota, confirmation, checks), and what a delivery cost in subscription utilisation, API spend and user attention.

Explicit coverage recording (v1 rule): what each adapter actually surfaced — lifecycle, messages, tools, usage, rate-limit events. Missing data is unknown, not zero. Large content goes to artifact files with references; redaction precedes durability.

The full v3 evaluation stack (datasets, paired experiments, promotion policy) is deliberately deferred (§24) until real usage produces the cases it needs. The scorecard schema is designed so later experiments can consume it.

---

## 20. Recovery and operational behaviour

| Failure | Required response |
| --- | --- |
| App crash / restart | The directory lock is retaken; journal replays; attempts reconcile; running attempts end as "host restarted" and start again with a recovery note (check the worktree, git history and outbox record before repeating any outside action), oldest work item first; attempts that were waiting, ready, blocked or failed stay as they are unless an input reached them since; one live attempt per task; no duplicate authoritative work |
| Engine process dies | Preserve worktree + journal; classify; offer supported resume; else repair attempt with evidence |
| Laptop sleep / wake | Timers re-armed; stalled attempts reconciled by generation before replacement |
| Quota exhaustion | Park (`quota_wait`), inform with reset time or `unknown`, resume at reset or explicit/paired switch (§5.10) |
| Login expiry (OAuth slot) | Park (`auth_required`); slot degrades; re-login card; user signs in natively in the same slot; parked work resumes after a healthy probe; no silent slot change |
| Key revoked or rejected (API slot) | Park (`auth_required`); slot degrades `key_rejected`; *Replace key* card; keystore replaced; re-probe; resume |
| Provider outage (5xx, timeouts) | Park (`provider_down`) after the adapter's bounded retries; resume on healthy probe; switch offered per pairs |
| Engine upgrade changes the protocol | Capability probe fails → slot degrades `engine_unsupported`; running attempts keep the old binary until they finish; the user pins or upgrades deliberately |
| Confirmation expiry | Request closed as expired; the agent is told it was **not** approved; late clicks revive nothing |
| Duplicate dispatch / message | Idempotency keys; unique indexes; duplicates return the existing record |
| Integration conflict | Mid-merge repair worktree with both sides (§14) |
| gh / git push failure | Receipt marks uncertain; reconcile by idempotency marker (branch name, head SHA) before retry |
| Pause processing | Stops launches, deliveries, relays and outbound messages; running turns are not interrupted; messages keep being recorded, and a new request's planner turn runs after resume, so nothing spends quota; deadlines and timers move later by the pause's length; a message to an ended item waits and resumes it on the first pass after the pause if its mandate holds |
| Database corruption | `mec backup` (SQLite online backup + state dir tar **excluding** slot credential files and keystores) on schedule and on demand; `mec restore` with a drill script (v1 port); after restore every slot re-probes before scheduling |

Shutdown cancels turns gracefully, waits a bounded time (default 10 s per attempt) for work already in flight, leaves pending effects for the restart and releases the lock. Retention: operational logs 30 days, delivery evidence 90 days, decisions and merge records kept (configurable). Cleanup is a resumable job with eligibility checks that never touches slot homes — never an agent deciding what to delete.

---

## 21. Packaging, setup and first run

1. `npx mubit-engineering-control` (binary `mec`; Node 22 LTS floor, Node 24 recommended; macOS and Linux). `mec` starts the server and opens the workbench; `mec` also exposes `status`, `stop`, `restart`, `backup`, `restore`, `doctor`, `migrate`, and `slot` (`mec slot add|list|probe|retire`) so the agent-guided setup and scripts can drive the same flows the UI uses.
2. **`mec status` contract** (dsh-superagent's service script): exit 0 — runs normally; 1 — not running, running twice, not answering, or the runtime reports an error (a restart may fix it); 2 — a part other than the runtime reports an error (a slot's login, a provider, the outbox: a restart does not fix it; the output names the part and its detail); 3 — waiting for setup (no slot, no repository). `mec stop` writes an intentional-stop marker; `mec restart --respect-stop` honours it. An optional **hourly watchdog** is a scheduled task the user's own coding agent (or cron) runs: on 0 say nothing; on 2 or 3 tell the user once what the part or setup needs; on 1 run `mec restart --respect-stop` and report only if it fails.
3. **First-run wizard**: detect engines (installed? which versions? capability probe) → for each engine, show existing logins found by the engine's own status command in its default home → choose *link existing* or *add a dedicated slot* → sign in (terminal card) or paste a key (form) → validate → register a repository (path or URL), its bootstrap/check profiles and trust level → choose the meta agent's slot → done. Target: under five minutes with one engine, under ten with all four configurations.
4. **Agent-guided setup** (dsh-superagent's `SETUP.md`, adopted as a structure): the package ships a `SETUP.md` the user hands to their own coding agent. It reads only that file and the philosophy section before the first question; runs one probe (`mec doctor --json`) and keeps the result to itself; asks **one question per message**, each under 300 words, each with a recommended answer the user can accept with one word and one sentence on why it matters — engines and providers to connect, which slot runs the meta agent, the repository and its check commands, whether to pre-authorise anything (recommended: nothing); skips questions the probe already answers; **never asks for a secret in chat**; collects every answer, sends **one plan message** and executes only after confirmation; operator steps (sign-ins, pasting keys) are one message pointing at `mec slot add …`, which opens the terminal card or the key form in the workbench so the agent never sees a credential; verifies with `mec status` exit 0 and hands over with the panel URL, how to try it, and the three operator rules of §0.
5. Updates: `npx mec@latest`; migrations run on start; engine versions are pinned per slot and re-probed; an engine upgrade never applies mid-delivery; parts marked **Default updated** are reviewed after upgrading.
6. `mec doctor`: diagnostics bundle (redacted env metadata, adapter versions, slot states without identities or keys, sandbox dependency check, health entries, recent events) for issue reports — explicit, local, redacted before durability.
7. Native modules ship as prebuilds (`node-pty` through a prebuilt distribution, `better-sqlite3`); the launcher refuses to compile on the user's machine and prints a clear message if a prebuild is missing for the platform.

---

## 22. Security and privacy

All data stays on the machine: chat, events, transcripts, artifacts, scorecards. No telemetry, no crash reporting, no hosted dependencies. Engine credentials stay in slot homes and keystores; git credentials stay with the user's helpers; MEC's database holds fingerprints, never secrets. Agents run with allowlisted environments, shims and their own git configuration, and never receive MEC's database, policy, or prompt store as writable paths. Redaction before durability. The browser UI binds to `127.0.0.1`, rejects non-local origins and requires a custom request header (v1's CSRF discipline); the `mec-tools` MCP server binds the same way and authenticates every call with an attempt-scoped token.

**Repository-resident configuration is untrusted.** A cloned repository can carry files that engines treat as configuration and will act on in headless runs: `.claude/settings.json` (hooks run commands; `env` and `apiKeyHelper` change credentials), `.mcp.json` (spawns servers), `.codex/` (config, hooks, MCP — loaded only for trusted projects), `opencode.json` and `.opencode/plugins/*.ts` (plugins execute; MCP servers connect), and `AGENTS.md`/`CLAUDE.md` (instructions). MEC keeps repository settings out where the engine offers a switch (Claude Code: `--setting-sources user`, `--strict-mcp-config`, `disableAllHooks` in `--settings`; Codex: no project trust; OpenCode: `OPENCODE_DISABLE_PROJECT_CONFIG=1`), treats instruction files as data, and lets a repository be marked trusted explicitly. What fields of a message are trusted (the sender, the reference it makes) and what is not (the body, quotes, files) is stated in the bundle and enforced by the core.

**Vendor terms** are part of security: §5.11 is enforced structurally (no code path reads an OAuth store; adapters launch only the user's installed binary; the Slots UI offers no third-party login for Claude subscriptions).

---

## 23. Worked example

> User: "Add audit-log viewing to the console and expose it through the API. It should have tests."

Slots on this laptop: `max-1` and `max-2` (Claude Code, two Max subscriptions), `glm-1` (OpenCode, GLM Coding Plan), `gem-1` (OpenCode, Gemini API key on a billing-linked project), `codex-1` (Codex, ChatGPT Pro).

1. **Intake**: message received → explicit request → work item created with a mandate (scope: this repo; budget: defaults; expiry: none). Chat shows one acknowledgement: "On it: adding audit-log viewing to the console and the API, with tests." Pre-flight probes all five slots; `codex-1` reports an expired login and is excluded with a *Sign in again* card in the inbox — nothing stalls.
2. **Planning turn**: the meta agent (Claude, `max-1`, `--restricted`) reads the repo through its read-only profile, proposes a three-task graph — storage+API, console, tests — each brief carrying the original message verbatim, owned paths, acceptance checks, the repo's check profiles and slot classes (implementers on Claude, reviewers on a different provider). The validator passes it. The plan appears as a card; the user says "go".
3. **Execution**: implementers run on `max-1` and `max-2` in parallel worktrees on the pinned base, each under the attempt's sandbox profile with its shims and git configuration; a test author follows the console task (`contract` dependency). The console implementer reports `progress` with a structured question ("should deleted users stay identifiable?") and keeps working on the unaffected parts; a decision card appears in chat; the user answers; the question clears.
4. **Follow-up**: the user writes "also hide the export button for viewers". It references the console task, so it is delivered to that implementer, which acknowledges it ("On it: hiding the export button for viewer accounts") and handles it in scope; the meta agent gets a note, not a wake.
5. **Quota**: `max-1` emits `rate_limit_event` `allowed_warning` at 85 % of its five-hour window; the scheduler stops placing new work there. Twenty minutes later it emits `rejected` with `resetsAt` 18:40; the API-task attempt parks, the user is told, and `max-2` continues. The policy pairs `max-1 → max-2`, so the card offers the pre-validated switch; the user takes it; a new attempt continues the same worktree with a handoff pack.
6. **Review**: checks pass on each head SHA; the code reviewer runs on `glm-1` (different provider, different engine) in an independent session; the security checker runs gitleaks and a model pass on `gem-1`; a Gemini per-minute 429 arrives with a 12-second `retryDelay` and is simply retried. Two findings route to a repair on `max-2` with exact evidence; one suggestion is declined with one sentence; dispositions and the round count are recorded.
7. **Integration**: tasks merge in dependency order; combined checks run on each merge SHA; a console/API type conflict spawns a mid-merge repair that sees both sides.
8. **Ship**: the release agent finds no human branch containing the change, prepares the PR body (requirements, SHAs, checks, findings, the deleted-users decision, slots used). A confirmation card asks to push the branch and open the PR. The user approves; `gh` does it. Chat gets one sentence: "Audit-log viewing is ready for review: PR #412." Merge confirmation appears only after CI is green on GitHub — the user clicks merge (or a pre-authorised class does, recorded as such).
9. **Report**: the scorecard: elapsed time, three guardrail interruptions (plan go, slot switch, PR approve), one question, one follow-up handled in place, one quota park, one repair, zero lost work, GLM credits used, Gemini spend, four chat messages from MEC in total.

---

## 24. Roadmap

### v4.1 core (local, Claude Code first)

| Phase | Contents | Exit gate | Est. engineer-days |
| --- | --- | --- | --- |
| L0 | Launcher, directory lock, SQLite + migrations, event log, effects queue + passes + health board, config, doctor, status contract | `npx mec` serves the UI; `mec status` codes; migration tests pass | 5–7 |
| L1 | Domain port (state machines, stages, graph validation, caps, holds, report vocabulary, receipts) + in-memory repositories + testkit rig | v1 domain tests pass in the new tree; stage table tested row by row | 6–8 |
| L2 | Local runtime: Claude adapter (stream-json, permission-prompt bridge, `rate_limit_event`, `--restricted` profile), supervisor, env allowlist + shims + gitconfig, per-attempt settings/sandbox profile, journal, worktrees, checks, probes; `mec-tools` MCP server with read resources | fake-CLI end-to-end attempt with checks on a pinned base; sandbox profile proven on macOS and Linux | 10–13 |
| L3 | **Slot layer (engine-generic)**: homes, login terminal cards, serialised logins, link-existing, keystore courier and provider profiles, probes, usage models, parking + explicit switch + pairs, Slots view; meta-agent runtime (wakes/notes, acknowledgements, routing, questions), chat UI, mandates, decision cards | a real request becomes a plan and runs specialists via chat on two Claude slots; adding a `claude-api` slot by pasting a key works end to end | 10–14 |
| L4 | Specialist registry + built-in roster + scope and delivery sections + ad-hoc roles + agent graph | the §23 flow up to review, all specialists, graph visible | 6–9 |
| L5 | Integration queue, PR/merge via gh, yield-to-duplicate, guardrail classes, policy file (incl. spend caps, pairs, policy-change notes) | §23 flow end to end against a real GitHub repo | 6–8 |
| L6 | Prototype patterns: receipts and ownership, hand-back and release, holds, prompt revisions and default-updated flow, model-surface tests, crash/replay recovery, pause, backups + restore drill, redaction fixtures per provider, secrets-in-chat guard, watchdog | fault suite green (§26) | 8–11 |
| L7 | Codex adapter: `CODEX_HOME` slots, browser and device-code login cards, `--with-api-key` courier, app-server bridge, rate-limit fields, sandbox | same acceptance as Claude; mixed-engine delivery | 7–10 |
| L8 | OpenCode V2 adapter: XDG slots, GLM and Gemini provider profiles, server API + SSE bridge, permissions, project-config lock; packaging polish, onboarding wizard, agent-guided SETUP.md | four configurations, one `npx` install, first-run without docs | 8–11 |

**Total ≈ 66–91 engineer-days.** A usable Claude-only product lands at L5 (~43–59 days); L3 is the first demonstrable chat-driven slice. **Option**: run L8's OpenCode adapter before L7 — its auth is paste-once, its server API is the simplest of the three, and it gives provider diversity for reviewers early; the estimates do not change.

### Later phases (separate plans, in order of expected value)

1. **GitHub as a source** (dsh-superagent's admission model): off → observe → auto; issue, PR, review and CI triggers; subscriptions that fan later discussion out to the work it belongs to; mandates from events with the three-facts assessment (the discussion targets this project, intent to implement a specific change, direction settled enough) and one judgement per enabled rule; human stop persistence; automated-reviewer round budgets per PR. ~14–20 days after core.
2. **Scorecards → experiments**: private case capture from real deliveries, paired candidate-vs-incumbent trials for prompt/role changes, human-reviewed promotion. The v3 evaluation design applies, minus MLflow (SQLite + views first).
3. **More providers on existing engines**: `codex-glm` and other `responses`-compatible providers on Codex, Gemini CLI as a fourth engine, a direct-API adapter — all through the same slot layer.
4. **Multi-repo deliveries**: one plan spanning registered repos; one PR per repo with a compatibility manifest (v3 §14 design).
5. **Team edition**: the v3 plan's multi-user, grants and hosted deployment — built *on* these foundations when real demand exists.

---

## 25. Implementation backlog

| ID | Deliverable | Depends on |
| --- | --- | --- |
| V01 | Monorepo, launcher (`mec`), directory lock, SQLite migrations, event log, config, doctor, `status`/`stop`/`restart` contract | — |
| V02 | Web shell skeleton, first-run wizard, settings page with save bars and revisions | V01 |
| V03 | Domain port: state machines (incl. slot lifecycle), stage projection, task-graph validation, impact diff, caps, receipts model, holds, report and question model, role-scoped core interfaces, in-memory repositories | V01 |
| V04 | Local runtime: supervisor, env allowlist + scrub, shims and gitconfig with integrity checks, journal, replay, fencing, worktrees, check runner, background-work caps, recovery notes | V01, V03 |
| V05 | Claude engine adapter: capability probe, headless stream, `rate_limit_event` capture, permission-prompt bridge, `--restricted` and sandbox profiles, normalisation, redaction, `classify(error)` fixtures, report mapper | V04, V26 |
| V06 | Slot layer (engine-generic): homes per engine, slot state machine, login terminal cards (node-pty + xterm.js) with serialisation and timeouts, link-existing, identity capture, local probes, usage models, parking/resume, explicit switch with handoff packs, pair failover | V05 |
| V07 | Repositories: registration, bootstrap/check profiles (incl. registry domains), trust level, UI-evidence flag, pinned bases, artifacts | V04 |
| V08 | Meta-agent runtime: wake/note classes, turn loop, context compiler, transcript ownership, acknowledgements, routing, platform-tool validation, four-invalid-proposals escalation | V03, V05, V26 |
| V09 | Chat UI: conversation, acknowledgements, plan cards, decision cards, inbox by stage, secrets-in-chat guard | V02, V08 |
| V10 | Specialist registry, built-in roster, scope and delivery sections, role pinning and slot classes | V08 |
| V11 | Ad-hoc roles: definition schema, compiler, validation, immutable revisions | V10 |
| V12 | Scheduler: passes, caps, slot pools, utilisation preference, reserved meta capacity and wake slot, parking/resume, retry semantics, budgets and spend caps, one-live-attempt invariant | V04, V06, V30 |
| V13 | Guardrails: confirmation classes (incl. slot switch, spend, unsandboxed run, close own PR), CAS resolve, stale/expiry, policy file + version hash, policy-change notes, holds | V03, V07 |
| V14 | Receipts, follow-up ownership, hand-back, release on end, structured reports and questions, question routing | V08, V09 |
| V15 | Prompt bundles: layers (incl. engine layer and generated sections last), provenance, revisions with base and 409, default-updated flow, pinning, proposal area, model-surface tests | V08 |
| V16 | Integration queue: dep-order merges, exact-SHA checks, mid-merge repair | V07, V12, V13 |
| V17 | PR/merge flow via gh, yield-to-duplicate check, PR body generation, merge confirmation, CI gating | V16 |
| V18 | Agent graph UI, transcripts, findings views, work-item pages, search and glossary; Slots view | V10, V16, V06 |
| V19 | Scorecards: outcome records incl. cost, utilisation and messages sent, coverage recording, views and exports | V12, V16 |
| V20 | Fault suite, pause, backup/restore (credential exclusions) + drill, retention job, watchdog prompt | V04, V12, V16 |
| V21 | Packaging: npx distribution with prebuilds, onboarding wizard completion, SETUP.md, `mec slot` CLI, update flow | V02, V20 |
| V22 | Codex adapter: `CODEX_HOME` slots, browser/device-code login cards (and app-server login when proven), `--with-api-key` courier, app-server bridge + `exec --json` read-only path, rate-limit fields, sandbox, fixtures; mixed-engine acceptance | V05, V06, V12 |
| V23 | OpenCode V2 adapter: XDG slots, `OPENCODE_CONFIG`, GLM + Gemini provider profiles and courier, serve + SSE bridge, permissions list, project-config lock, V1 detection, fixtures; four-configuration acceptance | V05, V06, V12 |
| V24 | GitHub source intake: admission off/observe/auto, subscriptions, mandates from events (later phase) | V14, V17 |
| V25 | Evaluation experiments on captured scorecards (later phase) | V19, V24 |
| V26 | `mec-tools`: streamable-HTTP MCP server, attempt-scoped tokens with generation fencing, per-role tool exposure, bounded read resources, batch semantics, stdio shim; permission-bridge contract shared by adapters | V01, V03 |
| V27 | Isolation profiles: per-attempt Claude Code `--settings` sandbox profile, `--setting-sources`/`--strict-mcp-config`/`--restricted` policy, Codex sandbox and trust, OpenCode permissions and project-config lock, credential deny lists, `mec doctor` sandbox dependency check | V04, V05 |
| V28 | API-key courier and keystore: Slots form, keystore files (0600), fingerprints, zero-token validators (Anthropic, OpenAI, Gemini; GLM opt-in), rotation, shred on retire, redaction patterns per provider, Gemini free-tier warning | V06 |
| V29 | Compliance guard: static test that no code path reads OAuth stores; adapters launch only the installed binary; terms text in the Slots UI; utilisation pacing defaults | V05, V06 |
| V30 | Effects queue and health board: kinds, coalescing, backoff, `Later`, order-preserving kinds, per-kind health, drain on shutdown | V01 |

Milestones map: L0=V01–V02, V30 · L1=V03 · L2=V04–V05, V07, V26, V27 · L3=V06, V08–V09, V12–V13 (partial), V28, V29 · L4=V10–V11, V18 · L5=V13, V16–V17 · L6=V14–V15, V19–V20 · L7=V22 · L8=V21, V23.

---

## 26. Verification plan

Deterministic fault suite with fake CLIs (one per engine) and provider error fixtures; small real-engine canaries per adapter and per provider. Protocol and domain tests prove properties; broad model runs are not the proof.

| Scenario | Pass condition |
| --- | --- |
| Quota park | Work and worktree preserved; no slot switch without pairing; resume at reported reset |
| Slot failover | Handoff recorded; same worktree continues; new attempt, no cross-slot or cross-engine session resume |
| Auth expiry | Attempt parks `auth_required`; scheduler never assigns an unhealthy slot; re-login card resumes work after a healthy probe |
| Confirmation race | Two simultaneous answers produce exactly one authoritative resolution |
| Stale confirmation | Changed plan/SHA/operation cannot consume an old approval; expiry is never consent |
| Meta-agent authority | No tool path approves its own confirmation, edits policy/prompts, touches slots, or exceeds caps; four invalid proposals escalate to the user |
| Duplicate input | Re-sent message with same key is not injected twice; receipts stay truthful |
| Crash between delivered/read | Message preserved at its true stage; never marked handled |
| Restart mid-attempt | Journal replay; one live attempt per task; no duplicate authoritative writes; the replacement starts with a recovery note and exactly one copy of each waiting input |
| Human stop | Work item ends; mandate withdrawn; nothing (timer, bot, later: webhook) resumes it |
| Parallel branches | Independent worktrees; combined checks pass on the merge SHA only |
| Integration conflict | Repair sees both sides mid-merge; result has two parents; checks on the repaired SHA |
| Prompt upgrade | Running attempt keeps its pinned bundle; user override preserved as draft; identical-to-default override removed; stale-base save refused without losing the draft |
| Redaction | No credential or token string appears in journal, events, artifacts, logs, chat or scorecards — fixtures for each provider's key format and for keystore fingerprints |
| Restore | Backup restores to a scratch dir; invariants hold; no duplicate active work; backup archive contains no credential file or keystore |
| **Slot isolation** | Two Claude slots on macOS use distinct Keychain items and distinct `.credentials.json`; a linked default home runs with `CLAUDE_CONFIG_DIR` unset; two Codex homes and two OpenCode XDG sets never see each other's login |
| **Env scrubbing** | An engine launched for a subscription slot never inherits `ANTHROPIC_API_KEY` or any name containing KEY/TOKEN/SECRET/PASSWORD from the user's shell; the process environment matches the allowlist exactly |
| **Key courier** | A pasted key lands only in the slot keystore (0600); the database holds a fingerprint; rotation replaces the file; retiring shreds it |
| **Login serialisation** | Two *Add slot* actions queue; no callback-port clash; a cancelled login leaves the slot at `home_ready` |
| **Quota classification** | Fixtures for Claude `rate_limit_event` (`allowed_warning`, `rejected`), Codex `account/rateLimits` payloads and limit errors, GLM 429 and Gemini 429 with `RetryInfo` produce the right state, reset time or `unknown`, and the right retry |
| **Pre-flight** | A degraded slot named by a plan is excluded before execution starts; the inbox shows the fix |
| **Repo config hazards** | Under MEC, a repository's `.claude/settings.json` hooks, `env` and `apiKeyHelper` never apply, `.mcp.json` servers never start, Codex project trust is never granted, and an OpenCode project `opencode.json`/`.opencode/plugins` never loads unless the repository is marked trusted |
| **Sandbox profile** | A Claude Code attempt's shell cannot read `~/.mec/db`, other slot homes, `~/.ssh`, `~/.config/gh` or its own credential files; cannot write outside its worktree; reaches only allowlisted domains |
| **Shims and gitconfig** | `claude`, `codex`, `opencode`, `mec` and listed personal CLIs fail by name inside an attempt; git uses the attempt gitconfig and never prompts; a foreign file in the shim directory refuses the attempt |
| **Platform-tool fencing** | A tool call with a stale generation token is rejected; a specialist token cannot call `spawn_agent` or `propose_plan`; a specialist reads only its own task and attempt |
| **Compliance guard** | A static check fails the build if any module imports a path that reads `.credentials.json`, `auth.json` tokens, `opencode.db` credentials or Keychain items; adapters resolve the engine binary from PATH/user config only |
| **Capability drift** | An engine upgrade that removes a flag or changes an event shape degrades the slot to `engine_unsupported` before any attempt starts, and running attempts finish on the old binary; a Claude Code that makes `--bare` the `-p` default is detected |
| **Secrets in chat** | A message containing a key-shaped string is stored redacted and answered with the Slots pointer |
| **Acknowledgement** | Each admitted request produces exactly one acknowledgement across restarts; a quick question produces none |
| **Follow-up ownership** | A referenced follow-up reaches the owning specialist; the meta agent can only stop while it is owned; a hand-back routes elsewhere with its reason and never back; a message unhandled at the work item's end returns as a candidate |
| **Hold** | "Wait" holds the item across a restart and a new attempt; a status question is answered without resuming; only the user's go lifts it |
| **Stage table** | Every open work item matches exactly one row; inbox counts equal list lengths |
| **Wake vs note** | `progress` reports and the meta agent's own actions never start a turn; `ready`, `blocked`, questions and resolved confirmations do |
| **Effects queue** | Re-enqueuing a waiting key coalesces; `Later` counts no failure; a failed relay holds later relays; the kind's health turns `error` after three consecutive failures and clears on success; a drain loses nothing |
| **Reserved wake slot** | With every slot busy, a user's follow-up still reaches its specialist before any queued launch |
| **Pause** | No launch, delivery, relay or outbound message during a pause; running turns finish; deadlines shift by the pause length |
| **Model surface** | Tool schemas, bundle text, skills and cards validate against the schemas within the size budget per role; the built-in text states each enforced rule |
| **Yield to duplicate** | A human PR containing the change makes the release agent report `dropped` and MEC opens nothing |

Operational targets (pilot, not promises): chat wake-to-first-token under 5 s; a confirmation card renders within 2 s of the triggering event; parked-work resume under 10 s from probe-confirmed health; *Add slot* to healthy under 2 min for any engine.

---

## 27. Decisions to keep visible during the pilot, and rejected concepts

### Decisions

1. **How much autonomy?** Start with default guardrails; tighten or pre-authorise per confirmation class only after evidence.
2. **Slot pinning strategy** — which roles on which subscriptions and which API-key providers — after observing quota patterns and cost.
3. **Reviewer independence**: same engine different slot vs different provider, once OpenCode or Codex lands.
4. **Security checker toolset**: which scanners a repo registers, and which severities block.
5. **Prompt upgrade cadence**: how often defaults ship, and whether upgrades become auto-evaluated (later phase).
6. **Pacing on subscriptions**: the utilisation ceiling and caps that keep a Max plan within "ordinary individual usage" while still being useful; when to recommend an API-key slot instead; written confirmation from Anthropic on headless orchestration under a personal subscription.
7. **Engine order**: whether OpenCode's cheap, paste-once providers should land before Codex.
8. **Sandbox strictness**: whether a missing Linux sandbox dependency fails attempts or degrades to prompts.
9. **Trusted repositories**: whether any repository should be allowed to load its resident agent configuration, and what the trust mark requires.

### Rejected concepts

| Rejected | Reason |
| --- | --- |
| MEC-held OAuth tokens (`setup-token`, refresh tokens, copied credential files) | Prohibited by Anthropic's terms for third-party tools; unnecessary when the vendor CLI holds the session in a slot home |
| The Claude Agent SDK as the Claude adapter | Its bundled binary and SDK posture fall under the API-key requirement; the installed CLI's documented headless mode is the sanctioned path |
| A slot per attempt | A slot is a credential; attempts share it. Isolation between attempts is the worktree, environment and sandbox |
| Engine sessions resumed across slots or engines | A session belongs to the home that created it; a handoff pack is portable, a session is not |
| Automatic model or provider switching on failure | Hides failures and burns quota; explicit pairs only |
| Periodic network probes against quota-metered plans | A probe is a prompt against the plan; local status commands and engine events suffice |
| Cancelling live work on a policy change | Leaves half-finished work; a note is delivered and mandates are revalidated before resume |
| Inferring "waiting on a person" from free text | Needs structured facts; the question field is the only way to ask |
| The meta agent implementing code, reading transcripts to plan, or rewriting requests | Specialists own technical work; the original request is the authority |
| A fixed LOC allowance for scope | Stop by impact, not size |
| Agents deciding what to delete or retain | Retention is a deterministic job with eligibility checks |
| Trusting repository-resident agent configuration by default | Hooks, plugins and MCP servers in a cloned repository are a supply-chain path |
| A separate concept for every need (reviewer bots, priorities, labels) | A need becomes an attribute of an existing concept or prompt text |

---

## 28. Provenance and sources

- **v1 codebase** (`mubit-engineering-control@version-1`, M0–M10): event log/outbox, domain rules, worktree/integration/check discipline, journal protocol, Claude adapter, confirmations, testkit — ported as listed in §2.
- **dsh-superagent-prototype** (deepseek-ai, MIT, research prototype "for reference only"; first reviewed at `6337fc8`, re-read in full at `8c32a9d`, 31 October 2026): philosophy, domain and authorisation model, execution and recovery rules, prompt system, panel, deployment and setup patterns — adapted as mapped in Appendix A; no code or runtime dependency imported.
- **v3 build plan** (this repository, `docs/`): engineering invariants carried over verbatim wherever they survive the local pivot (§2 drops are explicit).
- **v4 plan** (3 Nov 2026): scope and structure; superseded by this document.

Vendor documentation and reporting consulted on 3 November 2026 (re-verify on each engine upgrade):

**Claude Code**
- Authentication (config dirs, Keychain keyed per directory, `setup-token`, precedence): https://code.claude.com/docs/en/authentication
- Legal and compliance (OAuth scope, third-party developers, ordinary individual usage): https://code.claude.com/docs/en/legal-and-compliance
- CLI reference (`-p`, `--restricted`, `--bare`, `--permission-prompt-tool`, `--setting-sources`, `--settings`): https://code.claude.com/docs/en/cli-reference
- Headless mode and stream-json: https://code.claude.com/docs/en/headless
- Environment variables: https://code.claude.com/docs/en/env-vars
- Sandboxing (settings keys, bubblewrap/socat, credential protection): https://code.claude.com/docs/en/sandboxing
- Permissions and what runs before a folder is trusted: https://code.claude.com/docs/en/permissions · https://code.claude.com/docs/en/permission-modes
- Costs and usage limits: https://code.claude.com/docs/en/costs
- Agent SDK overview and hosting (`settingSources`, `CLAUDE_CONFIG_DIR` per tenant): https://code.claude.com/docs/en/agent-sdk/overview · https://code.claude.com/docs/en/agent-sdk/hosting
- `rate_limit_event` shape (Python SDK types): https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/src/claude_agent_sdk/types.py
- Keychain and `CLAUDE_CONFIG_DIR` issues: https://github.com/anthropics/claude-code/issues/92252 · https://github.com/anthropics/claude-code/issues/24963
- February 2026 clarification on third-party access: https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/ · https://venturebeat.com/ai/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses/
- Secondary analysis of subscription-auth boundaries (July 2026): https://zylos.ai/research/2026-07-13-subscription-auth-boundaries-official-cli-agent-automation
- Community multi-account recipe: https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2

**Codex CLI**
- Authentication (`login`, device auth, `--with-api-key`, `CODEX_HOME`, headless guidance): https://learn.chatgpt.com/docs/auth.md
- Non-interactive mode (`codex exec`, `CODEX_API_KEY`): https://learn.chatgpt.com/docs/non-interactive-mode.md
- App server protocol (`thread/*`, `turn/*`, approvals, `account/rateLimits/*`, `account/login/start`): https://learn.chatgpt.com/docs/app-server.md
- CLI reference and config reference (`model_providers`, `mcp_servers`, profiles, trust): https://learn.chatgpt.com/docs/cli/reference.md · https://learn.chatgpt.com/codex/config-file/config-reference · https://learn.chatgpt.com/codex/config-file/environment-variables
- Pricing and plan limits: https://learn.chatgpt.com/codex/pricing · https://help-lb.openai.com/en/articles/11369540
- Hooks and MCP: https://learn.chatgpt.com/codex/hooks · https://learn.chatgpt.com/codex/extend/mcp
- Models: https://learn.chatgpt.com/docs/models
- Source (login server, exec events, app-server protocol, auth storage): https://github.com/openai/codex

**OpenCode (V2)**
- Config and precedence, `{env:}`/`{file:}` substitution: https://opencode.ai/v2/docs/config/
- Providers and credentials CLI (`auth login/list/import`, `opencode.db`): https://opencode.ai/v2/docs/cli/providers
- CLI commands (`run`, `serve`): https://opencode.ai/v2/docs/cli/commands/ · https://opencode.ai/v2/docs/cli/web/
- Server API and client: https://opencode.ai/v2/docs/api · https://opencode.ai/v2/openapi.json · https://opencode.ai/v2/docs/build/client/
- MCP servers, permissions, plugins, policies, instructions: https://opencode.ai/v2/docs/mcp-servers/ · https://opencode.ai/v2/docs/permissions/ · https://opencode.ai/v2/docs/plugins/ · https://opencode.ai/v2/docs/policies/ · https://opencode.ai/v2/docs/instructions/
- V1 → V2 migration: https://opencode.ai/v2/docs/migrate-v1/
- V1 providers page (Anthropic subscription removal): https://opencode.ai/docs/providers/
- Source: https://github.com/anomalyco/opencode

**Z.ai GLM Coding Plan**
- Overview, FAQ (credit windows), usage policy, quick start: https://docs.z.ai/devpack/overview · https://docs.z.ai/devpack/faq · https://docs.z.ai/devpack/usage-policy · https://docs.z.ai/devpack/quick-start
- Tool setup — OpenCode, Claude Code, Codex: https://docs.z.ai/devpack/tool/opencode · https://docs.z.ai/devpack/tool/claude · https://docs.z.ai/devpack/tool/codex

**Google Gemini API**
- API keys (restricted keys by default): https://ai.google.dev/gemini-api/docs/api-key
- Rate limits (tiers, per-project limits, daily reset): https://ai.google.dev/gemini-api/docs/rate-limits
- Errors (429 body, `RetryInfo`): https://ai.google.dev/gemini-api/docs/api-errors
- Pricing (free-tier data use) and models: https://ai.google.dev/gemini-api/docs/pricing · https://ai.google.dev/gemini-api/docs/models
- Models list endpoint: https://aistudio.google.com/api-reference/models

**Packaging**
- Prebuilt `node-pty` distribution: https://github.com/oznu/node-pty-prebuilt-multiarch

---

## Appendix A — dsh-superagent patterns and where they landed

| Pattern | dsh source | MEC section | Status |
| --- | --- | --- | --- |
| Attention principle; few concepts, few settings; operator responsibility | 000 Philosophy | §0, §1, §12 | adopted |
| Source / Trigger / Thread / Eval / Mandate / Ticket / Assignment / Subscription | 001 Domain | conversation / message / work item / mandate / task / attempt; subscriptions and Eval return with the GitHub source | adapted; proactive parts later phase |
| Only three operations change a mandate; revalidation before resume | 001, 002 | §10, §13 | adopted |
| Rejected-concepts table | 001 | §27 | adopted |
| Explicit vs inferred strength; accept modes off/observe/auto; admission table; three-facts assessment; one judgement per rule | 002, prompts/admission.md | §24 later phase 1 | later phase |
| Follow-up ownership: executor decides, orchestrator may only stop; hand-back once with reason; release on end | 002, 003, prompts/work.md | §12 | adopted |
| Policy version hash; change delivered as a notice, never a cancel | 002, 007 | §13 | adopted |
| Ticket stages, first-match table, labels say whom it waits for | 003 | §10, §18 | adopted |
| Reports progress/waiting/ready/blocked/failed/dropped | 003, 001 glossary | §10 | adopted |
| Worker slots; reserved slot for a person's message; wakes before launches | 003 | §11 | adopted |
| Background jobs continue within a cap; review servers live until the assignment ends | 003 | §8 | adapted (engine mechanisms, MEC caps) |
| Retry = new assignment, same session/directory/branch; restart with a recovery note | 003 | §11, §20 | adopted |
| Passing provider/network failures retried three times with backoff; launches that fail otherwise fail the ticket | 003, 007 | §17 | adopted |
| Stored work (effects): enqueue in transaction, run after commit, coalescing, `Later`, per-kind concurrency and order, health after three failures | 007 | §17 | adopted |
| Outbox receipts: pending/sent/dropped with reason; never queued twice; order per ticket and conversation | 003, 007 | §12, §17 | adopted |
| Pause processing | 003 | §20 | adopted |
| Execution variables with descriptions; none contain credentials | 003 | §5.12, §16 | adopted |
| Command shims, blocked commands, worker gitconfig, env name scrub, integrity checks, "defaults, not a boundary" | 006, 007 | §8 | adopted |
| Dedicated OS account for real isolation | 006 | §5.4 | recommended |
| Attention as a structured field; asked where the person wrote; raised while work continues; reuse/replace/clear semantics | 004, prompts/handoff-worker.md | §10, §12 | adopted |
| Confirm concretely, once; acknowledgement deduplicated per trigger | 004, prompts/replies.md | §12 | adopted |
| Communication policy: one sentence, 100-word ceiling, evidence in the PR, no unready-PR announcements, delete-test per clause | prompts/team/communication.md | §12 | adopted |
| Scope section: stop by impact; no LOC allowance; draft preserved; holds persist; automated feedback never resumes | prompts/team/scope.md | §7, §10 | adopted |
| Delivery: UI before/after evidence; yield to a human's duplicate PR; honest readiness | prompts/team/delivery.md, 004 | §14, §15 | adopted |
| Review by outcome; automated reviewers fallible, three rounds max | prompts/team/communication.md | §15 | adopted (internal rounds now; GitHub bots later) |
| Separate roles: router never rewrites, original request travels, workers recheck scope | prompts/shared.md, dispatch.md | §6 | adopted |
| The orchestrator never waits; no-wait guard; wakes vs notices; no notice of its own actions | 004, 007 | §6 | adopted |
| Prompt assembly order with generated sections last; precedence list; immutable revisions with base, 409, size limits; identical-to-default removal; sessions record revisions | 004, 007 | §16 | adopted |
| Default-updated flow with diffs, keep/use choice, removed parts dropped on save | 004, 005 | §16 | adopted |
| Model-surface and cards tests | 007 | §16, §26 | adopted |
| Bounded read resources; closed card states; every id readable; executors read only their own ticket | 007 | §6 | adopted |
| Batch routing with per-item results; idempotent accept by trigger id | 007 | §6 | adopted |
| Panel: three questions, principles, search, glossary, save bars | 005 | §18 | adopted |
| Health board, one writer per entry; status exit codes 0/1/2/3; intentional-stop marker; hourly check by the operator's own agent | 006, 007 | §19, §21 | adopted |
| Role-scoped engine interfaces; imperative commands vs past-tense facts; one writer per state | 007 | §4, §17 | adopted |
| In-memory repositories mirroring the store for domain tests; docs tests | 007 | §4, §26 | adopted |
| Agent-guided SETUP.md structure | SETUP.md | §21 | adopted |
| Feishu source, GitHub notifications polling, DeepSeek Harness presets | 006, 008 | — | not applicable (single user, chat intake, local engines) |
