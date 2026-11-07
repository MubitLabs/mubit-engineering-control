# Walkthrough polish

Base `07000f2` (0.3.0). What a real-browser, normal-user pass of the new shell found, minus what other lanes own. No SQL migration, no stored-data change and no contracts change.

## What changed

1. **Search.** The palette filters commands, so "wave" matched nothing. With text typed it now offers `Search work, tasks and messages for "…"`, and picks it when no command matches. It opens the existing Search sheet with those words, which runs `/api/inspect/search` unchanged. `apps/web/src/next/command-search.ts`, `CommandPalette.tsx`, `Shell.tsx`, `live/LiveApp.tsx`.
2. **Setup.**
   - `GET /api/setup/readiness` held every saved fact behind three `--version` probes, and the page behind that read. `opencode --version` was the slow one (see Cause). `?engines=known` now answers at once from the last look and looks again behind the answer; until a first look has answered, Engines reads `checking` and Finish stays off with that reason. Setup rereads each second while checking. The plain route still waits, and Check again uses it.
   - `.finish` has space below it, so Finish no longer sits on the Setup chat heading.
   - Once every stage is done, Finish is gone, the subtitle says nothing more is needed and the chat folds under a disclosure.
3. **Settings.** Policy and Models lead with plain sentences. The raw text sits under an `Advanced` disclosure, which a draft keeps open. The save bar stays outside it, so save, revision and stale checks are the same code. The models summary comes from the server's parsed table on `GET /api/models/text`; the web app has no YAML parser.
4. **Connections.** One date form (`next/format.ts`, the one Work already used), also for parked work and the pause note. Drain is removed while unavailable; the page line still says why. Usage explains itself.
5. **Task evidence.** `activitySummary` now says what ran (`Ran pnpm test`, `Edit src/a.ts`) and what a limit means (`Weekly limit: fine for now`). Output of more than one line renders in a monospace block.
6. **Titles.** Work, task and search titles carry the whole first line up to 500 characters instead of 80. Rows wrap; Recent work clamps to two lines by CSS with the text left in the page and in `title`.
7. **Planner stdin.** `ClaudeAdapter.launch` ends stdin on a one-shot launch. A stream launch keeps it open, and an owned spawn with `stdin: false` has none, so `?.` leaves that opt-out alone.
8. **Sidebar.** Pause is a separate section under navigation with its effect in visible text, tied to the button by `aria-describedby`. Unassigned has its own History nav. Decision #22 places pause beside Needs you; it stays directly under that group.
9. **Repository control.** In the Unassigned view it now says Unassigned and Read-only history, and a long name wraps to two lines instead of cutting to "Choose a repo…".

The `?` button opens the glossary; it was already working, and `work.screens.playwright.ts` proves it.

## Cause of the Setup wait

`claude --version` and `codex --version` answered in 9 to 62 ms. `opencode --version` is intermittent on this machine: 12 sequential samples took 61 to 420 ms, and at other moments every call hit the probe's 5 s timeout (`defaultProbeCmd`, `PROBE_TIMEOUT_MS`) and was killed. `Promise.all` waits for the slowest, so the route took 5000 ms on a scratch server with nothing running. Stdin is ruled out: `execFile`, an open pipe and `ignore` all stalled in the same window, and running it alone stalled too. Why it stalls is not proven. `syspolicyd` was busy throughout, and the binary is 226 MB, so a macOS scan of each exec is the likely cause. The fix does not depend on it.

A probe killed at the timeout still reports that engine as not installed, so in a stalled window Setup can say OpenCode is missing. That is older behaviour and stays open.

## Decisions for review

- Item 5's summaries changed the wire text of `summary` for `tool_call` and `rate_limit`. Two old assertions changed with it, on purpose.
- Item 6's cap moved from 80 to 500 in `inspection.ts` and `server.ts`. Three old assertions changed, on purpose.
- `Switch work` keeps its disabled button with a tooltip. Item 4 named Drain only.
