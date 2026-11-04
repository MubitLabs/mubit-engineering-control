# Existing verification baseline

Status: **established** 4 Nov 2026. Refresh the table (and the revision) whenever you take the repo over for a new task; never convert an unknown or unexecuted check into a pass.

Base revision: `main` at `e5ae484` (clean tree)
Environment: macOS arm64, Node 25.8.2, pnpm 10.x; CI mirrors on self-hosted Linux runners (`mubit-any`)
Baseline scope: full repository

| Exact command | Outcome | Scope | Prerequisites / known state |
| --- | --- | --- | --- |
| `pnpm check` | **exit 0** — 115 test files (111 passed, 4 skipped), 1456 tests passed, 12 skipped | typecheck (all workspaces) + biome + both suites | The 12 skips are the gated real-engine canaries (`MEC_REAL_*`) and the bundle boot smoke when `dist/` is absent — by design, never a quiet pass |
| `pnpm build:desktop` | exit 0 — `dist/mec.mjs` + `dist/mec-cli.mjs` | both bundles | esbuild; native modules stay external by design |
| `node apps/desktop/bin/mec.js doctor` | exit 0 — probes claude 2.1.317, codex-cli 0.148.0 | real local binaries | a running server is not required (CLI talks to local state only) |
| `python3 tools/repo-kit/run.py verify` | exit 0 (wraps `pnpm check`) | the shared agent interface | Python 3.9+ stdlib only |

Pre-existing, non-failing noise: ~9 biome lint warnings (unused imports/params in older engine files, one useless ternary) + 1 info — warnings do not fail the gate; fix opportunistically when touching the file anyway, no drive-by lint commits.

Known-absent: Linux cold-clone run and the Linux sandbox row (second machine, §26); the natural-capture fixtures (Claude `allowed_warning`, a real Gemini 429) — all tracked in `docs/STATUS.md`.
