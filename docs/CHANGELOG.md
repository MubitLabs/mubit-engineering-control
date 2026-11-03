# Changelog

## 0.1.0 (unreleased)

Internal build, week 1 (3 November 2026). Seeded from [`docs/log/week1.md`](log/week1.md) and [`docs/log/HANDSHAKES.md`](log/HANDSHAKES.md); behaviour of record is the plan.

### Foundations

- Monorepo `MubitLabs/mec` created from the hand-off kit: pnpm workspaces, TypeScript strict, Biome, Vitest projects `a`/`b`, CI (`static`, `suite-a`, `suite-b` on Node 22 and 24), CODEOWNERS.
- Contracts v0 (`packages/contracts`) written, reviewed against B's recorded Claude streams, tagged `contracts-v0` and frozen: events, briefs, reports, bridge, adapters, slots, store/effects, errors, fixtures — all Zod schemas with valid/invalid samples, no credential field anywhere.
- SQLite store (WAL, nested-rollback atomic, gap-free event log) with numbered migrations; effects queue with coalescing, backoff, `Later`, per-kind health; health board with one writer per entry.
- Domain port from v1: state machines, task-graph validation, impact summaries, caps, scheduler planning, specialist registry; stage table first-match tested row by row.

### Engines

- Claude adapter running the real binary headless (stream-json, permission bridge via `mcp__mec__confirm`, `rate_limit_event` normalisation, capability probe); conformance-proven on four real recordings.
- Codex adapter on the REAL ChatGPT login (R2.1): protocol reconciled to codex-cli 0.148.0, real recordings for smoke/permission/auth-expiry, gated canary green. OpenCode adapter on the REAL GLM Coding Plan + Gemini slots (R2.2): config-file providers with `{env:}` key substitution, real SSE protocol shapes, both live slots validate healthy. The rate-limit fixtures stay synthetic, honestly noted.
- Vendor-reality finding logged: `node-pty-prebuilt-multiarch@^1.0.0-beta` is not published; login cards ship with an injectable `ptySpawn` seam and a loud `pty unavailable` default.

### Runtime

- Journal port: per-append fsync, atomic ack cursor, torn-line-safe load, strict sequence refusal.
- Agent environment per §5.12 (allowlist is the scrub; exact-key-set test), supervisor (argv-only, process groups, SIGTERM→SIGKILL→confirm-gone, `(attempt, generation)` ownership), command shims + per-attempt gitconfig with hash manifest and foreign-file refusal.
- Isolation settings builder (Claude Code sandbox profile, Codex workspace-write, OpenCode permissions); checks on exact SHAs; park classification from engine events (quota/auth/provider).

### App

- Slot layer: credential homes, keystore courier (0600, fingerprint-only in the database, rotation, shred on retire), probes, redaction for every provider key shape.
- `mec` launcher with the §21.2 status contract (exit 0–3), intentional-stop marker and `restart --respect-stop`, `doctor` redacted by construction; one writer per state directory (O_EXCL lock, stale-pid recovery).
- Composition server (Fastify, loopback only) with chat intake and idempotency replay, confirmation inbox with compare-and-set resolve, work views, slots routes, login cards (serialised, bounded, live-only stream), SSE events; the workbench views (chat, inbox, work, slots, settings).
- Meta-agent rules (acks, routing, escalation, wake-vs-note), policy/guardrails with CAS confirmations and only-tighten repo overrides, prompt bundles with revisions and upgrade diffs, merge/conflict primitives, backup/restore with credential exclusion rules and drill, retention planning.
- §23 acceptance chain green on the bundled binary with the fake engine: message → ack → two-task plan → dependency-aware launch → duplicate idempotency replay. Caught and fixed the `x-idempotency-key` header seam and the pnpm-10 native-postinstall block that broke Linux CI.

### Gates H1 + H3

- **H0 contracts frozen — passed.** Both suites green on macOS and the Linux self-hosted runners.
- **R0 audit — passed** (cold clone, fresh reviewer instance): `pnpm install` + `pnpm check` green (1,361 tests); env scrub verified against a real child process; redaction verified for all five provider key shapes; compliance guard fails on a planted violation; two servers refuse one data directory. Findings filed (test-quality survey clean; `expectedInputSha` route bug found and fixed same day).
- **H1 one attempt end to end — passed** on the real binary (Claude Code 2.1.317, dedicated slot, macOS arm64): real attempt with a live `rate_limit_event`, journal appended, the sandbox denied reading `~/.ssh`, a permission request round-tripped through `mcp__mec__confirm`, checks passed on the head SHA.
- **R1.4 real meta brain — passed**: a real meta-agent turn made tool-mediated decisions (`mcp__mec__acknowledge`, `mcp__mec__propose_plan`) through the live mec-tools server.
- **H3 the §23 flow on a real GitHub repository — passed** (`MubitLabs/mec-sandbox`, branch protection strict + admin-enforced): implementer on a pinned worktree, integration `--no-ff` with checks on the exact merge SHA, then three approved cards — push, PR create (CI green), merge reported `merged` only after GitHub's state said `MERGED`.
- Not run: H2 (real request via chat through a real login), H4 (fault suite + Codex), H5 (full acceptance, mixed engines).

### Security

- No credential in any schema, event, journal or store doc: secret-field lint on contracts, pattern redaction for every provider key shape plus keystore fingerprints, secrets-in-chat guard (redact before durability, answer with the Slots pointer).
- Env scrubbing proven against a real child process; shims and gitconfig refuse foreign files; mec-tools tokens are attempt-scoped and role-fenced over real loopback HTTP.
- Compliance guard: static scan for reads of vendor credential stores, plus a self-scan over the product source in CI; verified by planting a violation on a throwaway branch.
- Repository-resident engine configuration treated as untrusted (no project settings, hooks, MCP servers or plugins from a cloned repo unless it is marked trusted).

### R1 completion + the R2 wave (3 Nov, evening — single operator)

- **R1.3–R1.7**: real node-pty login cards; the real meta brain (tool-mediated turns over the in-process MCP server); API-key slots end to end; the §26 composition rows closed (35/38 proven).
- **H3**: the §23 delivery on `mec-sandbox` — PR #2 merged GitHub-confirmed behind three approved cards.
- **H4 + R2.3**: mixed-engine delivery in BOTH pairings (Claude implements + Codex reviews; Codex implements + Claude reviews) — PRs #3/#4 merged; the Codex reviewer caught the `.mec` attempt-artifact leak class, fixed in `commitAll` and proven live; the restore drill ran against the real state dir with every credential excluded by rule.
- **R2.4/R2.5/R2.8**: `mec slot` CLI + internal tarball; first-run wizard; user guide, reference, CONTRIBUTING.
- **R2.7 + hardening**: threat model with every control cited to a test; the two High gaps (§22 origin/CSRF discipline, secrets-in-chat route test) closed the same day; `pnpm audit` clean.
- **Courier**: GLM + Gemini keys accepted (intake is a structure check, not a format oracle — vendor formats drift); live keys stored via the form only and validated healthy.
- **Repo readiness**: full Apache-2.0 LICENSE + NOTICE at root (tarball copies both verbatim); §21.1 CLI dispatch wired (`mec status|stop|restart|doctor|slot|update` from `bin/mec.js`).
