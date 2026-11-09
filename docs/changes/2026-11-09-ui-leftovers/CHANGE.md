# UI leftovers: a finished sign-in checks itself, and a linked tab says so

Branch `fix/ui-leftovers`, base 77bcdb4 (0.3.4). Both findings come from Chrome on installed 0.3.4, on 9 November 2026.

## 1. A fresh Codex sign-in stayed "Not checked yet" until Check again

**Cause.** Nothing probed a slot when its sign-in ended. `POST /api/slots/dedicated` saves the slot as `home_ready`, which Connections words as "Not checked yet". `POST /api/slots/login` started the card with a no-op listener (`server.ts`, `loginCards.start({ engine, slotHome }, () => {})`). `LoginCardManager.onExit` only reported `exit`. The only probe after a sign-in was the web card's "Check the sign-in" button (`live/config.tsx` `finish`). If the owner closed the card, moved away or did not press that button, the slot stayed `home_ready`. Pressing "Check again" (`POST /api/slots/:id/probe`) then made it Healthy.

The brief points at `packages/slots/src/lifecycle.ts` (`login_started` → `probe_ok`). That `SlotMachine` is not on this path. The probe route writes `state` straight to the store doc and never goes through `SlotMachine`, and nothing in `apps/desktop` sends `login_started`. So the missing step was the probe after the card ended, not a lifecycle edge. This change does not wire `SlotMachine` in.

**Change.**
- `login-cards.ts`: `start(req, onData, afterExit?)`. When the vendor command exits, `afterExit(code)` runs, and `exit` is reported only once it settles. If the check fails, `exit` is still reported. A cancel or a timeout never runs it. The card leaves `current` when the process exits, so another login can start while the check runs.
- `config-routes.ts`: the probe route's body moves into `probeSignedInSlot` (exported). The route behaves as before.
- `server.ts` `POST /api/slots/login`: passes an `afterExit` that finds the slot by its home (sign-in kinds only, not retired) and runs `probeSignedInSlot`. It runs after any exit, so a failed sign-in reads "Needs attention" (`auth_expired`) and not "Not checked yet".
- `live/config.tsx`: on the card's `exit` event the Connections/Setup reads refresh. The server saved the check before it sent `exit`, so the row shows the result without a press. The "Check the sign-in" button stays. It probes again and closes the card.

## 2. The red "not linked" line stayed after the tab was linked

**Cause.** `LiveApp.tsx` `failureText` built the composer's failure line from the submission's error alone (`approval_required`). The composer's `ApprovalLink` notice subscribes to the key (`useApprovalKey`) and so went away on linking. The failure line did not subscribe, so it kept saying "not linked … link this browser, then Retry" until Retry.

**Change.** `LiveApp` reads `useApprovalKey()` and passes it to `failureText`. Once the tab is linked, the same line reads "This browser is linked now. The message was not sent before and is kept here: press Retry to send it." The line stays and so does Retry. Nothing is resent by itself, as with `NotLinkedNotice`.

## Test seams

- `apps/web/test/fixtures/config-harness.tsx`: the stub `EventSource` keeps every instance in `window.__sources`, so a test can deliver a frame the real server would send.
- `apps/web/test/fixtures/config-server.ts`: `checkedAfterSignIn(label)` stands in for the server's check after a sign-in.
