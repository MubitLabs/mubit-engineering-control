# Package contents

6 November 2026, darwin arm64, base `7ec7476`. Run by the builder in an isolated worktree. Nothing was pushed or installed, no engine ran, and `~/.mec` was not touched. No separate verifier followed.

## What a real package did

`pnpm pack:internal`, extracted to a scratch directory, `npm install --omit=dev`, started on a scratch `HOME` and `MEC_DATA_DIR` with `MEC_FAKE_ENGINE=1`. Same results on Node 25.8.2 and on Node 22.23.3 from nvm.

| Check | Before |
| --- | --- |
| `GET /api/prompts`, `/api/prompts/defaults` | 200, 21 parts |
| `GET /api/models` | 200, shipped table, read from `dist/prompts-defaults/` |
| `GET /` | 200, the workbench |
| `bin/mec.js --version`, `help`, `status`, `doctor`, and through an install-style symlink | Work |
| `POST /api/slots/login` | **500 `posix_spawnp failed.`** |

The models and prompts defect did not reproduce on this base. The blocker found instead is the login card.

## Cause

`node-pty` 1.1.0 runs `prebuilds/<platform>-<arch>/spawn-helper` for every pty. npm and pnpm both leave that file mode 0644, and its install script does not repair it. So a macOS install could not start any vendor login. The same cause is the known `login-cards.test.ts` baseline failure, which was read as a test problem.

## What changed

- `nodePtySpawn` restores the execute bit before it spawns (`apps/desktop/src/login-cards.ts`). This also turns the baseline test green.
- `scripts/smoke-package.mjs` boots a package and checks the catalogue part by part against `packages/prompts/defaults`, the models table's origin and bytes, the workbench, and a login card that runs a stand-in `claude`.
- `pnpm pack:internal` runs the smoke on the staged tree and writes no artifact on a failure. Both `install-smoke` jobs run it on the installed package.
- Staging moved from `dist-internal/staging` to a temporary directory. Inside the checkout, the bundle's `../../../packages/prompts/defaults` fallback resolves, so a package with no tree would have passed.

## Verification

| Test | Red | Green |
| --- | --- | --- |
| New smoke on the real extracted package, Node 25 | `a login card did not start (500)`, exit 1 | Passed, Node 25 and Node 22 |
| `bundle-defaults.test.ts`, `login-cards.test.ts` | 6 failed, including the baseline test with `posix_spawnp failed.` | 32 passed |
| `node scripts/pack-sabotaged.mjs`, a throwaway copy of the pack script with the defaults copy removed | Exit 1, `the shipped prompt defaults are missing`, no tarball | Not applicable: this is the gate refusing |

Mutants: `python3 tools/mutants/run.py tools/mutants/package-contents.json`, 12 of 12 killed.

`pnpm check`: exit 0, 2556 passed, 15 skipped. The first full run failed once on `bundle.test.ts`'s 6-second health wait, the listed flake, at machine load 7; that file then passed three times alone and the rerun was clean. The new smoke tests add about 10 server boots to the suite, so they may add to that load.

## Not proven

- Linux: `install-smoke` will be the first run there. Linux has no prebuilt helper, so the repair does nothing, and the smoke still runs a login card.
- `pack:internal` now needs working native modules in the checkout, for the same Node that runs it.
- A real vendor login, in a browser, from an installed package. The stand-in proves the pty runs a process, not the vendor flow.
