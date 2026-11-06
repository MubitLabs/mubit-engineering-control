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

## Blocker fixes

Both were reproduced at `dab7803`, on synthetic values.

**A token after a JSON escape reached the archive.** In JSONL a newline is a backslash and an `n`, the `n` is a word character, and every shape starts with `\b`. `redactForBackup` now cuts the text at JSON escapes, backslashes and quotes, and sweeps each piece. The quote cut also fixes the last-four sweep, whose run took in the closing quote and braces. Contracts did not change. Pieces under 20 characters skip the sweep, because no shape is that short: without this a 10 MB transcript took 1386 ms, with it 119 ms, against 102 ms for `redact` on the whole text.

**`--out` could drop the state tree with no warning.** `backup()` skipped everything under `outDir`, so `--out <home>`, `--out <data dir>` and `--out <data dir>/prompts` all exited 0 and lost state. It now skips only its own staging folder, archives named `mec-backup-*.tgz` directly in `outDir`, and the `outDir` folder entry. A folder that held only archives still stays out, as `backups-route.test.ts` requires. A file beside them is kept. This goes beyond the refusal the finding offered as the smallest fix, because a refusal for parents would have left the `--out <data dir>/prompts` case open, and `--out ~` now works.

Failing first: 15 of 44 failed in `backup-cli.test.ts`, each for its blocker (the token in the file or the database copy, or the missing state). The byte-for-byte test passed before and after. After: 44 of 44, and `backup.test.ts`, `backups-route.test.ts` and `restore.test.ts` green, with no existing assertion changed.

The `c3` row added to the store fixture holds a token after an escape, so the database copy is covered too.

Mutants: `python3 tools/mutants/run.py tools/mutants/backup-cli.json`, self-check correct, 32 of 32 killed, ten of them new.

`pnpm check`: typecheck and lint clean. Tests: 2583 passed, 4 failed, 15 skipped. One is the documented `login-cards.test.ts` baseline. `a11y-gate.test.ts`, `attempt-launch.test.ts` and `bundle.test.ts` each failed on a 30-45 s test while other builds ran, and passed when rerun alone, 51 of 51.

## Not proven

- No real transcript was used, so the token shapes are proven only on synthetic values. Handoff 33 B still has that check.
- Recovery on a restored store whose worktrees have lost their clone has not been exercised.
- The slot re-probe gate was tested on the doc state, and through the smoke only on a store with no slots.
