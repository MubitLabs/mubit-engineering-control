# Known limits

Designed limits — what MEC deliberately does not do. This file does not carry the moving record:
what is verified, what runs on fakes and what is absent lives in [`docs/STATUS.md`](STATUS.md).

- **No auto-update.** `mec update` prints the reinstall path; a new release is installed
  deliberately (release tarball or `npx`), never fetched and swapped in the background
  (DECISIONS #4).
- **No compile-on-install for strangers (§21.7).** `mec` needs `better-sqlite3` and `node-pty`
  as working native modules for the platform (macOS/Linux, arm64/x64). When the launcher cannot
  load them it exits 3 with the message pointing at the reinstall paths: from the repository
  (`pnpm install` — the root `package.json` carries the `pnpm.onlyBuiltDependencies` allowlist —
  then `pnpm build:desktop`), or `npm install --omit=dev` inside an extracted
  `mec-<version>.tgz` release artifact.
- **Single user, single writer.** One data dir (`~/.mec`), one operator, one server: a second
  process on the same data dir refuses to start (O_EXCL lock). There is no multi-user mode and
  no concurrent-server mode, by design.
- **Probes are local and zero-token (§5.8).** The never-list holds: no periodic network probes
  against quota-metered plans, no probe that burns subscription usage. Claude login slots use
  the vendor's own `auth status`; API-key slots (`anthropic-api`, `zai-coding-plan`,
  `google-gemini`) use one zero-token GET against the provider's own models endpoint; each
  engine adapter reports capabilities and auth health from its own local interface. The
  `mec slot probe` CLI subcommand still probes `claude-sub` slots only — other slot kinds probe
  through the workbench/server.
- **`mec slot` operates on local state only.** The subcommands open the store in the data dir
  directly; they never talk to a running server, and the CLI never sees a credential — keys are
  pasted only in the workbench Slots form (§5.4).
