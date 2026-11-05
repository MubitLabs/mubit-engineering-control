# Verification: M1.3 Repo workspace and submission intent

Base `feat/repo-identity` at c827da8, a local branch not yet on `origin/main`, by coordinator waiver. All runs are local, in the builder's worktree. No real engine, `~/.mec` or installed server was used. Engine runs spent: 0.

## Failing first

- `pnpm exec vitest run packages/meta/test/routing.test.ts apps/desktop/test/server.test.ts`, before implementation: 10 failed, 34 passed. Reasons include `expected 'conversation' to be 'new_work'`, `expected 200 to be 409`, `expected 200 to be 400`, `expected 400 to be 409` (`repoId=unassigned`).
- `pnpm exec vitest run apps/web/test/repo-target.test.ts apps/web/test/api.test.ts`: 2 failed plus one suite that could not load (`Cannot find module '../src/repo-target'`).
- `address`, `drafts`, `submission`, `workspace` and `live-boundary` tests: 5 suites failed to load, because the modules did not exist. That is a failure for a missing module, not a behaviour. The mutants below are what show these tests see behaviour.
- `pnpm exec vitest run apps/desktop/test/server.test.ts`, before the flip: 2 failed, 38 passed (`absent repoId is 400 and writes nothing` and its composed-path twin).

## Gate

`pnpm check` on the final tree: exit 1, from the one baseline failure only.

| Step | Result |
| --- | --- |
| Typecheck | Passes |
| `biome check .` | 378 files, 17 warnings, 1 info, none in a file this change added |
| `vitest run` | 1917 tests: 1901 passed, 1 failed, 15 skipped |
| The failure | `apps/desktop/test/login-cards.test.ts > drives a real interactive shell through the seam`, the known environment problem |

One earlier full run also failed `apps/desktop/test/bundle.test.ts` (no `health.json` inside its 6 s deadline). It passed alone and on the next full run. It only runs when `dist` exists, and the build for the browser walk had created that.

## Mutants

`python3 tools/mutants/run.py tools/mutants/repo-workspace.json`: 24 of 24 killed. `--self-check` reported its no-op SURVIVED and its syntax error INVALID, as it should. The handoff's 11 are all in the spec, plus 13 more for what this change added. Mutant 10 (stale-repo guard) runs against the feed in `workspace.tsx`, and "a late answer paints after a switch" covers the second guard beside it.

## Screens

`pnpm test:screens` under the lock: 140 passed, classic and next. Classic baselines did not move. The six `live-*` baselines changed, as the handoff allows.

## Real browser

The verifier run the handoff asks for has **not** happened: no separate agent was available, and the isolation guard on this worktree refused a server with a scratch `HOME`.

The builder ran the same steps once as a check on its own work. That is not the verification the README requires. It used a throwaway in-process server: the real `buildServer`, the real `MetaAgentService` with `fakeBrain`, a memory store, and the production web bundle, driven by Chromium through repo Playwright. It was not the packaged `mec.js`, there was no real store file, and the check of `work.repoId` used the HTTP API, not `mec.db`.

27 of 27 checks passed, no page errors:

| Step | Outcome |
| --- | --- |
| 1 | Each conversation and Work list shows only its own. One request at a time, not literally at once. |
| 2 | New request beside live work: a second work item. |
| 3 | Follow-up binds (`attach`). Clear survives a refetch and a reload. |
| 4 | Drafts survive a switch, reload, back and forward. |
| 5 | 20 double Enters, 20 messages. |
| 6 | Aborted POST then Retry: one message, same key. Edit and resend: a new key. |
| 7 | A synthetic key-shaped string is absent from `localStorage` and gone after reload. |
| 8 | Classic, one repo and two: the select appears and the send lands in the chosen repo. |
| 9 | Zero repos: a Setup message is accepted over HTTP, and classic's Send says why. Setup was not walked end to end in the browser. |
| 10 | POST with no `repoId`: 400, nothing written. |
| 11 | `?ui=classic` returns, and clearing the flag leaves classic the default. |
