# Development setup

Status: **discovered**. Canonical contributor guide: `CONTRIBUTING.md`; quickstart: `README.md`. This file is the agent-facing short form with the verified values.

| Item | Verified value |
| --- | --- |
| Runtime | Node ≥ 22.18 (repo dev runs 25.x); pnpm 10.x workspaces |
| Setup | `pnpm install` (root; native modules better-sqlite3 + node-pty build via `pnpm.onlyBuiltDependencies`) |
| Dependency manager / lockfile | pnpm, `pnpm-lock.yaml` — never swap managers, never upgrade deps as scaffolding |
| Local services | none — SQLite on disk; the server binds an ephemeral loopback port and prints the URL |
| Full gate | `pnpm check` = typecheck (all workspaces) + biome + both suites (~1,456 tests) |
| Focused lanes | `pnpm test:a` / `pnpm test:b`; area tests via `python3 tools/repo-kit/run.py test --area engines\|desktop\|web` |
| Builds | `pnpm build:desktop` (both bundles) · `(cd apps/web && pnpm build)` for the workbench UI · `pnpm pack:internal` for the tarball |
| Real-engine canaries | gated, never in CI: `MEC_REAL_ENGINE=1`, `MEC_REAL_CODEX=1`, `MEC_REAL_OPENCODE=1` (+ the slot env each file documents); they spend real quota — run only when a gate requires it |
| Smoke | `node apps/desktop/bin/mec.js doctor` (probes the real local binaries; no server needed) |

No `.env` is used anywhere; configuration travels as environment variables documented at the point of use (e.g. `MEC_META_SLOT`, `MEC_DATA_DIR`).
