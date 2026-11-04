# Current code map

Status: **discovered** (4 Nov 2026, from the living tree; canonical layout table in `README.md` — this file adds the execution path and dependency rules an agent needs before touching code).

Base revision / working state: `main` after `e5ae484` (R2 wave complete; working tree clean).

## Applications and entry points

| Area | Runtime | Entry point | Responsibility | Tests |
| --- | --- | --- | --- | --- |
| Server/CLI | Node ≥ 22.18 | `apps/desktop/bin/mec.js` (no args → guarded server via `src/serve.ts`; args → CLI via `src/mec.ts`) | composition root: store, health, MCP tools server, HTTP server, workbench static hosting | `apps/desktop/test/*` |
| Workbench | React 19 + Vite | `apps/web/src/router.ts` (hash routes) | chat, inbox, work, slots, setup wizard | `apps/web/src/**/*.test.ts(x)` |
| Engine adapters | Node | `packages/engines/src/<engine>/adapter.ts` | one adapter per engine over its real protocol | `packages/engines/test/*` + fixtures |
| Shared seam | Node | `packages/contracts/src/index.ts` | every cross-package type + Zod schema (frozen, tag `contracts-v0`) | schema/lint/sample suites |

## Representative execution path (a chat message)

`POST /api/chat/messages` (`apps/desktop/src/server.ts`) → secrets guard (`matchesSecret` → redact + Slots pointer) → `MetaAgentService` (`packages/meta`) with the real brain (`RealClaudeBrain`, `MEC_META_SLOT` slot home) → plan → task briefs built per `packages/contracts` `AttemptBrief` → `Supervisor.spawn` (`packages/runtime`, argv-only, §5.12 env scrub) → engine adapter (`packages/engines`) streams `EngineEvent`s → journal (fsync/ack) + store events (redacted) → checks on exact SHAs (`packages/runtime/checks.ts`) → review turn (different engine session; §15 independent review) → integration merge (`packages/git`) → release agent (`apps/desktop/src/release.ts`) opens cards for push/PR/merge, settled via the confirmation store (`packages/policy` CAS).

## Dependencies and contracts (verified rules)

- Dependency direction: `apps/*` → `packages/*` → `packages/contracts`. Engines never import the store; the store never imports engines; contracts is the only seam both see.
- The fixtures contract: `packages/testkit/fixtures/<engine>/<version>/<scenario>/{raw,events,meta}.jsonl` with `recorded_by: 'real' | 'fake'` and honest notes; conformance asserts `parse(raw) === events`. Provider error bodies live under `fixtures/providers/<provider>/`.
- The events contract: every persisted event passes `packages/contracts` event schemas including the secret-field lint; the gap-free sequence rule is enforced by the store.
- Engine versions are pinned (docs/engines.md): claude 2.1.317, codex-cli 0.148.0, opencode 2.2.5 — adapters encode those protocols' real shapes; a version bump requires re-recording fixtures and re-running the gated canaries.
