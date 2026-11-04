# MEC — Mubit Engineering Control

A local meta-agent orchestration app. Connect your coding agents (Claude Code, Codex, OpenCode), talk to one meta agent, and it plans, spawns specialists, and runs the delivery loop — worktrees → checks → review → integration → PR — interrupting you only for guardrail confirmations.

**Fully local**: SQLite on your machine, no cloud, no telemetry. Credentials never leave the machine: engine logins live in isolated slot homes, API keys in per-slot keystores (`0600`), and the database holds fingerprints, never secrets. Nothing crosses the network without a confirmed card — push, PR and merge each wait for your click.

**Internal product** (owner decisions #3/#4): free forever, distributed inside the company via this repository and the internal tarball — never a public registry.

## What is proven

Every claim below ran against real binaries, real accounts and a real repository — never fakes. Full evidence in [`docs/log/HANDSHAKES.md`](docs/log/HANDSHAKES.md); the honest open-items list lives in [`docs/STATUS.md`](docs/STATUS.md).

| Capability | Status | Evidence |
| --- | --- | --- |
| Claude Code engine | ✅ real recordings + live canary | H1: sandbox, permission bridge, quota signals, checks on exact SHAs |
| Codex engine (ChatGPT login) | ✅ real recordings + live canary | R2.1: protocol reconciled on codex-cli 0.148.0, permission round-trip |
| OpenCode (GLM / Gemini) | ✅ real recordings + live canary | R2.2: both slots validated healthy over real HTTP; permission round-trip on the real binary |
| Delivery loop on a real repo | ✅ end to end | H3: PR [#2](https://github.com/MubitLabs/mec-sandbox/pull/2) merged, GitHub-confirmed |
| Mixed-engine delivery | ✅ both pairings | H4/R2.3: PRs [#3](https://github.com/MubitLabs/mec-sandbox/pull/3) & [#4](https://github.com/MubitLabs/mec-sandbox/pull/4) — Claude implements + Codex reviews, and the inverse; the Codex reviewer caught a real leak class no fake-based check sees |
| Backup / restore | ✅ drill on real state | archives exclude every credential by rule (`auth.json`, keystores, salts) |
| Security review | ✅ closed | [`docs/security/threat-model.md`](docs/security/threat-model.md) — every control cited to a test; `pnpm audit` clean |

## Quickstart (from this repository)

Requires Node ≥ 22.18 and pnpm; macOS arm64 is the proven platform (Linux pending).

```bash
git clone git@github.com:MubitLabs/mubit-engineering-control.git mec && cd mec
pnpm install                    # native modules build via the pnpm allowlist
(cd apps/web && pnpm build)     # the workbench UI — once, and after UI changes
node apps/desktop/bin/mec.js    # the server; prints http://127.0.0.1:<port>
```

Open the printed URL → **Setup** (the four-step wizard: engines → slot/link or paste key → repository → meta agent), or do it by hand from the **Slots** panel. Then:

1. **Slots** — link an existing Claude login, run a terminal login card for a dedicated slot, or paste an API key (Anthropic / GLM / Gemini). The form is the only door for keys — never chat, never a CLI flag.
2. Restart the server with the meta agent's slot: `MEC_META_SLOT="$HOME/.mec/engines/claude/<label>" node apps/desktop/bin/mec.js`
3. **Chat** — talk to the meta agent; confirmations land in the **Inbox**; work surfaces in **Work**.

The CLI covers the rest (it talks to local state, never a running server):

```bash
node apps/desktop/bin/mec.js status    # health snapshot + setup state
node apps/desktop/bin/mec.js doctor    # probes engines, sandbox, store
node apps/desktop/bin/mec.js slot add|list|probe|retire
node apps/desktop/bin/mec.js update    # version + internal reinstall path (no network, by design)
node apps/desktop/bin/mec.js stop      # intentional stop; restart honours it
```

### Internal tarball instead of a checkout

```bash
pnpm pack:internal               # → dist-internal/mec-<version>.tgz (never publishes)
mkdir mec && tar xzf dist-internal/mec-*.tgz -C mec && cd mec
npm install --omit=dev --ignore-scripts=false   # builds the two native modules
node bin/mec.js
```

A machine that cannot build native modules gets the §21.7 refusal (exit 3) with the fix spelled out — never a stack trace.

## Documentation

- **[User guide](docs/guide.md)** — concepts, the five screens, policy, troubleshooting by symptom
- **Agent guide**: [`AGENTS.md`](AGENTS.md) — the shared entry for coding agents working IN this repo (rules, commands, navigation); workflow detail in [`docs/agent-workflow/`](docs/agent-workflow/)
- **[Reference](docs/reference.md)** — every CLI command, every HTTP route, the policy schema, the fixture library
- **[Known limits](docs/known-limits.md)** — what is honestly absent or defaulted
- **[Security](docs/security/threat-model.md)** — the threat model, control→test citations, residual risks
- **[The spec](docs/plan/PLAN_v4.1_local_meta_agent.md)** — every behaviour question is answered from it
- **[CONTRACTS](docs/handoff/CONTRACTS.md)** — the frozen v0 interface seam (implementation tagged `contracts-v0`)
- **[Handshakes](docs/log/HANDSHAKES.md)** — the real-binary gate record · **[Fault suite](docs/fault-suite.md)** — the §26 evidence matrix
- **[Status](docs/STATUS.md)** — what is verified / on fakes / absent · **[Changelog](docs/CHANGELOG.md)** · **[Contributing](CONTRIBUTING.md)** · **[Setup guide for agents](SETUP.md)**
- **v1 reference**: branch `version-1` (the company-platform predecessor; the domain rules, journal protocol and Claude adapter were ported from it)

## Layout

| Package | What it is |
| --- | --- |
| `packages/contracts` | The frozen v0 seam: events, briefs, reports, bridge, adapters, slots, store/effects, errors, fixtures |
| `packages/domain` | State machines, task-graph validation, impact, caps, blockers, scheduler planning, specialist registry |
| `packages/store` | SQLite store (WAL, nested-rollback atomic, gap-free event log) + effects queue + health board |
| `packages/runtime` | Supervisor, agent environment (§5.12), journal (fsync/ack/replay), shims+gitconfig, checks, isolation settings |
| `packages/engines` | The three engine adapters; Claude and Codex run on real recordings, OpenCode in progress |
| `packages/slots` | Credential homes, keystore courier, slot lifecycle, probes, compliance guard, redaction |
| `packages/mec-tools` | The MCP server agents talk to (tokens, role-fenced tools, permission bridge) |
| `packages/meta` | Wake/note classifier, routing, escalation, acknowledgements, hand-back |
| `packages/policy` | Policy doc, confirmation classes, CAS resolve (expiry is never consent) |
| `packages/prompts` | Prompt bundles: layers, provenance, pinned revisions, upgrade diffs |
| `packages/integration` | Integration queue planning, PR flow state machine, yield-to-duplicate |
| `packages/failover` | Slot failover orchestration across attempts (handoffs between slots) |
| `packages/scorecards` | The §24 scorecards: daily-use evidence, zero-lost-work accounting |
| `packages/git` | Clone cache, worktrees, merges, mid-merge conflict repair |
| `packages/testkit` | MemoryRepositories, FakeEngine, and the fixture library (`fixtures/` — real recorded engine streams) |
| `apps/desktop` | The `mec` launcher (serve + status/stop/restart/doctor/slot/update), backup/restore/retention, the server |
| `apps/web` | The workbench: chat, inbox, work view, slots, setup wizard |

## Development

```bash
pnpm install
pnpm check        # typecheck + lint + both test suites (~1,450 tests)
pnpm test:a       # core-side suite
pnpm test:b       # engine/runtime-side suite
pnpm build:desktop   # both bundles: dist/mec.mjs (server) + dist/mec-cli.mjs (CLI)
```

Real-engine canaries are gated behind env vars so CI never spends quota: `MEC_REAL_ENGINE=1` (Claude), `MEC_REAL_CODEX=1`, `MEC_REAL_OPENCODE=1`. CI runs on the org's self-hosted runners (`mubit-any` label).

The review rule that matters (§7.2): a test that mocks its own unit is rejected; cross-review before merge; gates never pass on fakes.

## Security posture, in one paragraph

The server binds loopback only, rejects non-local origins and requires a custom header from browser-shaped mutations (§22); the MCP tools server authenticates every call with an attempt-scoped token. Agents run sandboxed with read-deny defaults over MEC state and slot homes, repository-resident engine config is untrusted, and everything is redacted before durability. Backups exclude credentials by rule — a stolen archive re-probes slots instead of leaking keys. Known residual risks are stated, not hidden, in the threat model.

## Licence

Apache-2.0 ([LICENSE](LICENSE); [NOTICE](NOTICE.md) lists third-party dependencies). The engine binaries MEC launches are the user's own tools under their own vendor terms.

## Rules that survive context compaction

See `CLAUDE.md` at the root. The two that matter most: never read a vendor OAuth store or write a credential anywhere; when behaviour is unclear, cite the plan section and ask — never guess.
