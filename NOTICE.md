# NOTICE

mubit-engineering-control
Copyright 2026 Mubit Engineering. Licensed under the Apache License, Version 2.0.

This product is internal to the company (owner decision #4, `docs/DECISIONS.md`):
distribution is via the repository and the internal tarball (`pnpm pack:internal`),
never a public registry.

## Third-party packages

Runtime dependencies (installed at install time; native modules build via the
`pnpm.onlyBuiltDependencies` allowlist in the root `package.json`):

| Package | License | How it ships |
| --- | --- | --- |
| better-sqlite3 | MIT | installed at install time (native module, external to the bundle) |
| node-pty | MIT | installed at install time (native module, external to the bundle) |
| fastify | MIT | bundled into `dist/mec.mjs` |
| react / react-dom | MIT | bundled into the workbench build (`apps/web/dist`) |
| zod | MIT | bundled into `dist/mec.mjs` |

Development-only tooling (never distributed): biome, typescript, vitest, esbuild,
vite, `@types/*`.

Engine binaries (Claude Code, Codex CLI, OpenCode) are the user's own installed
tools under their own vendor accounts and terms — MEC launches them and never
redistributes them.
