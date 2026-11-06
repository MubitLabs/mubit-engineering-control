# Verification: `mec backup` and `mec restore`

## Failing first

`pnpm exec vitest run apps/desktop/test/backup-cli.test.ts` before the code: 26 of 27 failed, each on the old usage line or a missing `redacted`. The new route test failed because the archive's database held the token.

After: `backup-cli.test.ts` 29 of 29. With `backup.test.ts`, `restore.test.ts`, `backups-route.test.ts` and `mec.test.ts`, all green, with no existing test changed.

## Mutants

`python3 tools/mutants/run.py tools/mutants/backup-cli.json`: self-check correct, 22 of 22 killed.

The first run was 21 of 22. "freed pages stay in the copy" survived because the test's rows were too short to free a page. A probe showed `secure_delete` is off and the bytes do stay without the VACUUM. The fixture now holds a multi-page row, and the mutant is killed.

## `pnpm check`

Typecheck and lint clean. Tests: 2569 passed, 3 failed, 15 skipped.

- `login-cards.test.ts` "drives a real interactive shell": the documented baseline failure.
- `bundle.test.ts` and `a11y-gate.test.ts`: both passed when rerun alone, 8 of 8. The machine was under load, and `bundle.test.ts` is a listed flake in `docs/known-limits.md`.

## Smoke on the built bundle

Scratch `HOME`, `MEC_FAKE_ENGINE=1`, no real data.

- `mec backup` beside a running server: exit 0.
- `mec restore` onto that server's data dir: exit 1, "refuses to overwrite".
- `mec restore --drill`: exit 0, all four checks ok.
- `mec restore --target`: exit 0, and `mec.db` present.
- A restore into an empty scratch `HOME`, then a server started on it: it booted, `mec status` answered, and it exited 0.

## Not proven

- No real transcript was used, so the token shapes are proven only on synthetic values. Handoff 33 B still has that check.
- Recovery on a restored store whose worktrees have lost their clone has not been exercised.
- The slot re-probe gate was tested on the doc state, and through the smoke only on a store with no slots.
