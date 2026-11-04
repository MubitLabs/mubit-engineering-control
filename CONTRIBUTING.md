# Contributing to MEC

Open source under Apache-2.0; built for Mubit's own use; no support promised; issues welcome, PRs reviewed when we can.

MEC (Mubit Engineering Control) is an internal, free-forever product (owner decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md)). The behaviour of record is the plan — [`docs/plan/spec.md`](docs/plan/spec.md); the frozen interface of record is [`docs/handoff/CONTRACTS.md`](docs/handoff/CONTRACTS.md) (tag `contracts-v0`). When behaviour is unclear, cite the plan section and ask — never guess.

## Licence

The project is **Apache-2.0** (patent grant included), with a `NOTICE` file for third-party dependencies; redacted fixtures may be public. Decision #1 in [`docs/DECISIONS.md`](docs/DECISIONS.md) is the record of this; the `LICENSE`/`NOTICE` files land with the internal packaging milestone (R2.4 — private registry / git install, not public npm).

## Layout

| Package | One line |
| --- | --- |
| `packages/contracts` | The frozen v0 seam: events, briefs, reports, bridge, adapters, slots, store/effects, errors, fixtures |
| `packages/domain` | State machines, task-graph validation, impact, caps, blockers, scheduler planning, specialist registry |
| `packages/store` | SQLite store (WAL, nested-rollback atomic, gap-free event log) + effects queue + health board |
| `packages/runtime` | Supervisor, agent environment, journal, shims+gitconfig, checks, isolation settings |
| `packages/engines` | Claude adapter (conformance-proven on real recordings) + Codex + OpenCode |
| `packages/slots` | Credential homes, keystore courier, slot lifecycle, probes, compliance guard, redaction |
| `packages/mec-tools` | The MCP server agents talk to (tokens, role-fenced tools, permission bridge) |
| `packages/meta` | Wake/note classifier, routing, escalation, acknowledgements, hand-back |
| `packages/policy` | Policy doc, confirmation classes, CAS resolve (expiry is never consent) |
| `packages/prompts` | Prompt bundles: layers, provenance, pinned revisions, upgrade diffs |
| `packages/integration` | Integration queue planning, PR flow state machine, yield-to-duplicate |
| `packages/git` | Clone cache, worktrees, merges, mid-merge conflict repair |
| `packages/testkit` | MemoryRepositories, MemoryCoreForEngines, FakeEngine, and the fixture library |
| `apps/desktop` | The `mec` launcher, backup/restore/retention, the composition server |
| `apps/web` | The workbench: chat, inbox, work view, slots, settings |

Two rules that survive context compaction (see `CLAUDE.md`): never read a vendor OAuth store or write a credential anywhere; cite the plan section when unsure. The compliance guard (`packages/slots`) scans the source for reads of `.credentials.json`, `auth.json`, `opencode.db` credentials and Keychain items — a planted violation fails CI, and so will a real one.

## The development loop

```bash
pnpm install        # pnpm 10; native builds allowlisted (better-sqlite3, esbuild, node-pty)
pnpm check          # typecheck + lint + the whole test suite — every milestone lands green
pnpm test:a         # core-side suite (contracts and conformance run in both)
pnpm test:b         # engine/runtime-side suite
pnpm -s exec vitest run <file>   # one file while iterating
```

**Commit hygiene:** subject ≤ 72 characters, the narrative in the body — long-form detail
belongs in [`docs/log/`](docs/log/). The PR template carries the checklist.

Log the work: [`docs/log/week1.md`](docs/log/week1.md) carries the seam log; [`docs/log/HANDSHAKES.md`](docs/log/HANDSHAKES.md) records each gate's demo honestly (a gate not yet run says so); [`docs/fault-suite.md`](docs/fault-suite.md) tracks every §26 row's evidence and gaps — update the row you touched.

## Recording a fixture

Fixtures are the only evidence an adapter is trusted against (§7.1: `recorded_by: 'real'` is required for any row marked proven). The discipline:

1. **Record the real stream.** Run the engine's documented headless interface with a real binary on a dedicated slot and capture its own output verbatim (`raw.jsonl`).
2. **Redact before it is durable.** Every provider key pattern and keystore fingerprint is scrubbed before anything is written; the recorder fails on any residual match. A recording that cannot be redacted honestly is not committed.
3. **Emit `events.jsonl` + `meta.json`.** The adapter's normalised `EngineEvent`s (no `seq`/`at`/`attempt_id`/`generation` — the replayer assigns them) and the metadata: `{ engine, engine_version, scenario, recorded_at, recorded_by, redacted: true, expected, notes? }` with `expected` asserting reports, permission-request count, rate-limit windows and exit reason.
4. **Be honest about provenance.** `recorded_by: 'real'` only for a real binary you actually ran; a stream synthesised from documented protocols is `recorded_by: 'fake'` — useful, and never called real. The directory is `packages/testkit/fixtures/<engine>/<engine_version>/<scenario>/`.

Today's Claude fixtures are `real`; every Codex and OpenCode recording is `fake`. Synthetic recordings are how a new engine starts; real recordings are how it ships.

## Adding an engine

1. **Implement the adapter contract** (`docs/handoff/CONTRACTS.md` §4, `packages/contracts/src/adapter.ts`): `probe` (capabilities + auth health, honestly reported), `launch` / `send` / `interrupt` / `stop` / `events`, `classify(error)` → quota / auth / provider_down / engine_bug / repo_failure, and `mapReport(final)` into the closed report vocabulary. The runtime builds env/shims/gitconfig/worktree; the adapter builds argv, engine config files and MCP config, and starts the process inside the runtime's process group.
2. **Record the eleven scenarios** before the engine's handshake: `smoke`, `permission_request`, `rate_limit_warning`, `rate_limit_rejected`, `auth_expired`, `provider_down`, `max_turns`, `report_ready_with_question`, `report_blocked`, `report_dropped`, `crash_mid_turn` — plus provider error bodies under `providers/<provider>/`.
3. **Pass conformance** (`packages/engines/test/stream-conformance.test.ts`, both suites): parsing each `raw.jsonl` yields its `events.jsonl`, the `FakeEngine` replay yields the same events, the stream invariants hold (one `session_started` first, one `exit` last, `seq` strictly increasing, no key-shaped text), and `meta.expected` matches.
4. **Verify on install.** Probe the installed version before using any flag; unproven flags are reported unsupported. Pin the engine version per slot and record what you verified in [`docs/engines.md`](docs/engines.md).

Vendor terms bind the adapter design (§5.11): unmodified binary, documented interfaces only, the user's own credential in its own home — no cross-vendor subscription use.

## Review rules

From [`docs/plan/product-plan.md`](docs/plan/product-plan.md) §7.2:

- **Cross-review.** Every PR is reviewed by the other stream's person or instance (single-operator mode: a fresh instance, not the author's own context). The audit gate repeats, lighter, before R1 and R2.
- **Tests that mock their own unit are rejected.** Tests written by the author of the code count only when they consume shared fixtures or contract schemas. A test that mocks the unit under test is not evidence — use the fixture library, `MemoryRepositories`, or a recorded stream.
- **Real evidence for real claims.** Rows in [`docs/fault-suite.md`](docs/fault-suite.md) name the test file and the provenance (real fixture / synthetic fixture / no fixture); `recorded_by: 'real'` is required before anything is called proven on an engine.
