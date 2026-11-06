# Current code map

Status: **discovered** (4 Nov 2026, from the living tree; canonical layout table in `README.md` — this file adds the execution path and dependency rules an agent needs before touching code).

Base revision / working state: `main` after `e5ae484` (R2 wave complete; working tree clean). Workbench row and the note below it updated 6 Nov 2026 for 0.3.0 (`feat/next-final`, 68c9658); the rest of this file is unchanged from 4 Nov.

## Applications and entry points

| Area | Runtime | Entry point | Responsibility | Tests |
| --- | --- | --- | --- | --- |
| Server/CLI | Node ≥ 22.18 | `apps/desktop/bin/mec.js` (no args → guarded server via `src/serve.ts`; args → CLI via `src/mec.ts`) | composition root: store, health, MCP tools server, HTTP server, workbench static hosting | `apps/desktop/test/*` |
| Workbench | React 19 + Vite | `apps/web/src/main.tsx` picks a shell with `src/ui-flag.ts` (`resolveShell`): the new shell (`src/live/entry.tsx` → `LiveApp.tsx`, presentation in `src/next/*`) is the default; classic (`src/classic-entry.tsx`, `App.tsx`, `views/*`) only by `?ui=classic` or a stored choice. Hash routes in `src/router.ts` | new shell: Conversation, Work, Needs you, Connections, Setup, Settings, with inspector, palette and sheets; classic: chat, inbox, work, slots, setup wizard | `apps/web/test/*` (vitest, plus Playwright `*.screens.playwright.ts`, `a11y`, `limits`, `keyboard` and `journey.real.playwright.ts`) |
| Engine adapters | Node | `packages/engines/src/<engine>/adapter.ts` | one adapter per engine over its real protocol | `packages/engines/test/*` + fixtures |
| Shared seam | Node | `packages/contracts/src/index.ts` | every cross-package type + Zod schema (frozen, tag `contracts-v0`) | schema/lint/sample suites |

## Representative execution path (a chat message)

`POST /api/chat/messages` (`apps/desktop/src/server.ts`) → secrets guard (`matchesSecret` → redact + Slots pointer) → `MetaAgentService` (`packages/meta`) with the real brain (`RealClaudeBrain`, `MEC_META_SLOT` slot home) → plan → task briefs built per `packages/contracts` `AttemptBrief` → `Supervisor.spawn` (`packages/runtime`, argv-only, §5.12 env scrub) → engine adapter (`packages/engines`) streams `EngineEvent`s → journal (fsync/ack) + store events (redacted) → checks on exact SHAs (`packages/runtime/checks.ts`) → review turn (different engine session; §15 independent review) → integration merge (`packages/git`) → release agent (`apps/desktop/src/release.ts`) opens cards for push/PR/merge, settled via the confirmation store (`packages/policy` CAS).

A launch effect, by default: `launchHandler` (`apps/desktop/src/composition.ts`) → `launchAuthority` → `AttemptLauncher` (`attempt-launch.ts`: load and agree, cache, pinned base, worktree, `.mec/`, bootstrap, model, bundle, token, env) → `AttemptRunner.launchAttempt` (`packages/runtime/src/attempt-runner.ts`), which returns once the engine runs. Its monitor journals each event, commits facts through `StoreFacts` (`core-facts.ts`), and after exit commits, guards `.mec/` and runs the repo's checks on the head. The specialist's tools are `specialist-tools.ts`. With `MEC_REAL_RUNNER=0` the launch fails with `no_runner`.

## Dependencies and contracts (verified rules)

- Dependency direction: `apps/*` → `packages/*` → `packages/contracts`. Engines never import the store; the store never imports engines; contracts is the only seam both see.
- The fixtures contract: `packages/testkit/fixtures/<engine>/<version>/<scenario>/{raw,events,meta}.jsonl` with `recorded_by: 'real' | 'fake'` and honest notes; conformance asserts `parse(raw) === events`. Provider error bodies live under `fixtures/providers/<provider>/`.
- The events contract: every persisted event passes `packages/contracts` event schemas including the secret-field lint; the gap-free sequence rule is enforced by the store.
- Engine versions are pinned (docs/engines.md): claude 2.1.317, codex-cli 0.148.0, opencode 2.2.5 — adapters encode those protocols' real shapes; a version bump requires re-recording fixtures and re-running the gated canaries.

## Workbench shell split (0.3.0)

- The two shells bring their own stylesheets and are loaded through a table in `main.tsx`, never a conditional import (`apps/web/test/shell-split.test.ts` pins this). They share `src/api*.ts`, `release-cards.ts` and `router.ts`.
- `#/wizard`, which the launcher opens on an unfinished setup, resolves to Setup in the new shell.
- Accessibility and the measured limits run as Playwright gates over a harness; `apps/web/scripts/axe-server.mjs` and `lighthouse.mjs` run against a built server. None is in `pnpm check` or CI.
- Classic is removed in a later release (decision #35); this map still lists it because 0.3.0 ships it.
