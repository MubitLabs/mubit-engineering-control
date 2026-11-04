# MEC — Mubit Engineering Control

A local meta-agent orchestration app. Connect your coding agents (Claude Code, Codex, OpenCode), talk to one meta agent, and it plans, spawns specialists, and runs the delivery loop — worktrees → checks → review → integration → PR — interrupting you only for guardrail confirmations.

**Fully local**: SQLite on your machine, no cloud, no telemetry. Credentials never leave the machine: engine logins live in isolated slot homes, API keys in per-slot keystores (`0600`), and the database holds fingerprints, never secrets. Nothing crosses the network without a confirmed card — push, PR and merge each wait for your click.

> Open source under Apache-2.0; built for Mubit's own use; no support promised; issues welcome, PRs reviewed when we can.

## Install

Requirements: macOS or Linux · Node ≥ 22.18 · at least one coding agent installed and signed in (Claude Code, Codex CLI, or OpenCode) · `gh` signed in if you want MEC to open pull requests.

```bash
curl -fsSL https://github.com/MubitLabs/mubit-engineering-control/releases/latest/download/install.sh | bash
```

Read it first — it is [40 lines](scripts/install.sh), stdlib only, no sudo: it installs the release tarball into `~/.mec/app`, builds the two native modules, and links `mec` into `~/.local/bin`. Then run `mec`: the workbench opens in your browser straight into **Setup**, which finds your installed agents, lets you link an existing login or sign in to a dedicated one (through the vendor's own flow — MEC never sees a token), paste an API key if you use GLM or Gemini, register a repository, and pick which slot runs the meta agent. Two minutes, no terminal.

From source instead:

```bash
git clone https://github.com/MubitLabs/mubit-engineering-control.git mec && cd mec
pnpm install && pnpm build:desktop && (cd apps/web && pnpm build)
node apps/desktop/bin/mec.js          # → prints the URL, opens Setup on first run
```

`mec --no-open` for scripts and CI; `mec --version`, `mec doctor`, `mec status`, `mec stop` from any terminal.

Then: talk to the meta agent in **Chat**; approve pushes, PRs and merges in the inbox; watch the work in **Work**.

## Engine versions

The fixtures and gates were recorded against these exact versions (`docs/engines.md` carries the full findings):

| Engine | Proven on | Status |
| --- | --- | --- |
| Claude Code | 2.1.317 | ✅ real recordings + live canaries (H1, H3, H4) |
| Codex CLI | 0.148.0 | ✅ real recordings + live canary (R2.1) |
| OpenCode | 2.2.5 | ✅ real recordings + live canary (R2.2) |

## Status

Every engine claim in the table above was proven against the real binary on a real account — recorded fixtures, live canaries, and full deliveries merged behind user-approved confirmation cards (one of them caught by the cross-engine reviewer catching a leak no automated check saw). Gates never passed on fakes.

- **What is verified, what runs on synthetic fixtures, what is absent**: [`docs/STATUS.md`](docs/STATUS.md)
- **The gate record with its limits**: [`docs/log/HANDSHAKES.md`](docs/log/HANDSHAKES.md) · the fault matrix: [`docs/fault-suite.md`](docs/fault-suite.md)
- **Security posture and residual risks**: [`docs/security/threat-model.md`](docs/security/threat-model.md) (every control cited to a test; `pnpm audit` clean)
- **Backups**: drill-verified on real state — archives exclude every credential by rule

## Documentation

- **[User guide](docs/guide.md)** — concepts, the five screens, policy, troubleshooting by symptom
- **Agent guide**: [`AGENTS.md`](AGENTS.md) — the shared entry for coding agents working IN this repo (rules, commands, navigation); workflow detail in [`docs/agent-workflow/`](docs/agent-workflow/)
- **[Reference](docs/reference.md)** — every CLI command, every HTTP route, the policy schema, the fixture library
- **[Known limits](docs/known-limits.md)** — what is honestly absent or defaulted
- **[Security](docs/security/threat-model.md)** — the threat model, control→test citations, residual risks
- **[The spec](docs/plan/spec.md)** — every behaviour question is answered from it
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

Real-engine canaries are gated behind env vars so CI never spends quota: `MEC_REAL_ENGINE=1` (Claude), `MEC_REAL_CODEX=1`, `MEC_REAL_OPENCODE=1`. CI runs on GitHub-hosted runners (`ubuntu-latest`/`macos-latest`).

The review rule that matters (§7.2): a test that mocks its own unit is rejected; cross-review before merge; gates never pass on fakes.

## Security posture, in one paragraph

The server binds loopback only, rejects non-local origins and requires a custom header from browser-shaped mutations (§22); the MCP tools server authenticates every call with an attempt-scoped token. Agents run sandboxed with read-deny defaults over MEC state and slot homes, repository-resident engine config is untrusted, and everything is redacted before durability. Backups exclude credentials by rule — a stolen archive re-probes slots instead of leaking keys. Known residual risks are stated, not hidden, in the threat model.

## Licence

Apache-2.0 ([LICENSE](LICENSE); [NOTICE](NOTICE.md) lists third-party dependencies). The engine binaries MEC launches are the user's own tools under their own vendor terms.

## Rules that survive context compaction

See `CLAUDE.md` at the root. The two that matter most: never read a vendor OAuth store or write a credential anywhere; when behaviour is unclear, cite the plan section and ask — never guess.
