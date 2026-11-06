# `mec backup` and `mec restore`

Spec §20 (Database-corruption row) and §21.1 promise both commands. The engines existed in `apps/desktop/src/backup.ts` and `restore.ts`, and only Settings could take a backup. The CLI had neither.

## What changed

- `apps/desktop/src/backup-cli.ts` is new: `mec backup [--out <dir>]`, `mec restore <archive> [--target <dir>]`, `mec restore --drill <archive>`, and `backupStore`, which Settings and the CLI both use.
- `backup()` reads each file once and writes it through `redactForBackup`. A file redaction cannot read is left out by name. `repos/` is left out whole. The archive is mode 0600.
- `redactForBackup` is `redact()` plus two shapes: a `MEC_TOOLS_TOKEN` (base64url JSON and a signature) and any bearer header. `redact()` catches a tools token only by exact value, and that value is gone after its process ends.
- The database copy, never the live store, has every text value redacted, then a VACUUM to drop the freed pages.
- `restoreStore` stages the archive beside the target, verifies it, renames `db.sqlite` to `mec.db`, sets every `healthy` slot to `home_ready`, and renames the staging directory onto the target.

## Readings where the spec is silent

- **Restore target.** Any entry at all counts as data. A running server's `.mec.lock` therefore refuses too. Restore has no `--force`: the owner moves a damaged data dir aside.
- **Slot re-probe.** The scheduler and the launcher take only `healthy`, so `healthy` becomes `home_ready`, the state a slot waits for its probe in.
- **Git object stores.** Compressed, so redaction cannot read them, and the brief says redact or leave out. `repos/` goes out whole because `RepoCache` re-clones a missing clone, while a partial one breaks. The cost is that an unpushed `mec/*` commit is not in a backup.
- **Binary files in the state tree.** Left out, including non-UTF-8 files in a worktree.
- **Fingerprints in the database copy.** Not used. The last-four sweep replaces a whole run of non-space text, which could cut a JSON document in two, and each store write already passed it.
- **Schedule.** §20 says "on schedule" and names no interval. None is built; Settings already says so.
- **`--out`, `--target`, `--drill`.** Flag names are ours. §20 names a drill script, and `--drill` runs the existing `runRestoreDrill`.

No migration, no contracts change, no stored data deleted. Only the staging directory a restore created is removed.
