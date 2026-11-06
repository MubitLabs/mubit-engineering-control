# Release runbook: 0.3.0

For the coordinator. Every command below is for you to run; the builder ran none of them. Rollout authority is decisions #15 and #39: tags, GitHub Releases, local reinstall and restart. Not covered: npm publication, vendor or account changes, SQL migration or stored-data deletion. This release has no migration.

## What 0.3.0 is, and is not proven

- The new shell is the default. `?ui=classic` still works for this release; the palette and the empty states link to it.
- Axe 0 violations and Lighthouse 100 on nine routes of the packaged server, light and dark; screens 931 of 931 (`docs/changes/2026-11-05-next-default/VERIFICATION.md`).
- The composed journey ran on real Claude 2.1.319 with a **fake `gh`** and a `file://` remote. That is not a real PR. The real `mec-sandbox` pass through the cards is still the coordinator's (#23).
- Codex and OpenCode were proven on their own runner slices (M2.4 Part B), not in the composed journey. Their composed proof follows the release.
- `pnpm check` has not run green on this tree on a quiet machine: 8 failures under load, unresolved (`2026-11-05-next-default/VERIFICATION.md`). Step 1 runs it.

## Steps

1. On a quiet machine, on the commit to tag: `pnpm install --frozen-lockfile && pnpm check`. Confirm CI is green on the same commit (`gh run list --branch main --limit 3`). A red CI blocks the deploy.
2. Confirm the versions agree: `pnpm exec vitest run apps/desktop/test/version-sync.test.ts`, and `node -p "require('./apps/desktop/package.json').version"` prints `0.3.0`.
3. Local smoke, no install. Pack comes after the web build: `pnpm build:desktop && pnpm --dir apps/web build && pnpm pack:internal`. Then `mkdir /tmp/mec-smoke && tar xzf dist-internal/mec-0.3.0.tgz -C /tmp/mec-smoke && cd /tmp/mec-smoke && npm install --omit=dev`. With a scratch `HOME` and `MEC_DATA_DIR`: `node bin/mec.js --version` prints 0.3.0; start with `MEC_NO_OPEN=1 node bin/mec.js`, `curl <url>/healthz` answers `"ok":true`, and `curl <url>/` contains `<div id="root">`.
4. Tag the commit on `main`: `git tag v0.3.0 <sha> && git push origin v0.3.0`. The tag must be `v` plus the desktop version, or the first step of the `check` job fails.
5. What fires on a `v*` tag (`.github/workflows/release.yml`), in order:
   - `check`: the tag guard, `pnpm install --frozen-lockfile`, `pnpm check`;
   - `tarball`: `pnpm build:desktop`, `pnpm pack:internal`, uploads `dist-internal/mec-*.tgz`;
   - `install-smoke` on ubuntu-latest and macos-latest: extract, `npm install --omit=dev`, `scripts/smoke-package.mjs`, `--version`, `doctor --json`, then the server's healthz and workbench root;
   - `release`: a GitHub Release carrying `mec-0.3.0.tgz` and `scripts/install.sh`, then `mec-latest.tgz` uploaded as the stable alias.
   The npm publish step stays commented out.
6. Before installing, keep the prior tarball: `mkdir -p ~/mec-releases && gh release download v0.2.1 --pattern 'mec-*.tgz' --dir ~/mec-releases`. `scripts/install.sh` runs `rm -rf` on `~/.mec/app/*` before extracting and has no rollback.
7. Keep a copy of the database, taken while MEC is stopped (`mec stop`, then copy `~/.mec/mec.db*`), or via `VACUUM INTO`. Never delete it. A reinstall does not undo data writes.
8. Install and restart: `bash scripts/install.sh` (it fetches `releases/latest/download/mec-latest.tgz`), then `mec restart`, hard refresh the browser, and check `mec --version` prints 0.3.0. Repeat the journey on the installed version.
9. Rollback: `rm -rf ~/.mec/app/* && tar xzf ~/mec-releases/mec-0.2.1.tgz -C ~/.mec/app && (cd ~/.mec/app && npm install --omit=dev) && mec restart`. If the new shell misbehaves, use `?ui=classic` first. A newer schema blocks an older binary; this release has no migration.
10. Stage C (removing the classic shell) waits until you confirm the installed walkthrough passed.
