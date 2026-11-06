# Five known gaps

Base `7ec7476`. None of the five was already fixed on main. One commit each.

## What changed

1. **`.repo-switch` a11y.** `label-content-name-mismatch`: an `aria-label` replaced the visible name and detail. The extra words are now `sr-only` text around the visible label, so the name still starts `Repository: <name>` and ends `Switch repository`. The first fix attempt showed a second node hidden behind it, the command palette button, because the gate printed only `nodes[0]`. That button gets the same fix and the gate now prints every node. The harness axe test that `2026-11-05-a11y-runner` had to leave out is now in the suite.
2. **`setup: true`.** No web client ever sent it. There was no surface to send it from, though Settings already shows "Proposed in setup chat". Setup gets a small chat, `configApi.setupMessage`, sending `{ text, setup: true }` with no `repoId`, so it works with zero repositories. Only the last answer shows; the server holds the pending drafts. The key-shaped path answers in `message`, not `reply`, so the decoder reads both.
3. **`slot_claude_probe`.** `metaSlotRefusal` and the connection step now need a home or a linked default login. `readiness.ts` keeps a local `hasLogin`: `isLaunchableSlot` also excludes key slots, which are connections, and M2.4b moves `lacksHome`, so importing it would conflict.
4. **`cliMain`.** Uses `process.env.MEC_DATA_DIR ?? ~/.mec`, as `bin/mec.js` does.
5. **Slot scheduling fields.** Nothing on main writes `concurrency`, `slotClass` or `usageUtilization`: no route, no form, no stream. M2.2 reads all three and adds no writer. So this is the honest-default path, not new controls: a Connections row shows `concurrency` and `slotClass` when set, and "Default limit" and "None set" when not. "Usage" already read "No reading yet". The words carry no number because the default differs: `1` on main (`service.ts:1208`), `caps.perSlot` on M2.2. Editing them was not small: it needs a write route, a form and a rule for a running slot.

## Left open

- **A planner `slot_class` hint cannot place anywhere.** `planDispatches` requires `slot.slotClass === task.slotClass`, and no slot has a class, so a hinted task defers with the reason `slot_unhealthy`, on main and on M2.2. This is the one real consequence of gap 5. What should happen is a spec question (§10 calls it a task's "slot class preference": a preference or a requirement?).
- **`has_slot` in `/api/status` still counts any slot doc**, the probe and retired slots included. `server.test.ts` asserts that for a bare doc, so it is a deliberate meaning, not touched here.
- **`usageUtilization` is not surfaced.** If something writes it, the row keeps saying "No reading yet" until `usage` gets a real shape.
- **Classic UI** gets no setup chat.
- **Setup chat replies** are not reloaded after a page refresh, and `openLoginCard` / `openKeyForm` in the answer are not acted on.
- **`handoffs/00-README.md` and `30-m3.1` still say** `mec status` ignores `MEC_DATA_DIR`. Their recipes stay safe, because they set both to the same place.
