# Verification: main gaps

Base 9994c49. All runs are local, in the builder's worktree. No real engine, canary or push was used. Node 25.8.2, the ABI the dependency tree was built for.

Dependencies: nothing was installed. `node_modules` was cloned from a sibling worktree with an identical `pnpm-lock.yaml`.

## Failing first

Each test was seen failing on the unfixed code, for the reason shown.

| Defect | Command | Output |
| --- | --- | --- |
| 1 Repo scope | `vitest run apps/desktop/test/server.test.ts -t "not one string"` | `/api/work?repoId=repo_…&repoId=repo_…: expected 200 to be 400` |
| 2 Approve | `vitest run apps/desktop/test/release-cards.test.ts apps/web/test/release-cards.test.ts` | 4 failed. `canApprove({ absent: true })`: `expected true to be false`. Planner detail: `expected 404 to be 200`, twice. A card with no evidence: `expected true to be false` |
| 2 Approve, browser | `playwright test test/screens.playwright.ts -g "no evidence for cannot"` with the old `canApprove` put back | `expect(locator).toBeDisabled() failed. Expected: disabled. Received: enabled` |
| 3 Prompts | `vitest run apps/desktop/test/bundle-defaults.test.ts` | 6 failed. `expected [] to have a length of 21 but got +0`, `expected '' to be '# Meta agent — the turn protocol…'`, and with no defaults the server still printed `mec server listening on` |
| 4 Keystore | `vitest run apps/desktop/test/keystore-root.test.ts` | 3 failed. `expected false to be true` for the save under the data dir, and the provenance path outside it |

The keystore test runs on a throwaway home behind a `node:os` double. A first run of only the read-only test proved the double reaches the server, the models table and the planner, before any test that writes ran.

Two tests pass at red by design and are held by mutants instead: the redaction test, because the route answered 404 then, and the 5xx test, because that path was already right.

## Bundle and tarball

`pnpm pack:internal`, then `tar xzf` into a scratch folder. A link stood in for `npm install`, so the natives came from this worktree. Each server ran from the real `bin/mec.js` with `MEC_NO_OPEN=1` on a scratch `MEC_DATA_DIR`, and was stopped by its own PID. The planner line came from the same `readMetaProtocol` built into the same directory as the bundle, with an empty user prompts root.

The "before" runs had the keystore fix in, so they stayed off `~/.mec`. Defect 3's code was unchanged in them.

Before, built bundle:

```
GET /api/prompts 200 parts 0
GET /api/prompts/defaults 200 parts 0
GET /api/models 200 {"source":"default","path":"<worktree>/packages/prompts/defaults/models.yaml"}
readMetaProtocol chars 0 | fallback DEFAULT_PLANNER_PROTOCOL chars 2172
```

Before, extracted tarball:

```
GET /api/prompts 200 parts 0
GET /api/prompts/defaults 200 parts 0
GET /api/models 500 {"error":"models table invalid","detail":"ENOENT: no such file or directory, open '…
readMetaProtocol chars 0 | fallback DEFAULT_PLANNER_PROTOCOL chars 2172
```

After, built bundle:

```
GET /api/prompts 200 parts 21
GET /api/prompts/defaults 200 parts 21
GET /api/models 200 {"source":"default","path":"<worktree>/packages/prompts/defaults/models.yaml"}
readMetaProtocol chars 2946
```

After, extracted tarball:

```
GET /api/prompts 200 parts 21
GET /api/prompts/defaults 200 parts 21
GET /api/models 200 {"source":"default","path":"<scratch>/mec/dist/prompts-defaults/models.yaml"}
readMetaProtocol chars 2946
```

`apps/desktop/test/bundle-defaults.test.ts` keeps this proof in `pnpm check`. It bundles the real entry into both layouts and a third with no defaults, plants decoy folders at the source tree's relative paths, and boots the real launcher.

## Gate

`pnpm check` on the final code: exit 1, from the one permitted failure only.

| Step | Result |
| --- | --- |
| Typecheck | Passes |
| `biome check .` | 381 files, 19 warnings, 1 info, none in a file this change touched |
| `vitest run` | 1893 tests: 1876 passed, 1 failed, 16 skipped |
| The failure | `apps/desktop/test/login-cards.test.ts > drives a real interactive shell through the seam`, `posix_spawnp failed`, the same on the base |

Base for comparison, `pnpm test` at 9994c49: 1870 tests, 1853 passed, 1 failed, 16 skipped.

`bundle.test.ts` skips without a build, so it ran separately with a build in place: 1 passed.

`playwright test test/screens.playwright.ts`: 25 passed, including the new no-evidence card.

## A failure found on the way

The first `pnpm check` also failed `bundle-defaults.test.ts` with a timeout, on every full run and on no smaller one. `sample` showed the launcher's child at `_dyld_start` with a 112K footprint, and `ps` showed it there for over 12s. Unrelated `ps` calls stalled for seconds too, so new processes were slow to start across the machine while the suite was spawning. It is not a code hang: given more time the same run passes. Limits in that one new test are now 40s and 60s. It then passed 3 of 3 full runs, and the gate above.

## Mutants

`python3 tools/mutants/run.py tools/mutants/main-gaps.json` on the final code: 27 of 27 killed, exit 0.

`--self-check`: the no-op reported SURVIVED and the syntax error INVALID, both as expected.

| Area | Mutants |
| --- | --- |
| Repo scope | 3 |
| Cards and evidence | 8 |
| Prompt defaults, loader and models | 6 |
| Planner defaults | 4 |
| Startup check | 1 |
| Keystore root | 5 |

## Not verified

- No real planner turn ran, so "every plan rejected" on an empty table is from reading `composition.ts`, not from seeing it.
- The tarball's natives came from a link, so `npm install` on a clean machine was not exercised.
- Node 22, the `.node-version` pin, was not run. The dependency tree here is built for Node 25.
