# Verification

No real engine ran, nothing touched `~/.mec` or port 61610, and nothing was pushed or installed.

## Failing first

Against unmodified source, with the tests added:

| Command | Before |
| --- | --- |
| `pnpm exec vitest run apps/desktop/test/delivery-flow.test.ts -t "bootstrap\|retry route"` | 3 failed. Work blocked with `integration: merge failed without leaving a merge in progress`, reproducing the journey through the real server. The retry route answered 404. |
| `pnpm exec vitest run apps/desktop/test/delivery.test.ts -t "a person retries"` | 14 failed: `r.delivery.retry is not a function`. |

After the change, all of them pass. See the tests below.

## Cases

- A bootstrap that writes an unignored file, through the real server and fake CLI: no task commit carries it, integration reaches the push card, and the file stays on disk beside the checks.
- A specialist changes that file: it commits, and the merge replaces the integration's copy.
- Work blocked by 0.3.0 (old reason, swept task commit, untracked file, no record) integrates after one retry.
- One retry is one effect: a second press answers `nothing_to_retry`, and a declined push makes exactly one new card, still one after a 4.5 s wait through the real server's timer.
- Held, stopped, expired and paused work each behave as `CHANGE.md` says.

Fixtures are unchanged, and `journey-rig.ts` still registers `bootstrapCmds: []`: this evidence is the real server with a fake CLI, not the real journey.
