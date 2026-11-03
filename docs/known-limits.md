# Known limits

- **Native modules must be prebuilt (no compile-on-install for strangers — §21.7).** `mec`
  needs `better-sqlite3` and `node-pty` as working native modules for the platform
  (macOS/Linux, arm64/x64). When the launcher cannot load them it exits **3** with the
  message *"MEC needs prebuilt native modules (better-sqlite3, node-pty) for this
  platform. Internal installs: pnpm install with the root package.json allowlist."*
  Internal installs fix this by reinstalling from the repository (`pnpm install` — the
  root `package.json` carries `pnpm.onlyBuiltDependencies` for both modules — then
  `pnpm build:desktop`), or by `npm install --omit=dev --ignore-scripts=false` inside an
  extracted `dist-internal/mec-<version>.tgz` artifact. There is no auto-update by
  design (`mec update` prints the reinstall path; DECISIONS #4).
- **`mec slot probe` is Claude-only in v0** (plan §5.8): only `claude-sub` slots probe;
  Codex and OpenCode probes arrive with their adapters (L7/L8).
- **`mec slot` operates on local state only**: the subcommands open the store in the data
  dir directly; they never talk to a running server, and the CLI never sees a credential
  — keys are pasted only in the workbench Slots form (§5.4).
