# MEC v4.1 — Stream B brief: engines, slots and runtime

Hand-off brief · 3 November 2026 · read with `spec.md` (the spec), `CONTRACTS.md` (the shared interfaces) and `KICKOFF.md` (rules, handshakes, the prompt to paste).

## 1. Mission

Build everything that **executes**: the engine adapters (Claude Code first, then Codex, then OpenCode V2), the slot and authentication layer, process supervision and isolation, worktrees and checks, repositories, the Slots view and first-run wizard, the launcher with its status contract, packaging, and the fixture library every test depends on. You never need the meta agent: you run attempts from a scripted brief against a stub core until the handshakes connect the real one.

Read first, in this order: plan §5 (all of it), §8, §9, §5.11 and §22 (the compliance rules you enforce), §20, §21, §14 (workspaces), §19 (health), then §6 and §10 for what A builds against you. §28 lists the vendor pages the plan was verified against; re-read the engine's page before you touch that engine.

## 2. Ownership

You own and are the only one who edits:

- `packages/runtime` — supervisor, environment allowlist and scrub, command shims, per-attempt gitconfig, journal (fsync, ack cursor, replay, generation fencing), worktree lifecycle, check runner, isolation profiles, background caps, recovery notes
- `packages/engines` — `EngineAdapter` implementations: `claude/`, `codex/`, `opencode/`; capability probes; `classify`; report mappers
- `packages/slots` — credential homes, slot state machine driver, login orchestration (node-pty), keystore courier, probes, provider profiles, usage models, redaction patterns, compliance guard
- `packages/git` — clone cache, worktrees, head/diff (A adds `merge.ts`, `conflict.ts`, `impact.ts`)
- `packages/testkit` — fake CLIs (one per engine), the fixture recorder and every file under `fixtures/`, provider error fixtures, the runtime half of the fault rig
- `apps/desktop` — the `mec` launcher, `status`/`stop`/`restart`, `doctor`, `migrate` wrapper, `slot` CLI, packaging with prebuilds, update flow
- `apps/web`: the Slots view, terminal cards, first-run wizard, repositories settings, scorecard views (as self-contained routes mounted in A's shell)
- Backups, restore drill, retention job, watchdog prompt; scorecards projection; `SETUP.md`

You do not edit `packages/domain`, `packages/effects`, `packages/mec-tools`, `packages/policy`, `packages/prompts`, the store, A's web routes, or the plan. A need there is a stub on your side or a PR request to A.

## 3. Machine pre-flight (day 1, before anything else)

1. Record the installed versions: `claude --version`, `codex --version`, `opencode --version` (must be V2, 2.2.x; a V1 `opencode-ai` binary is `engine_unsupported`). Pin them in `docs/engines.md` with the date; re-probe deliberately, never by accident.
2. On macOS, create two `CLAUDE_CONFIG_DIR` homes, sign in to each with `claude auth login`, run `claude auth status` in each, and confirm two distinct Keychain items. Then confirm that running with `CLAUDE_CONFIG_DIR` explicitly set to `~/.claude` selects a different Keychain item than leaving it unset (issue #92252) — the linked default home must run with the variable unset.
3. On Linux, install `bubblewrap` and `socat`, enable the Claude Code sandbox in a throwaway home, and confirm a sandboxed `cat ~/.ssh/id_ed25519` fails.
4. Run `codex login status` with `CODEX_HOME` pointing at an empty directory (expect exit 1 and "Not logged in" on stderr) and confirm `CODEX_HOME` must exist before launch.
5. Run `opencode auth list --format json` with `XDG_DATA_HOME`/`XDG_CONFIG_HOME` pointing at empty directories; confirm `opencode.db` is created under the data dir and that `OPENCODE_DISABLE_PROJECT_CONFIG=1` stops a repo-level `opencode.json` from loading (make one that registers a bogus MCP server).
6. Record the first fixture: `claude/<version>/smoke` — a scripted `-p` run with `--output-format stream-json --verbose` on a fixture repo, redacted, with `meta.json`. This proves the fixture format on day 2 and is what A's `FakeEngine` first replays.
7. Review A's contracts PR against what you saw: every event shape must be producible from the real streams you recorded.

## 4. Work items, in order

Each item lists deliverables, the definition of done (DoD), plan sections, and what you stub. Weeks assume a 3 November start.

### B0 — Launcher and status contract (2–3 days, week 1)

- `mec` binary: starts the server (A's composition root behind an interface), opens the workbench; `status` with the four exit codes (0 normal; 1 not running/twice/not answering/runtime error; 2 a part in error that a restart does not fix; 3 waiting for setup); `stop` writes the intentional-stop marker; `restart --respect-stop` honours it; `doctor` skeleton (redacted env metadata, versions, health entries). Plan §21.
- DoD: status codes tested against a fake health board; stop marker test; doctor output passes the redaction lint.

### B1 — Runtime, Claude adapter, isolation (8–10 days, weeks 1–3)

- **Supervisor**: argv arrays only, one process group per attempt, (attempt, generation) ownership, SIGTERM → escalate → confirm gone; crash and sleep/wake classification.
- **Environment** (plan §5.12): inherited allowlist; name-based scrub (`KEY`, `PASSWORD`, `SECRET`, `TOKEN`) plus the prefix list; slot layer; attempt layer; a test that the resulting environment matches the allowlist exactly.
- **Shims and gitconfig** (plan §8): `<worktree>/.mec/bin` first on `PATH` with blocked commands (`mec`, `claude`, `codex`, `opencode`, policy-listed personal CLIs) failing by name, wrappers removing the shim dir before exec; `GIT_CONFIG_GLOBAL` + `GIT_CONFIG_NOSYSTEM=1` + `GIT_TERMINAL_PROMPT=0`; integrity hashes; refusal when the repository's own config adds credentials.
- **Journal**: `~/.mec/journal/<attempt>/events.jsonl`, fsync before any store write, ack cursor, replay into `CoreForEngines` facts after restart, sequence checks, dedupe, generation fencing; redaction before append.
- **Worktrees and checks** (`packages/git`, plan §14): bare clone cache, one worktree per attempt on a pinned base, branch naming; check runner with passed / failed / could-not-start and log tails.
- **Claude adapter** (plan §9): capability probe (flag presence per installed version, `auth status` JSON, `rate_limit_event` availability, `--restricted`, `--bare` default status, `--permission-prompts`); launch with the §9 flag set; stream-json normalisation into `EngineEvent` (`system/init` → `session_started`; assistant/user; `tool_call`; `rate_limit_event` → `rate_limit`; `result` → `report` + `exit` with `terminal_reason`; `permission_denials` recorded); `--permission-prompt-tool mcp__mec__confirm` wiring from `brief.tools`; `--mcp-config` + `--strict-mcp-config`; `--session-id`/`--resume`; `classify(error)` from `system/api_retry` and assistant `error` values; report mapper from the structured final output.
- **Isolation profile, Claude part** (plan §8): per-attempt `--settings` JSON (sandbox enabled, `allowUnsandboxedCommands: false`, `failIfUnavailable` per policy, `filesystem.allowWrite` worktree + temp, `denyRead` for `~/.mec` outside the worktree, other slot homes, `~/.ssh`, `~/.aws`, `~/.config/gh` and the slot's own credential files, `network.allowedDomains` + `strictAllowlist`, `disableAllHooks`); `--setting-sources user`; read-only roles get `--restricted --permission-prompts none`; `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` for untrusted repos; `mec doctor` sandbox dependency check.
- **Fake Claude CLI** that emits scripted stream-json from fixtures, honours stdin input and SIGTERM; recorder `mec-devtools record` with redaction that fails on residual matches.
- DoD: the eleven mandatory fixtures for Claude recorded and passing conformance; environment and shim tests; journal replay test (restart mid-attempt → one live attempt, exactly one copy of waiting inputs); sandbox tests on both OSes (shell cannot read the deny list, cannot write outside the worktree, reaches only allowlisted domains); a scripted brief runs end to end against `MemoryCoreForEngines`. → **H1** with A's effects queue and bridge.

### B2 — Slots, keystore, compliance, repositories, Slots view (7–9 days, weeks 3–5)

- **Credential homes** (plan §5.3): create per engine (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` pre-created, XDG set + `OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG`); link-existing with the Claude default home run with the variable unset; refuse Console keyless profiles for Claude slots.
- **Slot state machine driver** (plan §5.5) emitting `slot.changed`; `reserve`/`release` with per-slot concurrency; the concurrent-reservation fixture.
- **Login orchestration** (plan §5.6): terminal cards (node-pty + xterm.js) running `claude auth login` / `codex login` (+ `--device-auth`) in the slot env; URL detection → open in the default browser; serialised logins with a queue; ten-minute timeout and cancel; the login stream is never persisted; identity capture from the status commands; re-login cards that resume parked work after a healthy probe; expiry warning from Claude's status.
- **Keystore courier** (plan §5.4, §5.7): the Slots form (masked field, never echoed), `keys/<provider>.key` at 0600, salted fingerprint only in the store, delivery per engine (`ANTHROPIC_API_KEY` env; `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` in the slot `settings.json` env block for GLM, 0600; `codex login --with-api-key` on stdin; `{file:}` substitution in the slot `opencode.json` or the provider env var), zero-token validators (`GET /v1/models`, `GET /v1beta/models`), GLM minimal-request validator opt-in, rotation, shred on retire, Gemini free-tier warning and the private-repo refusal.
- **Probes and usage models** (plan §5.8, §5.9): local probes on a cadence; `UsageReading` from `rate_limit` events and provider 429 bodies; never a network probe against a metered plan on a cadence; `unknown` never rendered as zero.
- **Redaction patterns** per provider key format, exported for the contracts lint; **compliance guard** (plan §5.11): a static test that fails the build if any module reads `.credentials.json`, `auth.json` tokens, `opencode.db` credentials or Keychain items; adapters resolve binaries from PATH or user config only; the terms text in the Slots UI.
- **Repositories** (plan §14): registration, bootstrap and check profiles with registry domains, trust level, UI-evidence flag, pinned bases.
- **Slots view and wizard**: one card per slot with state, reason, identity, utilisation and reset time, actions; the *Add slot* wizard; engine detection with existing-login discovery; repository registration.
- DoD: slot-isolation tests (two Claude homes → distinct Keychain items and credential files; two Codex homes; two OpenCode XDG sets); env-scrub test for a subscription slot; key-courier test (keystore only, fingerprint in store, rotation, shred); login-serialisation test with a fake login CLI; quota-classification fixtures for Claude, GLM and Gemini; compliance guard green in CI. → **H2** with A's chat and scheduler.

### B3 — Backups, watchdog, runtime fault rig, scorecards (4–6 days, weeks 5–6)

- `mec backup` (SQLite online backup + state dir tar excluding `engines/*/keys/`, `.credentials.json`, `auth.json`, `opencode.db`, Keychain items), `mec restore` into a scratch dir with a drill script, every slot re-probed before scheduling after a restore; retention job (resumable, eligibility checks, never touches slot homes); the hourly watchdog prompt for a coding agent (plan §21).
- Runtime half of the fault rig: engine death, laptop sleep/wake, stalled attempt reconciliation by generation, capability drift (a removed flag or changed event shape degrades the slot before any attempt; a Claude Code that makes `--bare` the `-p` default is detected), provider outage.
- Scorecards projection and views from A's event schemas (plan §19): outcome records with cost, utilisation and messages sent; coverage recording (what each adapter surfaced; unknown, not zero).
- DoD: restore drill passes with no credential in the archive; the §26 rows owned by B green on the fake CLI; scorecard views render from a fixture event log.

### B4 — Codex adapter (7–10 days, weeks 6–8)

- `CODEX_HOME` slots; `codex login` in a terminal card (loopback 127.0.0.1:1455, fallback 1457 — serialised), `--device-auth` card, app-server `account/login/start` as the assisted path once the installed version proves it; `--with-api-key` courier; `codex login status` probe (stderr, exit code).
- App-server bridge: JSON-RPC over stdio, `initialize`/`initialized`, `thread/start` with `cwd`, `sandbox: workspace-write`, `approvalPolicy` routed to the bridge, `turn/start`, `turn/steer`, `turn/interrupt`; approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`) mapped to `PermissionBridge.request` and answered `accept`/`acceptForSession`/`decline`/`cancel`; `account/rateLimits/read` + `account/rateLimits/updated` → `rate_limit`; `thread/tokenUsage/updated` → `usage`; `turn/completed` → `report`/`exit`; types generated with `codex app-server generate-ts` for the pinned version and checked in under `fixtures/codex/<version>/types/`.
- `codex exec --json --sandbox read-only` path for read-only roles only (exec cannot bridge approvals); `thread/resume` / `codex exec resume`.
- Isolation: no project trust (worktrees never marked trusted), `-c` overrides per launch, `[mcp_servers.mec]` with `url` and `bearer_token_env_var`.
- Fake Codex CLI (app-server mode) and the eleven mandatory fixtures.
- DoD: conformance green for Codex; approval mapping tests; rate-limit fixture parks the attempt; a mixed-engine delivery (Claude implementer, Codex reviewer) with A's core. → **H4**

### B5 — OpenCode V2 adapter, packaging, wizard, SETUP.md (8–11 days, weeks 8–9)

- XDG slots, `OPENCODE_CONFIG`, `--standalone`/`--stdio` server per slot (never `--service`), `OPENCODE_PASSWORD` generated per slot, HTTP Basic with user `opencode`; V1 detection → `engine_unsupported` with upgrade instructions.
- Provider profiles: `zai-coding-plan` and `google` entries in the slot `opencode.json` with `{file:}` keys; default models (`zai-coding-plan/glm-5.3`, `google/gemini-3.8-flash`); the `permissions` list (edits inside the worktree, `external_directory`/`webfetch`/`websearch` denied, `shell` outside the profiles → `ask`); `OPENCODE_DISABLE_PROJECT_CONFIG=1` unless the repository is trusted, in which case `mcp.servers` and `plugins` are overridden by name.
- Server bridge: `POST /api/session` with `location.directory` = worktree, `/prompt`, `/interrupt`, SSE `/api/event` (`permission.asked` → `PermissionBridge.request` → `/permission/:requestID/reply` with `once`/`always`/`reject`; `session.step.*` → `usage`; `session.idle` → turn end; `session.usage.updated`); `opencode run --format json` for read-only roles only; `mcp.servers.mec` remote with headers and `oauth: false`.
- Fake OpenCode server and the eleven mandatory fixtures; GLM and Gemini 429 fixtures under `providers/`.
- Packaging: `npx` distribution with prebuilds (`node-pty` prebuilt, `better-sqlite3`), refuse-to-compile message, update flow; first-run wizard completion; `mec slot add|list|probe|retire`; `SETUP.md` following plan §21 (one question per message, no secrets in chat, one plan message, operator steps point at `mec slot add`).
- DoD: conformance green for OpenCode; project-config hazard test (a repo `opencode.json` with a bogus MCP server never loads under MEC); four-configuration acceptance with A; a fresh machine reaches a healthy slot in under two minutes per engine; a coding agent completes `SETUP.md` end to end. → **H5**

## 5. What you need from A, and when

| Need | From | By |
| --- | --- | --- |
| Contracts PR to review; `MemoryRepositories`, `MemoryCoreForEngines` | A0 | day 3 |
| Store and effects queue to replace the stub core; `launch`/`deliver`/`probe` handler registration | A1 | H1, end of week 2 |
| `PermissionBridge` implementation and `mec-tools` URL/token issuance | A3 | H1 |
| Web shell with mount points for the Slots view, terminal cards and wizard | A3 | week 3–4 |
| Scheduler calling `reserve`/`release`; chat for the H2 demo | A4 | H2 |
| Event schemas final for scorecards | A1 | B3 |
| Domain half of the fault rig conventions | A7 | H4 |

## 6. Handshake obligations

- **H0**: pre-flight done, first fixture recorded, contracts reviewed.
- **H1**: you drive the demo: scripted brief → runtime → Claude adapter on the fake CLI → journal → A's store; a permission request round-trips; a rate-limit fixture parks.
- **H2**: slots and login cards under A's chat demo; a `claude-api` slot by pasted key.
- **H3**: isolation profiles proven on macOS and Linux for A's §23 run.
- **H4**: Codex slot signs in; mixed-engine delivery; restore drill.
- **H5**: you drive: four configurations, `npx` install, first run without docs, `SETUP.md` by an agent.

## 7. Working notes

- Every engine fact in the plan was verified on 3 November 2026 against the vendor docs listed in plan §28; versions move weekly. Re-read the vendor page before implementing a flag, and if the installed binary disagrees with the plan, the binary wins — record it in `docs/engines.md` and tell A if a contract is affected.
- Never read a vendor OAuth store, never call an undocumented endpoint with a vendor token, never log a credential; the compliance guard is yours to keep green.
- Fixtures before features: record the real stream, redact, commit, then implement against it.
- Report at the end of each item: what landed, what is stubbed, which fixtures exist, which §26 rows are green.
