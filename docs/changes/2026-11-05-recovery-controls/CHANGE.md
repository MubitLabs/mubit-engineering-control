# M3.3 Stage B: recovery controls, and the port across restarts

Handoff: `docs/changes/2026-11-05-meta-agent-journeys/handoffs/32-m3.3-setup-configuration.md`, Stage B.

## What changed

- `capabilities.switchWork` is true when the `POST /api/work/:id/switch-slot` route is wired. Drain stays false.
- New `GET /api/parked` (`config-routes.ts`): every parked attempt that has not moved, with the slot, the reason, the reported reset or null, and whether a worktree is on record. A reset nobody reported stays null. The reason is redacted on the way out.
- `ParkedNotices` shows those facts on the connection and on the delivery in Work. Switch work names the target and what happens, then shows what the route answered: a confirmation to approve in Needs you, a move, or the refusal in words. An auth park offers Sign in again and no switch, and so does its work item's other parks, because the route refuses the whole item.
- The Work stage read `resetsAt`, which nothing writes; parking writes `parked.resets_at`. A reported reset showed as unknown beside a chat notice that named it. It now reads the park.
- `slot_switch` cards have their own label in Needs you.
- Owner ruling: a restart reuses the last port, so an open tab stays connected. If that port is taken, MEC takes an ephemeral one, remembers it, and prints a second line after `mec server listening on`. The port is a doc at `settings/server-port`; no SQL change. Only `serveMain` asks for this (`reuseLastPort`): `startServer` stays ephemeral by default, because an in-process client's keep-alive connection meets a reset when one process restarts a server on the same port. A real restart crosses processes and is not affected.

## Base

The brief's base `feat/m2.4-recovery` branched at `f232933`, before #37 to #40 landed on main, so it holds neither M3.2 Stage B nor M3.3 Stage A. Stage B has nothing to join without them. The first two commits on this branch replay those squashes (`c8a597c`, `c842f4f`) unchanged, except that the clashes with M2 in `attempt-launch.ts` and `composition.ts` keep both sides. Drop them on landing and take only the commits after them.

## Limits

- `plannerCardDetail` writes "The meta agent asks for: slot switch" on a card the owner opened from the UI. The evidence and approval are right; the asker's name is not. `release.ts` is outside this handoff.
- A moved port is said on the server's stdout only. `mec status` does not show it, and a tab on the old port cannot hear it.
- The Work notice polls every 10 seconds, and only on the Work route.
