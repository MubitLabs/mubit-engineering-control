# VF0: visual foundation behind a default-off flag

5 November 2026. Split out of M1.3 (`docs/changes/2026-11-05-meta-agent-journeys`, candidate M1.3 "Repo workspace and submission intent"). M1.3 keeps the repo selector, per-repo chat/work/drafts, intent and idempotency, and binds these components to live data. VF0 is the presentation layer only.

## What

- `apps/web/src/ui-flag.ts`: `resolveShell(search, storage)`. `?ui=next` or `?ui=classic` writes `mec-ui-shell` and the param is stripped. An absent, unknown or unwritable choice gives classic. The flag is local presentation only: it grants no authority and asks no server.
- `apps/web/src/main.tsx` selects one entry per shell. `classic-entry.tsx` holds what `main.tsx` used to do. Each shell loads only its own CSS, because their tokens and class names collide.
- `apps/web/src/next/`: tokens, base styles, shell, sidebar and drawer, toolbar, anchored composer frame, inspector and tabs, one modal `Sheet` used by every overlay, command palette, approval and question frames, conversation groups, states, the keyboard layer and Auto/Light/Dark theming.
- With `?ui=next` every route says it is not connected yet and offers the way back. It reads nothing and sends nothing. Needs you says decisions are not shown here, never that nothing is waiting.
- Spec §18: the design-language line is amended and the route renames are recorded as presentation names. §18's Settings item is deliberately unchanged.

## Why this shape

Components take props. `next/*` imports neither `api.ts` nor `mocks.ts`, so a decision frame cannot reach an effect: the caller owns it, and no caller is wired. Synthetic data lives only in `apps/web/test/fixtures`, and the harness there is served by the Vite dev server for tests and never built.

Additions to the proposed file map: `NextApp.tsx` (the honest live surfaces), `Conversation.tsx` (message, plan and task groups the design system names), `routes.ts`, `theme.ts`, `styles.ts`.

The harness is typechecked: `apps/web/tsconfig.json` now includes `test/fixtures`. That is the only build-config change.

## Token changes from the approved design

The design's own contrast rules failed on two points, so the tokens changed:

| Token | Design | Now | Reason |
| --- | --- | --- | --- |
| `--secondary` (light) | `#626b78` | `#5b6470` | 4.34:1 on `--selected`, below 4.5:1 |
| `--control-line` | absent | `#7d8590` light, `#7c8593` dark | `--line` is about 1.3:1, so it stays a hairline and controls use this at 3:1 or better |

Also new: `--focus`, `--scrim`, `--hover`, `--green`, `--red`, which the prototype had and the design record did not list. Everything else matches: light canvas `#f7f8fa`, rail `#f0f2f5`, surface `#ffffff`, ink `#20252d`, hairline `#e1e5eb`, selection `#e2e7ed`, amber `#80520b` on `#fff4dc`; dark canvas `#171a20`, rail `#1d2128`, surface `#20252d`, ink `#edf0f5`, secondary `#a4adba`, line `#333a45`, selection `#343d49`, amber `#edc677` on `#3a3020`. System type stack, no font request. 216px rail, 64px toolbar, 680px conversation measure, 336px inspector.

## Prototype defects not repeated

The design audit of the prototype listed 21 defects. Each maps to a test in `apps/web/test/next.screens.playwright.ts`, named with its number, or to a unit guard. Those about live truthfulness (7 to 13) can only be proven at the component level here: the components render exactly their props and have no defaults. The real check of those claims belongs to M3.2.

Shared overlay behaviour, scrim, inert page, trapped Tab, Escape, focus return, lives in `Sheet.tsx` so no surface can opt out. Script and CSS use one layout source: `Shell.tsx` reads `matchMedia` and renders the mode, so they cannot disagree at the 1150px boundary.

## A build trap

A conditional of two dynamic imports, or the same logic as an `if`, is folded by the production build into one preload call with one dependency list. The result built cleanly, passed every dev-server test and served classic's stylesheet and Instrument Sans to the next shell. `main.tsx` therefore keeps its loaders in a table, and `apps/web/test/shell-split.test.ts` runs a real build inside `pnpm check` to hold that.

## Compatibility and risks

- Classic's first render is now behind one dynamic import. The classic screen suite passes untouched against its baselines. A failed chunk shows a plain reload message instead of a blank page.
- The tarball carries more files in `dist/web`. `apps/desktop/src/server.ts` serves any file under that root, so nothing else changes.
- The server drops the query string before resolving a file, so `?ui=next` reaches the SPA fallback unchanged. Not exercised against the real server in this change.
- The next shell's theme uses `mec-next-theme`, so trying it never touches classic's `mec-theme`.
- Rollback: `?ui=classic` for one browser, or revert `main.tsx`. No stored data is involved.

## Superseded on approval, not changed here

`docs/review/2026-11-04/04_UI_DESIGN_SPEC.md`, `docs/design/prototype/`, `docs/design/screens/`, `apps/web/public/fonts` and the 16 classic baselines stay valid for classic until the old shell is removed. No old CSS, font or view is altered.
