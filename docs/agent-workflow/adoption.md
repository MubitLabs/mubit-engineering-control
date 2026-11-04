# Adoption record — brownfield agent kit

Date: 2026-11-04. Kit: `brownfield-agent-kit.zip` (32 files, `MANIFEST.sha256` verified; `kit.py` reviewed before use — stdlib only, exclusive-create writes, no network, no exec).

## How it was adopted

`kit.py plan` → 15 additions, 0 conflicts → `kit.py apply` (existing files untouched). Then the deliberate merge, per the handoff's own rules:

**Added and filled from discovery:** root `AGENTS.md` (the shared cross-tool entry — this repo previously had only `CLAUDE.md`); `.repo-kit/commands.json` wired to the native commands (`setup`=pnpm install, `check`=pnpm check, `test`=both suites, `smoke`=`mec doctor`; areas engines/desktop/web; `integration` deliberately null — the real-engine gates never run from wrappers); `tools/repo-kit/run.py` (the wrapper the kit ships).

**Merged, not duplicated:** `docs/agent-workflow/*` — each page carries this repo's discovered facts and links the canonical doc (`README.md`, `CONTRIBUTING.md`, `docs/STATUS.md`, `docs/engines.md`, `docs/known-limits.md`, `docs/handoff/CONTRACTS.md`) instead of competing with it.

**Linked/reused:** `docs/decisions/README.md` → canonical `docs/DECISIONS.md`; the change-record convention `docs/changes/` complements (not replaces) `docs/log/HANDSHAKES.md` (gates) and `docs/CHANGELOG.md` (releases).

**Deferred:** none. The greenfield kit was not adopted — this is an established repo; nothing from it applies.

## Verification

- `python3 tools/repo-kit/run.py list` → the wired interface; `verify` → `pnpm check` (exit 0, 1,456 tests).
- `pnpm check` green at adoption (see `baseline.md`).
- Kit self-tests: 20/21 pass; the one failure is a macOS `/private/var` vs `/var` symlink artifact inside the kit's own unit test (temp-dir path comparison) — not the installed wrapper, which passed `list` and `smoke` against this repository.
- Instruction loading: `CLAUDE.md` imports `AGENTS.md`; Codex/OpenCode read `AGENTS.md` natively (`compatibility.md`).
