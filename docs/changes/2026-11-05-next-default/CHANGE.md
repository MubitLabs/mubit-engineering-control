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

## Why

Decision #35: flip to the new UI, keep `?ui=classic` for one verified install, and remove classic in the next release.

## Not changed

- `#/wizard`, which the launcher opens on an unfinished setup, already resolves to Setup in the new shell. A test now pins it.
- Classic's "add ?ui=next" hints stay true: classic is now reached only by choice.
- Spec §18 still says the new shell is behind a default-off flag. The handoff gives that sentence to Stage C, so it was left, and it is false until then.

## Rollback

Revert this commit, or `?ui=classic` per browser. No stored data changes.
