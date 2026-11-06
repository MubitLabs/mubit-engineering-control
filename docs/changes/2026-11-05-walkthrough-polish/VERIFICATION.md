# Verification: walkthrough polish

Commands and outcomes as run. See `CHANGE.md` for what and why.

## Failing first

`vitest` over the desktop, engines and web suites touched, before any source change: 8 failed and 139 passed, and `walkthrough.test.ts` failed to load because its modules did not exist. The 8 covered the `?engines=known` read (3), tool and limit summaries (3), the title cap (1) and stdin on a one-shot launch (1).

After: 401 passed across 11 files.

## Scratch server

`mec.js` from this tree, scratch `HOME` and `MEC_DATA_DIR`, `MEC_FAKE_ENGINE=1`, port ephemeral:

| Read | Time | Engines step |
| --- | --- | --- |
| `?engines=known`, first | 69 ms | checking |
| `?engines=known`, second | 7 ms | checking |
| `?engines=known`, after 6 s | 5 ms | done |
| plain route | 5000 ms | done |

`GET /api/models/text` carried a summary: claude 4 models, codex 4, opencode 5, four tiers.

## Screens

`pnpm test:screens` under the README lock, light, dark, 1440, 1024 and 390 through the matrix: 1002 passed. New matrix cells: setup checking engines, setup finished, policy advanced. Axe has no violation on any cell.

Config baselines changed on purpose, for the Usage text, the Drain button and the sidebar. Regenerated with `--update-snapshots`; the Connections one was read before committing.

## Mutants

`python3 tools/mutants/run.py tools/mutants/walkthrough-polish.json`: 22 of 22 killed. They cover logic only. The CSS and JSX changes rest on the screens tests.

## pnpm check

Typecheck and lint pass. **The vitest half did not go green on this machine.** Whole-suite runs failed 25 of 3322 tests in 10 files, and a rerun of those 10 at `--maxWorkers=2` failed a different 10 of 258. Every failure is a timeout in a test that spawns a process, including supervisor and pty tests this branch does not touch. `syspolicyd` was at 75 to 84% CPU with `trustd` and XProtect beside it for the whole window, and a plain `spawn` stalled in the scratch timing scripts too.

What rules this branch out: `composition.test.ts` passed 28 of 28 twice with the stdin line and twice without it, `live-park.test.ts` passed three times running, and `composition`, `bundle` and `a11y-gate` passed alone. A clean whole-suite run is still owed, and the coordinator's lane should supply it.

## Not proven

- No real engine ran, so the 3 s planner wait is proven gone only as far as "stdin ends at launch" on a stub spawn. The Claude log line itself was not observed either way.
- Search was exercised through the palette against a route mock. `/api/inspect/search` itself is unchanged.
- Why `opencode --version` stalls.
