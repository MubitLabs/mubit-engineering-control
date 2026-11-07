# Hold capacity while a stuck group lives

From `origin/main` at `1900dcb`. Spec §8.1 and the owner's ruling: an attempt whose group refused to die stays failed, and its capacity stays held until the group is actually gone.

## The gap

`docs/changes/2026-11-06-m2-ship/CHANGE.md` recorded it. The monitor records a failed stop and a failed attempt, as 23 B's §8.1 test needs. `failed` is not an occupying state and `reconcileProcesses` skips it, so the slot unit came free while the group ran on.

## What changed

- **What is held.** `Supervisor.survivors` lists the group and the strays still alive, each with its start time. The stored `process` mark alone is not enough: in the case 23 B's test drives, the leader's group is gone and a command in its own group is what remains, and no parentage leads to it after a restart.
- **Where it lives.** The monitor's failure path passes those to `stopFailed`, which saves them as `held_groups` on the attempt doc. Attempts are JSON docs, so there is no SQL migration, and `packages/contracts` is untouched.
- **Capacity.** `holdsGroup` is the one rule. The scheduler's `active` list and the resume's `inUse` count it. `occupies` itself does not change, so the task still blocks on its failed attempt and the owner hears about it. The same `active` row keeps a new attempt of that task from starting beside the group.
- **Release.** `reconcileHeld` runs at boot, first in `reconcileProcesses`, and on the 2 s pass with one look at a time. Each mark goes through the identity rules: `ours` is reaped, `unprovable` is never signalled, `gone` and `recycled` count as gone. Marks that have gone leave the list. When none are left, `held_groups` goes and `attempt.capacity_released` is appended. The attempt's state is never touched.
- **Visible.** `processOutcome` on `GET /api/inspect/tasks/:id` adds `(process group still running, capacity held)`. It is an existing field with no new UI. `attempt.stop_failed` and `attempt.capacity_released` are in the attempt's event stream.

`plannerGroupLeft` is now `groupLeft`, because both callers need the same answer.

## Limits

- A mark taken while `ps` failed, or for a group with no leader, has an empty start time. If that pid later leads a process, the mark reads as recycled and the hold is released.
- A group with no leader, or a stray that leads no group, is `unprovable`, so nothing signals it after a restart. It stays held until it goes by itself.
- The hold is recorded only where an attempt ends with a refused stop, in the monitor's failure path. An attempt that stays `running` after a refused stop already occupies its slot.
- A boot that finds an orphaned command with no refused stop on record is unchanged: `docs/known-limits.md` still applies.
- Worktree cleanup does not look at `held_groups`.
- A held group fills a slot unit indefinitely if it never goes. That is the ruling. No alert or timeout was added.
