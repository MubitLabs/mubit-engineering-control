# Stop confirm: the card survives a regroup, and a lapsed confirm says so

Branch `fix/stop-confirm`, base 9385a34 (v0.3.3).

## The report

The report came from Chrome on the installed 0.3.3, on the Work detail of a blocked delivery. "Stop in …" opened the StopConfirm card. One press armed it, and the armed note showed. The next press on the armed button sent no `POST /api/work/:id/stop`, and the card stayed armed. Release cards in the same build confirmed fine.

## What the reproduction showed

The premise that StopConfirm handles the confirm differently from release cards turned out to be wrong. Both use the same `Approval` component, with the same arming code, the same `ARM_WINDOW_MS` and the same document listeners. The action object, `inspection.act` and the stop route are all fine. A press made inside the window posts the stop, on the mock and on a real scratch server, including for a blocked delivery, with the inspector open, and with a real mouse click.

Two real faults came out of the reproduction, both on a scratch server built from this tree. That server ran the journey rig: fake `claude`, a real store and real git.

1. **The 8-second window lapses silently, and the next press arms again.** Polls do not disarm the card. Instrumented ticks showed `data-armed` staying `true` through a full refresh, then turning `false` at exactly 8 s. The armed note then goes blank, and the next press arms again, sending nothing. Anyone who takes more than 8 s between the two presses sees an armed card and no request. An agent driving Chrome through snapshots and ref clicks almost always takes that long. This is the reported symptom. The window itself is the designed behaviour: "any unrelated action/Escape or 8s disarms", from `docs/changes/2026-11-05-meta-agent-journeys/UI-OVERHAUL.md` §3, tested by "14: eight seconds disarm and focus stays". It is unchanged.
2. **A regroup drops the open stop card.** `DeliveryDetail` held the `stopping` state. Work groups are separate `<section>`s keyed by group. A read that files the row under another group, such as a delivery going from Working to Open as it blocks, mounts the row in a new section. That remounts `DeliveryDetail` and the card disappears. On the scratch server, the card was gone less than 500 ms after the refresh that regrouped the row.

## Change

- `apps/web/src/next/Decision.tsx`
  - When the window runs out on its own, `Approval` records a `lapsed` flag.
  - The armed note then reads *Not done: the confirm lapsed after 8 seconds. Press it again to arm.*
  - Any press on Approve or Deny clears the flag.
  - Escape and unrelated actions still clear the note, because those are the owner's own cancels.
  - The note text is built by the new pure `armedNote(armedLabel, lapsed)`, with `LAPSED_NOTE` derived from `ARM_WINDOW_MS`.
  - This applies to every `Approval`: StopConfirm, release cards and other approval cards.
- `apps/web/src/next/WorkView.tsx`
  - `WorkView` now owns `stopping` and passes it down through `WorkEntry` to `DeliveryDetail`. Only the selected delivery's row receives it, through `stopInView`.
  - When the selection changes, `stopping` is cleared during render, so returning to a row never reopens an old card.
  - On a remount, `DeliveryDetail`'s existing layout effect puts focus on the card's heading.
- `apps/web/src/next/work-model.ts`: new pure `stopInView(stopping, selectedId)`.

**Not changed:** the window length, the arm semantics, `inspection.act` and the stop route.

## Other Decision uses checked

- **`Question`** (Needs you answers) has no arming. It is a form submit.
- **`Approval` on Needs you** (release and other cards) uses the same component. It gets the lapse note. Cards are keyed by id inside fixed waiting and settled lists, so a poll does not remount an open card. A card that moves to Settled is no longer actionable.
- **Hold and lift** are one click, with no confirm.

## Open

- **Arm state on a regroup.** A regroup still remounts `Approval`, so a card that was *armed* when its row changed group comes back unarmed. It does not vanish. The next press arms it again, visibly. Keeping the arm itself would need the arm state lifted out of `Approval`, or a group layout that does not remount rows.
- **Window length.** Whether 8 s is right for a stop, given that agents driving the UI routinely take longer, is an owner decision. It is not changed here.
