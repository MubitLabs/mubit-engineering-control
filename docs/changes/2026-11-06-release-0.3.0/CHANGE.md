# Version 0.3.0

6 November 2026. Handoff `docs/changes/2026-11-05-meta-agent-journeys/handoffs/33-m3.4-accessibility-local-release.md`, Stage D, prepared on `chore/version-0.3.0` from `feat/next-final` (68c9658). Nothing is tagged, pushed, released or installed by this change.

## What

- `package.json`, `apps/desktop/package.json`, `apps/web/package.json`: `0.2.1` to `0.3.0`, as `29d2df9` did for 0.2.1. `packages/*` stay at `0.1.0`. `scripts/pack-tarball.mjs` reads the desktop version, so the tarball is `mec-0.3.0.tgz`.
- `apps/desktop/test/version-sync.test.ts`: `root, desktop and web agree`. A bump that misses one of the three fails it.
- `.github/workflows/release.yml`, `check` job: one step that fails unless `GITHUB_REF_NAME` is `v` plus the desktop version, so a tag cannot ship a mislabelled tarball (`393144b`).
- `RELEASE-RUNBOOK.md` beside this file: the steps for the coordinator.
- Records reconciled to the composed proof: `docs/STATUS.md`, `docs/agent-workflow/architecture-map.md`, `docs/fault-suite.md`, `docs/CHANGELOG.md`. `docs/known-limits.md` and `docs/log/HANDSHAKES.md` already carry the Stage B entries and are unchanged.

## Not changed

- No migration: no migration file under `packages/store` changed since `v0.2.1`.
- `?ui=classic` stays in this release (decision #35). Removing the old shell is Stage C, after the installed walkthrough.
- Spec §18 still says the new shell is behind a default-off flag. That sentence is Stage C's, and is false until then.

## Rollback

Revert the commit before tagging. After a release, see the runbook.
