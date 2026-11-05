# Verification: M1.1 HTTP recovery

Base a102313. All commands run in the worktree; observed, not read.

## Failing first

`pnpm exec vitest run apps/web/test` before the implementation: `api-recovery.test.ts` 2 failed
(`api.prompts()` resolved with demo parts instead of rejecting on a 404), `web-contract.test.ts` 4 failed
(`/api/prompts` returned an envelope, not an array; `/api/models` had no `providers`; `/api/questions`
returned the answered question too; `/api/backups` was not a JSON 404 — with a dist present it was HTTP 200
HTML). Passing after: 16 tests in `apps/web/test`.

## Suite

`pnpm check`: typecheck and lint clean; 1585 passed, 1 failed, 16 skipped. The one failure is the baseline
environment failure `apps/desktop/test/login-cards.test.ts` "drives a real interactive shell through the
seam" (node-pty spawn-helper lacks +x). Nothing else fails.

## Mutants (by hand, `tools/mutants/run.py` not on the base)

Each applied alone, `vitest run apps/web/test`, restored after: prompts returns the raw envelope (killed);
backups falls back to a demo object on a 404 (killed); the `/api/` JSON 404 guard removed (killed); answer
sent as `{option}` (killed); a `src/` file imports `../test/mocks` (killed); decoder keeps answered questions
(killed); models decoder drops OpenCode columns (killed). 7 of 7 killed, 0 survived, 0 invalid.

## Screens (Playwright, outside CI)

`pnpm --filter @mec/web test:screens` under the shared lock: 23 passed, including two new tests (a failing
prompts read and a 404 models read end in an error with Try again while navigation still works; a chat plan
with a malformed payload is contained to its pane and the rail still navigates). Baselines were updated only
for the 8 images named in CHANGE.md.

## Bundle

`pnpm --filter @mec/web build`, then a search of `dist/assets` for `Audit-log viewing`, `worked example` and
`gpt-6-luna`: no match. (`dist` is not committed.)

## Not verified

No real server with a built dist was driven by a browser; the JSON 404 is proven through `app.inject` with a
temporary dist. Real `GET /api/models` availability probing (slot engines) was not exercised: the contract test
runs with no slots, so `availability` is empty and the decoder ignores it.
