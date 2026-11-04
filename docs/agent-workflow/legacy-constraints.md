# Legacy constraints and compatibility boundaries

Facts that constrain changes, with sources. The canonical honest-limits list is `docs/known-limits.md`; engine reality is `docs/engines.md`.

## Frozen interface

- `packages/contracts` is frozen at tag `contracts-v0`. Any change: additive direction, matching fixture update, a `docs/handoff/CONTRACTS.md` §10 line. `SECRET_PATTERNS` gained `google-auth` (2026-11-03) — the documented precedent for an additive change.

## Engine protocol pins (adapters encode REAL observed shapes)

- **Claude Code 2.1.317**: UUID session ids; no `--input-format stream-json` for one-shot `-p`; `--allowedTools mcp__mec__*` needed because `--permission-prompts none` blocks MCP tools; settings/mcp paths travel via `brief.env.MEC_SETTINGS_PATH`/`MEC_MCP_CONFIG_PATH`.
- **codex-cli 0.148.0**: turn params are input arrays; approvals are server→client requests answered as JSON-RPC responses; usage nests in `tokenUsage.total`; the app-server never exits on its own (exit is synthesized per the crash rule); a same-process sync exec freezes the in-process MCP tools server — probes spawn async.
- **opencode 2.2.5**: `serve --port 0 --stdio`; config-file providers with `{env:VAR}` key substitution; a permission reply posted from outside the SSE read loop stalls the turn forever — the round trip must run inside the pump.
- The vendors drift (z.ai split key types Oct 2026; Google is mid `AIza…`→`AQ.Ab…` transition) — intake gates are structure checks, not format oracles; exact patterns belong to redaction only.

## gh / GitHub

- `gh repo view` takes the repo positionally (not `-R`); `pr create/checks -R` is valid.
- Check states report UPPERCASE; a superseded run reports `CANCELLED` between check-suite updates — the merge card refuses any non-green read (correct; retry with a fresh card).
- `--body-file -` needs stdin closed or gh hangs; branch-protection contexts must equal the check-run name exactly.
- Merges are confirmed by GitHub state (`MERGED`), never the call's exit code.

## Product invariants

- Single-writer store: one server per `~/.mec` (O_EXCL lock); the CLI never talks to a running server.
- Slot isolation: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / XDG homes; the linked default Claude home runs with the variable unset.
- Backups exclude every credential by rule; a restore re-probes slots instead of carrying keys.
- `commitAll` pathspec-excludes `.mec/` (status and add) — attempt artifacts never enter task commits.

## v1 lineage (branch `version-1`)

The domain rules, journal protocol and Claude adapter were ported from it; that branch is reference-only, do not build on it.
