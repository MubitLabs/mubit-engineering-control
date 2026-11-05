# Main gaps

Four defects found by independent verification of `origin/main` at 9994c49.

## What

- **Repo scope (`apps/desktop/src/server.ts`, `repoFilterOf`).** Any `repoId` that isn't one string is the same 400 as an unknown id, on `GET /api/work` and `GET /api/chat/messages`. That covers a repeated `repoId` and the bracket forms. The default query parser keeps `repoId[]=` under its literal key, so the value alone was never enough to see it.
- **Approve with no evidence (`apps/web/src/release-cards.ts`, `canApprove`).** A card whose detail route answers 404 can't be approved. Deny stays available, and a 5xx stays the retry path. `api.decisionDetail` still rejects on a 5xx, so that path is unchanged.
- **Meta agent cards serve their evidence (`apps/desktop/src/release.ts`, `cardDetail`).** Spec §13: a confirmation binds "the exact diff or command", and hard invariant 2 leaves the answer to a person. See "Live paths to a 404" below.
- **Prompts in a bundle (`packages/prompts/src/loader.ts`, `models.ts`, `packages/meta/src/brain.ts`).** All three look beside the bundle first, then in the source tree, then from `apps/desktop/dist`. A folder counts only if it holds the planner's protocol. No tree is a thrown error, and `startServer` refuses before it takes the lock.
- **Keystore root (`mecRoot()` in `packages/prompts/src/models.ts`).** `MEC_DATA_DIR ?? ~/.mec`, the rule `bin/mec.js` already gives the store. The server's keystore root, the default models path and the planner's prompt read all follow it.

## Why

- Scope: a malformed filter answered 200 with every repository's rows.
- Evidence: a bare spend card settled approved with nothing shown. A real push card with a browser-injected 404 pushed after the two-step approve.
- Prompts: see the table below. Settings showed an empty catalogue, and the planner ran on a shorter built-in prompt with no sign that it had.
- Keystore: a server on a scratch `MEC_DATA_DIR` read and wrote the real `~/.mec` for `/api/models` and `/api/prompts`.

## What a shipped build did before this change

Observed on real servers on a scratch `MEC_DATA_DIR`. Exact output is in `VERIFICATION.md`.

| | Built bundle (`apps/desktop/dist`) | Extracted `pnpm pack:internal` tarball |
| --- | --- | --- |
| `GET /api/prompts` | 200, `parts: []` | 200, `parts: []` |
| `GET /api/models` | 200, via the dev bundle path | **500, ENOENT** |
| `readMetaProtocol` | `''` | `''` |
| Planner prompt | Silently the 2172-char `DEFAULT_PLANNER_PROTOCOL`, not the 2946 chars of shipped `protocol.md` + `planning.md` | The same |
| Planner table | Loaded | `composition.ts` swallows the throw, so the planner gets `FALLBACK_EMPTY_TABLE` |

So the planner's prompt was never blank, but it wasn't the shipped text either, and nothing said so. In the tarball the empty table is the more serious half: `composition.ts`'s own comment says that every tier is then unplaceable and every plan rejected. That line comes from reading the code. No real planner turn ran here.

The models candidate `../prompts-defaults` was a one-character bug: its comment says "beside the bundle", but from `dist/mec.mjs` that path is outside `dist/`.

## Live paths to a 404

Every writer of a confirmation, found by `openConfirmation` and `confirmations.save`:

| Writer | Class | Detail before | Detail after |
| --- | --- | --- | --- |
| `createPrBehindCard` (`release.ts`) | `pr_create` | Served | Served |
| `openMergeCard` (`release.ts`) | `pr_merge` | Served | Served |
| `openPushCard` (`release.ts`) | `push` | Served | Served |
| `MetaAgentService.#persistExtras` (`packages/meta/src/service.ts`) from `request_confirmation` | Whatever the agent names, for example `frontier_model` | **404** | Served |

The last is the one a plain refusal would have left unapprovable, so the server now serves its stored `operation` and `evidence` as facts. The class is shown once. Every value is redacted on the way out.

- If the agent names an always-confirm class, the detail is served and says nothing here can run it. The approve stays the existing 422.
- If a card names nothing beyond its class (`evidence: {}`), there is nothing to show. It keeps the 404: it can be denied, not approved.
- A card with no payload at all keeps the 404, as `release-cards.test.ts` already pinned.

`apps/web/src/next/work-model.ts` has its own `canApprove`, which I left alone. It holds on `evidence === null`, and nothing in `apps/web/src` reads live evidence for that surface yet: `decodeCardEvidence` is only called from the test harness. When that surface is wired up, an absent answer has to become `null`.

## Compatibility

- **Storage:** no SQL migration, and no stored data or key is read, moved or deleted.
- **Contracts:** `packages/contracts` is unchanged.
- **`MEC_DATA_DIR` unset:** every path is still `~/.mec`, pinned by a test on a throwaway home.
- **`MEC_DATA_DIR` set on a real store:** `models.yaml` and prompt overrides under `~/.mec` stop being read, because that is the point of the change. Existing slots keep working, because they hold an absolute `home`. New slots land under the data dir.
- **Dependencies:** none added. `@mec/meta` doesn't depend on `@mec/prompts`, and adding that needs an install, so `brain.ts` keeps its own candidate list. `bundle-defaults.test.ts` holds both lists to the same layouts.

## Intended test changes

`apps/web/test/release-cards.test.ts` pinned `canApprove({ absent: true })` as `true`. That was this defect, so the test now pins the refusal. The `{ what: 'Push' }` assertion is kept as its own test.

## Left for later

- **Server-side refusal.** The gate is in the workbench, as asked. A direct `POST /api/inbox/:id/resolve` still settles a card with no evidence, unless its class is always-confirm with no executor.
- **Secrets in planner evidence.** `#persistExtras` stores `operation` and `evidence` as given, so a key-shaped string becomes durable, against §13 hard invariant 3. The new route only redacts what it shows.
- **What an approved planner card does.** Nothing consumes it. `confirmation_resolved` has no live caller, and frontier access reads policy pre-authorisation only (`service.ts:306`). The new detail says the click runs nothing, but the toast still reads "the agent was told to continue".
- **`cliMain`** still ignores `MEC_DATA_DIR` (`mec.ts:176`), so `mec status` and `mec slot` use `~/.mec`. It is already listed in handoff 23.
- **Spawn stalls.** In a full `pnpm check` on this Mac a new process sat at `_dyld_start` for over 12s. `bundle-defaults.test.ts` sizes its limits for that. The `bundle.test.ts` 6s limit, out of scope here, is exposed to the same stall.
- **Out of scope by the brief:** the classic sidebar's "1 attempt running" label and the Prompts "not served" save text.
