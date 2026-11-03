# MEC — Mubit Engineering Control v4.1

A local meta-agent orchestration app: connect your coding agents (Claude Code, Codex, OpenCode), talk to one meta agent, and it plans, spawns specialists, runs the delivery loop (worktrees → checks → review → integration → PR), interrupting you only for guardrail confirmations. Fully local: SQLite, no cloud, credentials never leave the machine.

- **The spec**: [`docs/plan/PLAN_v4.1_local_meta_agent.md`](docs/plan/PLAN_v4.1_local_meta_agent.md) — every behaviour question is answered from it
- **The interfaces**: [`docs/handoff/CONTRACTS.md`](docs/handoff/CONTRACTS.md) (implementation tagged `contracts-v0`) — `packages/contracts` is the shared seam
- **User guide**: [`docs/guide.md`](docs/guide.md) · **Reference** (CLI, HTTP API, policy, fixtures): [`docs/reference.md`](docs/reference.md) · **Changelog**: [`docs/CHANGELOG.md`](docs/CHANGELOG.md)
- **Contributing**: [`CONTRIBUTING.md`](CONTRIBUTING.md) — licence, layout, dev loop, fixtures, engines, review rules
- **Build log**: [`docs/log/`](docs/log/) · **Setup guide for agents**: [`SETUP.md`](SETUP.md)
- **v1 reference**: branch `version-1` (the company-platform predecessor; the domain rules, journal protocol and Claude adapter were ported from it)

## Layout

| Package | What it is |
| --- | --- |
| `packages/contracts` | The frozen v0 seam: events, briefs, reports, bridge, adapters, slots, store/effects, errors, fixtures |
| `packages/domain` | State machines, task-graph validation, impact, caps, blockers, scheduler planning, specialist registry |
| `packages/store` | SQLite store (WAL, nested-rollback atomic, gap-free event log) + effects queue + health board |
| `packages/runtime` | Supervisor, agent environment (§5.12), journal (fsync/ack/replay), shims+gitconfig, checks, isolation settings |
| `packages/engines` | Claude adapter (conformance-proven on real recordings) + Codex + OpenCode |
| `packages/slots` | Credential homes, keystore courier, slot lifecycle, probes, compliance guard, redaction |
| `packages/mec-tools` | The MCP server agents talk to (tokens, role-fenced tools, permission bridge) |
| `packages/meta` | Wake/note classifier, routing, escalation, acknowledgements, hand-back |
| `packages/policy` | Policy doc, confirmation classes, CAS resolve (expiry is never consent) |
| `packages/prompts` | Prompt bundles: layers, provenance, pinned revisions, upgrade diffs |
| `packages/integration` | Integration queue planning, PR flow state machine, yield-to-duplicate |
| `packages/git` | Clone cache, worktrees, merges, mid-merge conflict repair |
| `packages/testkit` | MemoryRepositories, MemoryCoreForEngines, FakeEngine, and the fixture library (`fixtures/` — real recorded engine streams) |
| `apps/desktop` | The `mec` launcher (status/stop/restart/doctor), backup/restore/retention, the server |
| `apps/web` | The workbench: chat, inbox, work view, slots, settings |

## Development

```bash
pnpm install
pnpm check        # typecheck + lint + both test suites
pnpm test:a       # core-side suite
pnpm test:b       # engine/runtime-side suite
```

CI runs on the org's self-hosted runners (`mubit-any` label).

## Rules that survive context compaction

See `CLAUDE.md` at the root. The two that matter most: never read a vendor OAuth store or write a credential anywhere; when behaviour is unclear, cite the plan section and ask — never guess.
