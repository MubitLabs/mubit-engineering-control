# M3.4 Stage A: the accessibility runner

Handoff `33-m3.4-accessibility-local-release.md`, Stage A only. Test tooling; no product code changed.

- `apps/web/package.json`: devDependencies `@axe-core/playwright` 4.14.0 and `lighthouse` 13.6.0 (exact), script `test:lighthouse`. The lockfile gained their dependency tree; the only existing line that changed is vitest's peer-resolution key, which now lists the optional `@opentelemetry/api` that lighthouse brings in. No existing package version moved.
- `apps/web/test/a11y.screens.playwright.ts`: axe helper (fails on a missing surface, an empty `passes`, or any violation; no rule disabled) and the broken-page tests. Matches the existing `testMatch`, so `playwright.config.ts` is untouched.
- `apps/web/scripts/lighthouse.mjs`: Lighthouse accessibility category through Playwright's chromium (`--no-proxy-server`), 95 per route, reports in `$TMPDIR`; `--from-report` judges JSON on disk.
- `apps/web/test/fixtures/a11y-broken.html`: the deliberately bad page.
- `apps/web/test/a11y-gate.test.ts`: the script's verdict on stubbed reports, in the normal vitest suite.
- `tools/mutants/m3.4-release.json`: the two Lighthouse mutants of the handoff plus two more. The release, flag, version and deleted-module mutants belong to Stages B to D and are not here.
- `CONTRIBUTING.md`, `docs/agent-workflow/commands.md`: the commands.

Not in CI and not in `pnpm check`, like `test:screens`.
