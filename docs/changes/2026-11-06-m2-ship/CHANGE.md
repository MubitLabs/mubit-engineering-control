# M2 ship

One linear branch from `origin/main` (#46), landed as one PR by the owner's approval.

## Replayed, in this order

| Item | Branch | Range |
| --- | --- | --- |
| 21 | `feat/m2.2-coordination` | `7ec7476..590568c` |
| Slot preference | `fix/slot-class-preference` | `590568c..0874a7b` |
| 22 | `feat/m2.3-delivery` | `296b272..48f9b4f` |
| 23 B | `feat/m2.4b-engines` | `7ec7476..7d15f9d` |
| 23 A | `feat/m2.4-recovery` | `53b6992..b82fa65` |
| 30 S2 | `feat/inspection-live` | `53b6992..000ac04` |
| 32 stage B | `feat/recovery-controls` | `f02cd7e` alone |
| 31 C | `feat/work-evidence` | `11e2a4e`, `277554f`, `f9ae9d9` |

32's first two commits in `9ecc226..f02cd7e` replay #38 and #40, which are on main, so only its last commit was picked. 31 C's earlier commits merge `feat/work-live`, which is #38.

## What the semantic checks changed

- **Cleaner.** A park reason and the handoff pack now go through the attempt's cleaner. Cards and handbacks from the other branches already did, or are the owner's own text. Delivery's blocked reasons now sweep key last-fours.
- **Stop and hold.** A stop withdraws an open `slot_switch` card at the approve, a hold keeps it pending, and a card approved before a hold waits for the lift. Parked resume and 32's routes already honoured both.
- **Data root and port.** An empty `MEC_DATA_DIR` is unset in `bin/mec.js`, `mecRoot` and the planner's prompt root, as in `cliHome`. `mec restart` and the last port already agreed.
- **Refusals.** Readiness uses `lacksHome`, so there is one rule for a slot's home. A retired meta slot is refused by name with or without a home.
- **`slot_switch` cards.** `request_confirmation` refuses the class, even where policy pre-authorises it. The card names the owner as its asker.

## Found while merging

- `Supervisor`'s confirmation changed under `reapGroup`. `reapGroup` now is that stop, so a boot reap reaches strays too.
- Claude's stream input needs a stdin pipe, and 23 B's Claude row asked for none. The row now asks for one.
- The stage's reset read moved from `inspection.ts` to `stages.ts`, so 32's fix went there.
- `/api/parked` leaves out an attempt that is resuming, as the switch does.
- Delivery read the configured policy, not the one saved in Settings.
- `Monitor` joins the planner's denied tools: Claude 2.1.319 ships it with code execution.

## Mutants

43 stale `find` strings were repaired, 25 of them already stale on main. `tools/mutants/m2-ship.json` covers the new gates.

## Unproven

- A sandboxed worker's shell cannot reach the loopback `/api/inbox/:id/resolve` route. The route has no auth for non-browser callers and rests on `network.strictAllowlist`.
- The delivery policy line has no test of its own.
- A backup restored into a new data dir carries the old last port and old process marks. Neither was tried.
- No real engine ran on this branch.
