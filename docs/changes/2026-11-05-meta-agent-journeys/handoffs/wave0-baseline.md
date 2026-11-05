<!-- Wave 0 scout report, 5 November 2026, base a102313. Leads, not facts: check against source. -->

Baseline at a102313, worktree `/Users/shankhadutta/code/mubit-engineering-control/.claude/worktrees/wf_53a85b64-7e1-2`. Node v25.8.2, pnpm 10.34.9. Everything below was run, not read from source.

| Command | Exit | Result | Time |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | Lockfile honoured, already up to date | 1s |
| `pnpm check` | **1** | typecheck passes; lint exits 0; `vitest run` has 1 failure | 20s |
| `pnpm build:desktop` | 0 | Bundled `apps/desktop/dist/mec.mjs` (2.8MB) and `mec-cli.mjs` (0.8MB) | 1s |
| `pnpm exec tsc --noEmit` in `apps/web` | 0 | Clean | 1s |
| `pnpm test:screens` in `apps/web` | 0 | 21 passed, headless | 3s |

`pnpm check` runs `typecheck && lint && test`.
- **Wall-clock:** 20s in total. The vitest part reported 13.92s (tests 16.92s, since the two projects overlap).
- **Typecheck:** all four packages report Done (contracts, meta, web, desktop), no errors.
- **Lint:** `biome check .` checked 322 files, found 12 warnings and 1 info, and exits 0. The one I looked at is `packages/engines/src/claude/stream.ts:94:21 lint/complexity/noUselessTernary`.
- **Tests:** 124 files, of which 116 passed, 1 failed and 7 were skipped. 1595 tests, of which 1578 passed, 1 failed and 16 were skipped.

**The one failing test, verbatim:**
```
FAIL  |b| apps/desktop/test/login-cards.test.ts > the real node-pty (R1.3) > drives a real interactive shell through the seam (no vendor command)
Error: posix_spawnp failed.
 ❯ new UnixTerminal node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/src/unixTerminal.ts:106:21
 ❯ nodePtySpawn apps/desktop/src/login-cards.ts:276:20
 ❯ apps/desktop/test/login-cards.test.ts:311:18
```

**Classification: environment problem, not a code regression.**
- **Cause:** the node-pty prebuilt `spawn-helper` has no execute bit. `ls -l` shows `-rw-r--r--` for `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`.
- **Why I think so:** this fits a fresh pnpm install that lost the mode. I did not confirm the mechanism.
- **Not applied:** `chmod +x` on that file should clear it. I left it, so this baseline shows the failure as found. The other 10 tests in that file pass.
- **Expect it in every new worktree** until someone chmods the helper or the repo adds a fix.
- **No pre-existing code failures** were found.

**Safety:** no test touched a real engine or a credential, and I set no `MEC_REAL_*` variables. Test files that call `homedir()` are `packages/slots/test/homes.test.ts` and `apps/desktop/test/wizard.test.ts`. I did not read them, so I can't say whether they write to `~/.mec`. The run itself did not stop any test for touching it. `git status` is clean after all runs, and `apps/desktop/dist` is ignored.

**Shared state between two worktrees running at once:**
- **Vitest (source only, I did not run two at once):** 30 test files use `mkdtemp`, and my grep of `listen(` in test files found no hard-coded ports. This looks safe to run in parallel.
- **Playwright screens:** fixed to vite on `127.0.0.1:4173` with `--strictPort` and `reuseExistingServer: true`.
  - A second worktree running `test:screens` at the same time would reuse the first one's dev server, or fail on the port. The suite is stubbed per page, so the mocks come from whichever worktree's server answers.
  - Run it one worktree at a time.
  - Port 4173 was free when I started.
  - Its output goes to `$TMPDIR/mec-web-playwright`, which is also shared between worktrees.
- **Install:** `pnpm install` reuses the shared pnpm store, and it finished in 1s.

Logs are in `/private/tmp/claude-501/`: `inst.log`, `check.log`, `build.log`, `tsc.log` and `screens.log`.
