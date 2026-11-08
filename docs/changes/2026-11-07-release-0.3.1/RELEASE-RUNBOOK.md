# Release runbook: 0.3.1

For the coordinator. Every command below is for you to run; the builder ran none of them. Rollout authority is decisions #15 and #39: tags, GitHub Releases, local reinstall and restart. Not covered: npm publication, vendor or account changes, SQL migration or stored-data deletion. This release has no migration.

## What 0.3.1 is, and is not proven

- It carries the core-ship fixes (#51): answers reach the chat, delivery surfaces, meta-agent visibility, slot choice, held capacity for a stuck group, the approval key and the per-repository host-run agreement (decisions #47-#53).
- **A changed step for the owner.** The real runner is on, but nothing runs in a repository until you agree for that repository (Settings, Repositories). After every restart the browser needs **Link this browser** before it can agree or answer a card. The installed 0.3.0 runs with the runner off until this release (decision #51).
- `?ui=classic` still works (decision #48). Removal is a later release.
- Real Claude runs A, B, C1 and C2 on the v0.3.0 base (fake `gh`, `file://` remote) found the defects. The fixes themselves are proven on fakes: no real engine has run the question turn, the No answer path or the agreement, and the real `osascript` link has never run. The real `mec-sandbox` pass through the cards is still the coordinator's.
- Codex and OpenCode proof on the final build still follows a release.
- `pnpm check` has not passed clean in one run of the combined tree (load-related failures; each failing file passed alone). Step 1 runs it on a quiet machine.

## Steps

1. On a quiet machine, on the commit to tag: `pnpm install --frozen-lockfile && pnpm check`. Confirm CI is green on the same commit (`gh run list --branch main --limit 3`). A red CI blocks the deploy.
2. Confirm the versions agree: `pnpm exec vitest run apps/desktop/test/version-sync.test.ts`, and `node -p "require('./apps/desktop/package.json').version"` prints `0.3.1`.
3. Local smoke, no install. Pack comes after the web build: `pnpm build:desktop && pnpm --dir apps/web build && pnpm pack:internal`. Check the tarball carries prompts and models (an earlier real tarball had them empty; the package fix is #44). Then `mkdir /tmp/mec-smoke && tar xzf dist-internal/mec-0.3.1.tgz -C /tmp/mec-smoke && cd /tmp/mec-smoke && npm install --omit=dev`. With a scratch `HOME` and `MEC_DATA_DIR`: `node bin/mec.js --version` prints 0.3.1; start with `MEC_NO_OPEN=1 node bin/mec.js`, `curl <url>/healthz` answers `"ok":true`, and `curl <url>/` contains `<div id="root">`.
4. Tag the commit on `main`: `git tag v0.3.1 <sha> && git push origin v0.3.1`. The tag must be `v` plus the desktop version, or the first step of the `check` job fails.
5. What fires on a `v*` tag (`.github/workflows/release.yml`), in order:
   - `check`: the tag guard, `pnpm install --frozen-lockfile`, `pnpm check`;
   - `tarball`: `pnpm build:desktop`, `pnpm pack:internal`, uploads `dist-internal/mec-*.tgz`;
   - `install-smoke` on ubuntu-latest and macos-latest: extract, `npm install --omit=dev`, `scripts/smoke-package.mjs`, `--version`, `doctor --json`, then the server's healthz and workbench root;
   - `release`: a GitHub Release carrying `mec-0.3.1.tgz` and `scripts/install.sh`, then `mec-latest.tgz` uploaded as the stable alias.
   The npm publish step stays commented out.
6. Before installing, keep the prior tarball: `mkdir -p ~/mec-releases && gh release download v0.3.0 --pattern 'mec-*.tgz' --dir ~/mec-releases`. `scripts/install.sh` runs `rm -rf` on `~/.mec/app/*` before extracting and has no rollback.
7. Keep a copy of the database, taken while MEC is stopped (`mec stop`, then copy `~/.mec/mec.db*`), or with `mec backup`. Never delete it. A reinstall does not undo data writes.
8. Install and restart: `bash scripts/install.sh` (it fetches `releases/latest/download/mec-latest.tgz`), then `mec restart`, hard refresh the browser, press **Link this browser**, and check `mec --version` prints 0.3.1.
9. Installed checks, in order. The runner was off on 0.3.0, so nothing has run in any repository yet:
   - Settings, Repositories shows each repository waiting for your agreement, and Work reads *Waiting for your agreement*. Nothing launched on its own after the restart.
   - Agree for `MubitLabs/mec-sandbox` only. Its work starts; another repository's does not.
   - A question sent beside live work gets an answer in chat.
   - A real pull request and merge through the cards on `mec-sandbox`. This is the proof that lets classic be removed (decision #48).
   - `mec restart`, then confirm the tab asks for **Link this browser** and the agreement still stands.
10. Rollback: `rm -rf ~/.mec/app/* && tar xzf ~/mec-releases/mec-0.3.0.tgz -C ~/.mec/app && (cd ~/.mec/app && npm install --omit=dev) && mec restart`. There is no migration, and `hostRunAgreedAt` is an additive field. If the runner misbehaves, withdraw the agreement for that repository first (withdrawing needs no key). To match the earlier install, start 0.3.0 with `MEC_REAL_RUNNER=0`.
11. Classic removal waits until the installed checks in step 9 pass and you confirm it.
