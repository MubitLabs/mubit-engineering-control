# Version 0.3.1

7 November 2026. Prepared on `chore/version-0.3.1` from `origin/main` at `3b40f25` (#51), and brought onto `fix/ceiling-and-reference` (base `8d8bc8f`, #52) on 8 November 2026. Docs and versions only. Nothing is tagged, pushed, released or installed by this change.

## What

- `package.json`, `apps/desktop/package.json`, `apps/web/package.json`: `0.3.0` to `0.3.1`, as `07000f2` did for 0.3.0. `packages/*` stay at `0.1.0`. The tarball is `mec-0.3.1.tgz`. `apps/desktop/test/version-sync.test.ts` and the release workflow's tag guard already enforce the three agreeing and the tag being `v0.3.1`.
- `docs/CHANGELOG.md`: a 0.3.1 section from `docs/changes/2026-11-06-core-ship/` and its neighbours.
- `RELEASE-RUNBOOK.md` beside this file: the steps for the coordinator, adapted from 0.3.0's.
- `docs/DECISIONS.md` #47-#53 and `docs/plan/spec.md` §10, §11 and §12.1 carry the owner rulings of 6 November 2026 that were pending. #54-#61 add the rulings of 7 and 8 November.
- The journey checkpoint and progress page are not changed here: the coordinator owns them.

## Not changed

- No code, no migration: no migration file under `packages/store` changed since `v0.2.1`; `packages/contracts` is untouched.
- `?ui=classic` stays in this release (decision #48). Removal waits for a real PR and merge on the installed build.
- The installed 0.3.0 was restarted with the real runner off until this release (decision #51). This change does not touch the install.

## Rollback

Revert the commit before tagging. After a release, see the runbook.
