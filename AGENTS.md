# Agent guide — MEC (Mubit Engineering Control)

This is the shared entry for every coding agent working in this repository (Codex, OpenCode, Cursor and friends read this file; Claude Code additionally reads `CLAUDE.md`). It carries this repo's rules, not generic advice. The README covers what the product is; this file covers how to work here safely.

## Non-negotiables

1. **Never read a credential.** No vendor OAuth store (`~/.claude/.credentials.json`, `~/.codex/auth.json`, anything under a slot home's `keys/` — `*.key`, `.salt`), no key in a message, a log, a commit, a fixture, or a test. Keys enter only through the workbench Slots form / the keystore API; code reads them only via `SlotKeystore.read()` at launch. If a task seems to need a key's bytes, it is wrong — stop and say so.
2. **The plan is the source of truth for behaviour.** `docs/plan/spec.md`. When behaviour is unclear, cite the section number and ask — never guess, never invent a standard to fill a template.
3. **`packages/contracts` is frozen** (tag `contracts-v0`). A change there needs the matching fixture update and a line in `docs/handoff/CONTRACTS.md` §10. Additive changes (a new optional field, a new pattern) are the safe direction.
4. **Gates never pass on fakes.** Real-binary evidence lives in `docs/log/HANDSHAKES.md`; the fault matrix is `docs/fault-suite.md`. A test that mocks its own unit is rejected (§7.2 — cross-review before merge).
5. **Secrets never become durable.** Redaction runs before any write (contracts `SECRET_PATTERNS` → `redact()`/`redactEvent()`). Chat pastes of key-shaped strings are stored redacted by design.
6. **The `.mec/` exclusion in `commitAll` is load-bearing** — attempt artifacts (settings, attempt-scoped tokens) must never enter a task commit. Don't "fix" it away.

## Commands

Native (authoritative): `pnpm install` · `pnpm check` (typecheck + lint + both suites — the full gate) · `pnpm test:a` / `pnpm test:b` · `pnpm build:desktop` · `pnpm pack:internal`.

Shared wrapper (any agent, no pnpm knowledge needed): `python3 tools/repo-kit/run.py list|setup|check|test|verify|smoke` and `--area engines|desktop|web` for a lane's tests. `verify` = `check`. Null actions fail loudly as unconfigured — never substitute a dummy passing command.

Real-engine canaries are **gated and never run in CI or wrappers** (they spend real quota): `MEC_REAL_ENGINE=1` (Claude), `MEC_REAL_CODEX=1`, `MEC_REAL_OPENCODE=1`, with the slot env vars each canary file documents.

## Navigation — canonical sources, don't duplicate them

| Need | Canonical |
| --- | --- |
| Behaviour questions | `docs/plan/spec.md` (the spec) · `docs/plan/product-plan.md` (releases/gates) |
| Interfaces | `docs/handoff/CONTRACTS.md` + `packages/contracts` |
| What is proven / on fakes / absent | `docs/STATUS.md` · `docs/log/HANDSHAKES.md` · `docs/fault-suite.md` |
| Layout & quickstart | `README.md` |
| Dev loop, fixtures, engine contract, review rules | `CONTRIBUTING.md` |
| CLI / HTTP API / policy schema | `docs/reference.md` |
| Engine facts & pinned versions | `docs/engines.md` (claude 2.1.317 · codex-cli 0.148.0 · opencode 2.2.5 and 2.2.6) |
| Security | `docs/security/threat-model.md` · `docs/known-limits.md` |
| Owner decisions | `docs/DECISIONS.md` (incl. #8: standing operator authority during the build) |
| Agent-guided first run | `SETUP.md` |
| Workflow detail | `docs/agent-workflow/` (architecture map, baseline, constraints, parallel work) |

## Working rules

- **Scope to the request.** No framework migrations, dependency upgrades, rewrites or publications unless the task says so.
- **Reuse the boundaries**: the package layout in the README is the dependency map — engines never import the store, the store never imports engines, `packages/contracts` is the only seam both see.
- **A substantial change keeps a change record** in `docs/changes/<change-id>/` (`CHANGE.md` + `VERIFICATION.md`) — what, why, evidence. Owner-level decisions go to `docs/DECISIONS.md`; gate results to `docs/log/HANDSHAKES.md`.
- **Record reality, not intent**: baseline and verification docs state exact commands and outcomes; a pre-existing failure stays visible, separate from new ones.
- **Parallel sessions**: the store is single-writer (`~/.mec`, O_EXCL lock — a second server refuses). Work disjoint lanes (packages vs apps) and never edit another session's in-flight files. Remote effects (push/PR/merge) go through the confirmation cards in `apps/desktop/src/release.ts` — never raw `gh` calls.
- **Fixtures discipline**: real recordings are redaction-swept, `recorded_by: 'real'`, and honest about what stayed synthetic and why (`meta.json` notes).
