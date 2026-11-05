# M1.1 HTTP recovery

Part of the meta-agent journeys plan (`2026-11-05-meta-agent-journeys`, row M1.1). Spec: §18, §12.6. No
contracts change, no migration, no new dependency.

## What and why

The workbench read three endpoints in the wrong shape, hid the mismatch behind demo fixtures, and left
views stuck on "Loading…" when a read failed.

- **Real shapes decoded.** `apps/web/src/api-decode.ts` (pure) maps what the server serves to the view types:
  `GET /api/prompts` is `{revision, parts, overrides}` (the view wanted an array; override text now fills
  `text` of edited parts), `GET /api/models` is the capability table (the view wanted `{providers, rows, note}`;
  one column per Claude, Codex and OpenCode provider, one row per tier), `GET /api/questions` is question
  records (open ones become cards). A payload that does not fit throws `DecodeError`.
- **`{option}` vs `{answer}`.** `answerQuestion` sent `{option}`; the server requires `{answer}` (400 otherwise).
  Fixed, and a 404/409 from the server now shows its own reason instead of "not served" or a fake success.
- **JSON 404 for unknown `/api/` paths.** With a built web app present, an unknown `GET /api/...` returned the
  SPA shell (HTTP 200 HTML). The not-found handler now answers `{error: 'not found'}` with 404 for every method
  on `/api` and `/api/*`. `ServerDeps.webDist` is a new optional test seam (default unchanged).
- **No demo data in production.** `withDemo` and the `mocks.ts` import are gone from `api.ts`; `mocks.ts` moved to
  `apps/web/test/mocks.ts` and the screens suite supplies every payload explicitly (including the real wire
  shapes for questions, prompts and models). Reads the server does not serve reject with `NotServedError`; the
  detail reads (inbox/work/task) degrade to the existing honest `absent` placeholder, which says "not served"
  (the `demo` flag and "shown from the §23 worked example" labels are removed because nothing is demo any more).
  This had to land together with the JSON 404: a JSON 404 would otherwise have turned every unserved read into
  live demo data.
- **Finite states and containment.** `components/PaneBoundary.tsx` wraps the routed view in `App.tsx` (keyed by
  route, so navigating clears a failure; the rail, palette and other routes keep working).
  `components/LoadState.tsx` (`useLoad`, `LoadFailed`) gives Settings (prompts, models, backups) and the
  context pane's question, work and task bodies loading, ready and failed states, with "Try again".

## Intended behaviour changes to existing assertions and baselines

No unit assertion changed. Playwright baselines changed for chat, needs, settings and context pane (light and
dark, 8 images): the question card now shows what the server records (eyebrow "Asked by the meta agent", no
side note or evidence block), the context pane lost its "shown from the §23 worked example" note, the Settings
prompts footer no longer claims a worked example, and the model table note is built from the table. The work,
slots and setup screens are pixel-identical (checked at tolerance 0).

## Not in this PR

Decision detail (`DecisionBody`, `Tray`) keeps its current load code, because the release-cards PR changes
`api.resolve`, `approveDecision` and inbox detail. Hold, stop and pause stay "not served" (M1.4). "Answer in
chat…" is no longer appended to real questions (it was a fixture option).
