# M3.4 Stage B: the new shell is the default

6 November 2026. Handoff `docs/changes/2026-11-05-meta-agent-journeys/handoffs/33-m3.4-accessibility-local-release.md`, Stage B, the non-engine part. Decision #35. The handoff's "Start when" and "Nothing alongside" were waived by the coordinator, so this lands beneath or beside seven in-flight branches and is kept small.

## What

- `apps/web/src/ui-flag.ts`: **intended behaviour change.** Anything but a durable `classic` is `next`: no choice, an unknown param, an unknown stored value and a store that throws. `?ui=classic` and a stored `classic` still work. `?ui=next` still turns a stored `classic` off.
- `apps/web/src/live/surfaces.tsx`: Open Setup was `?ui=classic#setup`. With the flip that would have sent every first run to classic and stored the choice. It is now `#setup`, the new shell's own Setup.
- The way back is the palette's existing "Return to the classic workbench", now under test, plus the link in the empty states.
- `apps/web/test/screens.playwright.ts`: the classic suite pins `mec-ui-shell` to `classic`, because it no longer gets classic by default. No assertion changed.
- `apps/web/test/a11y.screens.playwright.ts`: axe on the six surfaces at 1440, 1024 and 390, light and dark, plus inspector, palette, drawer, the harness states and the default entry.

Fixes axe found, presentation only:

- `next/Sidebar.tsx`, `next/Toolbar.tsx`: `aria-label` hid the visible text (`label-content-name-mismatch`). The name now comes from the content with screen-reader-only words around it.
- `next/states.tsx`, `next/shell.css`: a notice's heading is `h2`, not `h3`, so it does not skip a level. The look is unchanged and no baseline moved.

### The checks after the flip

`apps/web/test/limits.screens.playwright.ts`, `keyboard.screens.playwright.ts`, `limits.ts` and `matrix-cells.ts`: the numeric limits over the whole matrix, and the keyboard journey on every surface. Axe moved onto the same cells, which adds the sheets, working, resolved and expired. `scripts/lighthouse.mjs` gained `--theme`.

What they found, presentation only (`next/shell.css`, `live/LiveApp.tsx`):

- Send could shrink to 41px at 390. Tabs were under target width: Diff was 20px on desktop.
- The palette and search fields had no 3:1 edge. Their only line was the 1.3:1 hairline.
- A long status was cut off at 390. "Waiting for quota (resets 14:00)" could not wrap.
- Rings were clipped by `.delivery` and `.search-results`, and by the scroller's edge when Tab landed on the last visible row.
- The rail footnote said "Conversation, Work and Needs you are live", which stopped being the whole truth at M3.3. It now says "Local workspace", as the preview does.

What they found, **keyboard behaviour** (`next/Shell.tsx`, `next/primitives.tsx`, `next/ConnectionsView.tsx`, `next/SettingsView.tsx`, `next/SaveBar.tsx`, `next/GlossarySheet.tsx`):

- Route focus missed the heading on Connections, Setup and Settings. Those surfaces read first, so the heading was either not there yet or was replaced after loading, which dropped focus to the body. The shell now follows a late or redrawn heading, unless the person has already moved on.
- Add connection, Add repository, Replace key and Retire left focus on nothing when their form opened or closed. Focus now goes into the form and back to the button. A retired row hands focus to Add connection.
- Save and Discard left focus on nothing when the bar went away. It returns to the field.
- The glossary list scrolled on a short screen but could not be reached by keyboard. It is now a named, focusable region, one new Tab stop.

## Why

Decision #35: flip to the new UI, keep `?ui=classic` for one verified install, and remove classic in the next release.

## Not changed

- `#/wizard`, which the launcher opens on an unfinished setup, already resolves to Setup in the new shell. A test now pins it.
- Classic's "add ?ui=next" hints stay true: classic is now reached only by choice.
- Spec §18 still says the new shell is behind a default-off flag. The handoff gives that sentence to Stage C, so it was left, and it is false until then.

## Rollback

Revert this commit, or `?ui=classic` per browser. No stored data changes.
