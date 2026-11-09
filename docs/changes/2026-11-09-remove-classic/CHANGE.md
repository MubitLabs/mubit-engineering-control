# The classic shell is gone, and J, A and G then W in the new shell

9 November 2026. Re-created on `origin/main` at `7a7dd82` (#53), branch `chore/remove-classic-032`. The held branch `chore/remove-classic-final` (tip `666b530`) was built on commits since squash-merged as #47 to #53. Only its net new work is carried here: `c22ffde` (M3.4 Stage C, the removal) with `7ae1dc1`, `b6f3737` and `7b289a6`, and `2a67a58` (the shortcuts). Main is authoritative for everything else. First written 6 November 2026 for handoff `docs/changes/2026-11-05-meta-agent-journeys/handoffs/33-m3.4-accessibility-local-release.md`, Stage C.

**Merge gate, for the owner.** Decision #35 put the removal in 0.3.1; decision #48 holds it until a real pull request and merge pass on the installed build. Nothing in `docs/log/HANDSHAKES.md` or `docs/STATUS.md` records that pass yet. This branch does not decide it, and no decision row is added here.

## Re-creation on main

- The cherry-picks applied cleanly except `apps/web/src/main.tsx` and the six `live-*` baselines.
- **`main.tsx`.** Main added `startApproval()` (#51) before the shell choice. The resolution keeps it: the approval code leaves the address first, then the one shell is imported and mounted. Nothing else of the shell choice survives. New `test/bootstrap.test.ts` pins the order and the reload message, and `tools/mutants/remove-classic.json` holds three mutants on it.
- **`live-*` baselines.** Main's copies are kept, not the held branch's, because main changed those surfaces since. See `VERIFICATION.md` for the screens run.
- `docs/CHANGELOG.md` gains an Unreleased entry. Dated entries, decisions and older change records that mention classic stay as history.
- Not touched: `next/Decision.tsx`, `next/NeedsView.tsx` and `apps/desktop/src/mec.ts`. The shortcuts read the card's existing `data-state` and `data-armed` attributes only.

## J, A and G then W (`2a67a58`)

- `next/keyboard.ts`: J moves focus to the next open decision card's heading, A presses the focused card's Approve, which only arms it (A never confirms), and G then W within 800 ms goes to Work. None fires in a field, under a modal or the palette, with Shift or with a modifier.
- `next/Shell.tsx` wires them. Tests: `test/next-keyboard.test.ts`, `test/next.screens.playwright.ts`. Mutants: `tools/mutants/next-shortcuts.json`.

## What

- **Deleted from `apps/web`:** `src/App.tsx`, `src/classic-entry.tsx`, `src/workbench.tsx`, `src/state.ts`, `src/tokens.css`, `src/workbench.css`, `src/views/*`, `src/components/*`, `src/ui-flag.ts`, `public/fonts/*` (6 files), `test/ui-flag.test.ts`, `test/screens.playwright.ts` and its 16 baselines.
- **Also deleted, not in the handoff's list:** `test/mocks.ts`. Only `screens.playwright.ts` imported it.
- **`src/main.tsx` mounts the shell directly.** It keeps the dynamic import, so a failed chunk still says "The workbench could not load". The `mec-ui-shell` value and `?ui=` are ignored. A leftover `?ui=` stays in the address, harmless. `state.ts` was confirmed unused by the next shell first.
- **The way back is removed:** the palette command and the "Return to the classic workbench" link in the empty states (`live/LiveApp.tsx`, `live/surfaces.tsx`, `next/NextApp.tsx`, `next/states.tsx`). On the held branch the six `live-*` baselines were redrawn without that link; on main they are kept as they are and still pass, inside the 2% tolerance.
- **`src/next/ViewBoundary.tsx`, added to `next/Shell.tsx`: new behaviour, only on a crash.** Classic contained a render failure to its pane. The next shell had no boundary, so a throwing view blanked the whole page. This is the one port that needed product code, because the test had no equal without it.
- **Spec and comments:** the §18 sentence, `playwright.config.ts` and `router.ts` comments, a superseded note on `04_UI_DESIGN_SPEC.md`. The `?ui=classic` line in `docs/known-limits.md` is gone because it is no longer true. `docs/design/prototype` and `docs/design/screens` stay as history.
- **`test/shell-split.test.ts`** keeps its `SAMPLE-ONLY`, harness, web-font and mock checks, and a stylesheet-is-loaded check. The two-shell preload assertions went with the second shell.
- **`tools/mutants/m3.4-release.json`:** the five `ui-flag.ts` mutants went with that file. Eight new ones replace them.

## Intended test changes in surviving files

In `test/next.screens.playwright.ts`:

- `#chat|#work|#needs: reads only…` looked for the classic link as the empty state's action. It now looks for `Open Setup`, which was already there.
- `the empty state opens Setup here` expected a stored `next`. Nothing stores a shell now, so it expects no stored value.
- `live()` opens `/#…` rather than `/?ui=next#…`, so that test's check for an empty query still means something. Other tests keep their `?ui=next`, which is now inert: parallel branches add more of them.

## Port, test by test

Each classic test in `test/screens.playwright.ts` and its equal in the next suite. "New" means written here, before the deletion, and seen against the next shell. Classic's J, A and G W single keys were not in the next shell when this was first written; they are added here (above).

| Classic test | Equal |
| --- | --- |
| `screen chat light/dark` | `next.screens` `conversation` baselines, three widths, both themes |
| `screen needs light/dark` | `next.screens` `needs you` baselines; `work.screens` `needs you` |
| `screen work light/dark` | `work.screens` `work list` baselines |
| `screen slots light/dark` | `config.screens` `baselines in light/dark` (`config-slots`) |
| `screen setup light/dark` | `config.screens` `baselines in light/dark` (`config-setup`) |
| `screen settings light/dark` | `config.screens` `baselines in light/dark` (`config-settings`) |
| `context pane light/dark` | `next.screens` `inspector` baselines; `work-live` `inspecting a card opens the card’s own evidence`. The pane's "If you approve" text is now "On approve" on the card itself |
| `login sheet light/dark` | No sheet any more: an inline card. `config.screens` `a sign-in that starts shows its card`, new `Sign in again that starts shows its card`, `config-slots` baselines. "Never reads the token" is now "MEC never sees the token" in `ConnectionForm.tsx` |
| `§23 worked example` | New `work-live` `§23 worked example: the request, the plan, a question, a decision and its evidence`. Tier and slot moved from the plan card to the inspector (`work.screens` `requested and actual stay apart`). The parked-slot notice was a chat line; a status line stands for it |
| `a card the server has no evidence for…` | `work-live` `a card whose evidence is 404 cannot be approved, and can be denied` |
| `a card whose evidence did not load…` | New `work-live` `an open card whose evidence did not load cannot be approved, until a retry works` |
| `keyboard-only walkthrough` | New `work-live` `keyboard-only walkthrough` |
| `old #/wizard deep link opens Setup` | `next.screens` `the launcher deep link for an unfinished setup opens Setup`; `next-only` `old deep links still route` |
| `old #/inbox deep link opens Needs you` | New `next.screens` `the old deep link for the inbox opens Needs you`; `next-only` `old deep links still route` |
| `Esc walks the chain` | New `work-live` `Esc walks the chain: armed approval, then palette, then inspector`, with `next.screens` `Escape closes the top surface only`. One real difference: opening the palette cancels an armed approval here, where classic kept it armed. Decision.tsx says any other action cancels, and the test pins that |
| `Settings: a failing prompts read…` | New `config.screens` `a failing prompts or models read ends in an error, and the shell stays usable`; `settings failure leaves navigation usable` |
| `a view that throws while drawing…` | New `next.screens` `a view that throws while drawing is contained to its pane`, with `ViewBoundary` |

Removed from `next.screens`, with their subject: `?ui=classic applies…`, `?ui=next applies…`, `the way back…`, `the palette carries the way back…`. In their place: `an old ?ui=classic or stored classic choice is ignored`, `no way back to a classic shell is offered`. `test/ui-flag.test.ts` went with `ui-flag.ts`; `next-only` `nothing reads the old shell choice` covers what is left.

## Left alone

- `classicTarget` and `classicKey` in `src/repo-target.ts` now have no caller in `src`. Their tests and the `repo-workspace.json` mutants still pin them, and the file is outside the deletion list.
- Client calls in `src/api.ts` that only classic used.

## Rollback

Revert this branch. No stored data changes. An old `mec-ui-shell` value stays in the browser, unread.
