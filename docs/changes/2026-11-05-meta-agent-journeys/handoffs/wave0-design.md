<!-- Wave 0 scout report, 5 November 2026, base a102313. Leads, not facts: check against source. -->

**Ran.** `pnpm install --frozen-lockfile` passed at a102313. `node proto-audit.cjs` and `p2.cjs` (repo Playwright 1.64.1, chromium headless) covered 6 surfaces and 5 Settings tabs, light and dark, at 1440/1024/390, plus inspector tabs, palette, repo switch, approval, drawer and 320/short viewports. Result: 0 console errors, 0 page errors, 0 network requests, worktree clean. axe, Lighthouse and `vite build` were not run (axe/Lighthouse are not installed). Contrast was computed from token hexes. Everything below labelled "source" was read, not run.

**Prototype defects (all observed unless noted). Blockers:**
1. Shell is unbounded at every viewport. `.shell` has no row cap, so `.workspace` grows to 1042px against a 868px shell. `#screen` never scrolls and the document does. At 1440×900 the composer top is y=908, and Connections/Setup/Settings sit below the fold. On scroll the toolbar goes to y=-142. Composer is off-screen at load in all three sizes (except Empty). Fix: `grid-template-rows:minmax(0,1fr)`, as `workbench.css:90-97` already does; then anchor the composer.
2. 390 drawer has no dismissal on touch: the rail covers the menu button, tap outside does nothing, and there is no close control or scrim. It stays open after a repo switch. No `aria-expanded`, no focus move or trap.
3. 390 toolbar: repo name and route wrap to 2 lines, and the menu button shrinks to 30–39px on some routes. 320 has 55px page overflow. ⌘K is hidden at ≤760 with no touch route to commands.
4. `/` inside an open modal navigates behind it and moves focus to the composer, escaping the trap.
5. "Ask about this work" at 390 leaves the sheet open with focus on the covered composer. At 1024 the sheet stays open too.
6. Inspector is `aria-modal=true` at <1150 but the background stays clickable: no scrim, `inert` unset, and the `.inspector:not([hidden])+*` rule matches nothing. `role`/`aria-modal` are not removed on close. Resizing 1440→390 leaves it open with no `role` (so no modal semantics). At exactly 1150, CSS says overlay and JS says wide.

**Truthfulness:**
7. Inspector ignores `state`. Completed still says "Checks have not run yet" and "Adding search". Empty still shows the task inspector.
8. All three task rows open "Build the search experience", and no row has a selected state (spec: originating row stays selected).
9. Working state shows "Checks passed on this commit" on Needs you while the same delivery says Implementing/Waiting.
10. Blocked: the question is not on Needs you, only a modal from Conversation.
11. Resolved approval carries into the other repo. Conversation still says "Waiting for your push approval" after approving. Details on an empty Needs you opens approval evidence.
12. Amber remains on the "0" chip and the resolved label, against "amber only where attention is needed".
13. No expired example exists, though the UI-OVERHAUL acceptance lists one.

**Focus and a11y:**
14. Focus falls to BODY after Esc disarm, 8s disarm and confirm; after ⌘K twice then Esc; and after closing an inspector opened from the 390 Recent item.
15. Composer textarea has no focus ring: `outline-style:none` while `:focus-visible` (`.composer textarea` wins on source order), and no `:focus-within` substitute.
16. Control boundaries fail the 3:1 target: `--line` is 1.26 light and 1.34 dark on surface.
17. `--secondary` on `--selected` is 4.34 in light (below 4.5). All other text pairs pass.
18. Text under 12px: composer note 11.5, banner 11, ✓ 11.
19. Targets under 44 at 390: most `.btn` 40, state select 33, text-buttons 25, tabs 41. At desktop, text-buttons are 25 (below 32).
20. Palette has no input, though global search is promised. Theme via palette leaves a stale rail `aria-label` and the modal open.
21. No `aria-current` on nav and no `aria-labelledby` on the tabpanel (observed). No Auto/`prefers-color-scheme`, no focus move on route change, no live region for armed state, `isComposing` unhandled on Enter (source).

**Passed:** two-step approval (arm, Esc, unrelated click, 8s, nav-away, confirm, deny), per-repo drafts, no page-level X-overflow at 390/1024/1440, tab cycle inside the sheet.

**Source answers (apps/web/src):**
- Routing: hash only, `router.ts:8-44`; six routes plus aliases; `slots` is the Connections route.
- Shell: `App.tsx:25-32,147-175`, inline keyboard closure at `:41-140`.
- Store: `WorkbenchProvider` at `workbench.tsx:131`. Theme is `mec-theme` plus `data-theme`, `:116-128,163-171`.
- CSS: global `tokens.css` and `workbench.css` (1314 lines) imported eagerly at `main.tsx:4-5`. Class names are the component API (`base.tsx:3`).
- Inventory: 14 components, 6 views, 30 `useWorkbench()` calls.
- Mock trap: `api.ts:16-24` imports `mocks.ts` into production, and `withDemo` (`api.ts:362-370`) serves demo data on 404, labelled `demo:true`. That is M1.1's to remove. Other mocks reach only `test/screens.playwright.ts:2-11`.

**Flag proposal.**
- New pure `src/ui-flag.ts`: `resolveShell(search, storage)` returns `'classic' | 'next'`.
- `?ui=next` or `?ui=classic` writes `mec-ui-shell`, then `replaceState` strips the param. Absent, unknown or a throwing store gives classic.
- The param survives routing because the router touches only the hash, and `server.ts:1891` drops the query.
- No server capability for VF0: it is presentation only and grants no authority (`CHANGE.md:115`). An additive `/api/status` capability can come when live paths connect. No Settings or palette entry until verified.
- Tokens and classes collide (`--canvas`, `.rail`, `.composer`, `.btn`, `.decision`), so select at the entry: `main.tsx` dynamically imports `./classic-entry` or `./next/entry`. Each shell then loads only its own CSS, assuming Vite's default CSS code-splitting (not built here). Prefix nothing and scope nothing.
- Risk: async first render. Run `pnpm test:screens` to confirm classic is unchanged.
- `apps/desktop/src` sets no CSP, despite `04_UI_DESIGN_SPEC.md:108`, so dynamic chunks are unaffected.

**VF0 file map** (all new, under `apps/web/src/next/`):
- `entry.tsx`: root; imports CSS.
- `tokens.css`: light/dark plus Auto via `data-theme`; no `@font-face`.
- `base.css`: system type stack, reset, 2px focus ring, reduced motion.
- `Shell.tsx`, `shell.css`: `minmax(0,1fr)` rows, single scroller, skip link.
- `Sidebar.tsx`: repo switch, nav, drawer with close, scrim, `aria-current`.
- `Toolbar.tsx`
- `ComposerFrame.tsx`: anchored; props only.
- `Inspector.tsx`, `InspectorTabs.tsx`
- `Sheet.tsx`: modal, drawer and sheet with real inert/trap and focus return.
- `CommandPalette.tsx`
- `Decision.tsx`: approval/question frame with two-step and focus retained after re-render.
- `states.tsx`: empty, working, blocked, error, completed, resolved, expired.
- `primitives.tsx`: Button, IconButton, Status.
- `keyboard.ts`: Escape stack, ⌘K, `/`.

Also new:
- `src/classic-entry.tsx`: moved `App` and CSS imports.
- `src/ui-flag.ts`
- `apps/web/test/ui-flag.test.ts`
- `apps/web/test/next.screens.playwright.ts`: already matches the `testMatch` regex, so no config change.
- `apps/web/test/fixtures/next-*.ts`: synthetic data stays out of `src`.

Rule: `next/*` imports neither `api.ts` nor `mocks.ts`; components take props, and M1.3 binds them.

Existing files touched: only `main.tsx`, about 6 lines. Not touched: `workbench.tsx`, `router.ts`, `state.ts`, `api.ts`, `views/*`, `components/*`, `App.tsx`, `index.html`, `public/fonts`.

Sequencing: `CHANGE.md:84` still places the visual foundation inside M1.3; split VF0 out in that record.

**Superseded on approval only:**
- `docs/review/2026-11-04/04_UI_DESIGN_SPEC.md` (§3 tokens at `:22`, port plan, `:104` target screenshot). Keep its no-runtime-font rule at `:108`.
- That folder's `README.md:10-15` and `PROMPT_FOR_CLAUDE_CODE.md:15`.
- `docs/design/prototype/{index.html,tokens.css,workbench.css,workbench.js}`.
- `docs/design/screens/` (12 PNGs).
- `apps/web/test/__screenshots__` (16 darwin baselines), which stay valid for classic until old-shell removal.
- Comments in `playwright.config.ts:7`, `screens.playwright.ts:17`, `router.ts:4`, `api.ts:7`.
- `apps/web/public/fonts` (6 files), removed with the old shell.

**Amendment record:** Neither `spec.md` nor any owner doc names Instrument Sans or the old tokens; those live only in the files above. But `spec.md:679` (§18) requires "compact, terminal-friendly typography, uppercase status labels, one restrained accent", which directly conflicts with `UI-OVERHAUL.md:15,17`. Under repo rule 3 the amendment must change that line. Decisions #10-13 do not cover the design. §18's Settings item also lists check profiles, isolation profiles and pause, while `UI-OVERHAUL.md:35` has Policy/Prompts/Models/Repositories/Backups: owner decision needed. §18 names Chat/Inbox/Work/Slots against Conversation/Needs you/Connections: note as a rename.

**Screenshots:** `/private/tmp/claude-501/-Users-shankhadutta-code-mubit-engineering-control/2df31a5d-d987-49c0-b14f-93aa17eec939/scratchpad/prototype/` (133 PNGs; raw data in `audit.json` and `audit-probes.json`). Scripts: `/private/tmp/claude-501/-Users-shankhadutta-code-mubit-engineering-control/2df31a5d-d987-49c0-b14f-93aa17eec939/scratchpad/proto-audit.cjs` and `/private/tmp/claude-501/-Users-shankhadutta-code-mubit-engineering-control/2df31a5d-d987-49c0-b14f-93aa17eec939/scratchpad/p2.cjs`.
