# Ship restart

Two owner rulings and one review fix, on `fix/ship-restart` from `fix/ship-hardening` at `857a12a`.

1. **A policy change gives a queued attempt's capacity back (§10).** `refuseLaunch` now fails a still-queued attempt on `policy_changed` through `failLaunch`, and the work stays blocked with the reason. This supersedes "Left as it was" in `2026-11-06-ship-hardening`. An attempt that never started is not the live work §13 protects. Running attempts are not touched. **Intended behaviour change:** `composition.test.ts` "a launch under a changed policy is dropped and blocks the work" and the matching test in `authority.test.ts` used to pin that the attempt stays queued.
2. **A dropped row keeps an attempt no boot could clear (§8.1).** `refuseLaunch` no longer fails a queued attempt with `reconcile_refused` set, on any reason. Failing it stopped boot retrying the group and released capacity beside a group not proven gone. A `policy_changed` drop still blocks the work.
3. **`mec restart` restarts (§21).** New `apps/desktop/src/restart.ts`. It reads the data dir's `.mec.lock` and `health.json`, sends SIGTERM to a proven pid, waits up to 45 s for it to exit, and starts a detached server from the same install. That server takes the last port through `listenOnLastPort`. Success is reported only when the new pid has written its port into `health.json`, so it means listening, not spawned. **Intended behaviour change:** the honest-error test in `mec-cli.test.ts` now asserts the outcome's own lines, and `CliIo.startServer` is `restartServer`.

## What proves a pid

The lock and `health.json` must name the same live pid, and that pid must be the process that wrote them. `health.json` now carries `started`, the same `ps` start time a launch mark uses (§8.1). It is compared whenever present, so a hung server with a stale heartbeat can still be stopped and a reused pid cannot be signalled.

A server from before this change has no `started`. It needs a heartbeat under 10 s old and a `mec` command line. Without that path, the first restart after an upgrade would refuse.

Everything else is refused with nothing signalled: a lock with no pid, a lock and snapshot that disagree, a live lock owner with no matching snapshot (a server still starting or stopping), and a live writer with no lock.

`DirLock` is unchanged and remains the only guard against a second writer. Two restarts at once can both pass `findServer`; the second new server is refused by the lock and that command exits 1.

## Choices

- **SIGTERM only.** A server that will not stop is reported. Nothing escalates to SIGKILL.
- **45 s stop bound.** `close()` allows three 10 s bounds and a 5 s planner grace.
- **The stop marker clears before the stop**, as it did, so a refused restart still clears it. `mec restart` is the owner asking for a running server.
- **No log for the detached server.** Its output can carry `[engine:stderr]` lines, and a file would be a durable write that no redaction runs before (AGENTS non-negotiable 5). A failed start says to run `mec`.
- **`MEC_NO_OPEN=1` on the new server.** A restart does not open a browser.

## Risks

- The new server takes the environment of the shell that ran `mec restart`, not the old server's. A server started with `MEC_REAL_RUNNER=1` or `MEC_META_SLOT` comes back without them unless the shell has them too.
- A detached server's `console` output is discarded, including `[scheduler]`, `[recovery]` and `[delivery]` failures that a foreground `mec` shows.
- If the old server's parent never reaps it, the zombie still reads as alive and the restart reports a timeout.
- `mec stop` still only writes the marker. It does not stop a running server.
