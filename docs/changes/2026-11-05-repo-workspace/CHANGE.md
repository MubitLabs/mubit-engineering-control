# M1.3 Repo workspace and submission intent

## What

Behind `?ui=next` the owner picks a repository, sees only that repository's conversation and work, and sends a New request or a follow-up with the target always visible. Classic keeps working and stays the default. `next` stays default-off.

- **Binding layer (`apps/web/src/live/`).** `next/` stays pure props. `workspace.tsx` holds the data, `drafts.ts` what survives a reload, `submission.ts` the send, `secret-shape.ts` a tested copy of `SECRET_PATTERNS`. `LiveApp.tsx` and `surfaces.tsx` compose them. `next/entry.tsx` is gone; `live/entry.tsx` keeps the chunk name.
- **Repo selector.** The address, then `mec-next-repo`, then the only repo. Zero repos is an empty state pointing at `?ui=classic#setup`. Several and none chosen is an inline chooser with a read-only composer. A repository that has gone falls back with a notice, never silently.
- **Scoping.** A switch cancels in-flight reads and shows nothing of the last repo. A row whose `repoId` differs from the active scope is dropped, and an answer from a cancelled read never paints.
- **Unassigned.** `repoId=unassigned` returns rows with no repo. The sidebar entry appears only when such rows exist, read-only.
- **Work titles.** `/api/work` rows gain `title`, the origin message's first line, 80 characters.
- **Intent.** `intent` on the chat body. `new` starts work beside live work through `explicitNew`; `follow_up` needs a reference, `new` refuses one, both 400. Absent keeps §12.1 routing, so classic is unchanged. The intent is per repo, is set only by the owner, and survives refetch and reload. Selecting work never changes it.
- **Submission.** One frozen `{ key, repoId, intent, referencesWorkItem, text }` per repo. The object is the guard, so it holds inside the keydown. Retry resends it with the same key; any edit to the text, target or intent takes a new key. A success removes only the sent text, and only once the server confirms.
- **Idempotency.** The same key with a different text, intent or reference is 409 `idempotency_mismatch`. A different repo keeps M1.2's 400 `repo_mismatch`. The message now stores `intent` and `referencesWorkItem`, because the composed path stored neither and there was nothing to compare against.
- **Drafts.** `mec-next-draft:<repoId>:<new|work:<id>>` in `localStorage`, in try/catch. Key-shaped text stays in memory and the composer says so. Pending submissions persist under the same rule, so a reload mid-send keeps the key.
- **Addresses.** `#repo/<id>/chat`, `/work`, `/work/<workId>`, `/work/<workId>/task/<taskId>`, `/needs`, `/slots`, `/setup`, `/settings`. Plain `#chat` and the aliases still work and resolve against the active repo. `router.ts` is unchanged, and classic parses the long form to chat.
- **Classic.** `sendChat` takes `{ repoId, referencesWorkItem?, intent? }`. `classicTarget` picks a reply's own repo, then `mec-classic-repo`, then the only repo. A native select appears with several repos and no reply chip. With no target Send says why and keeps the draft. The reply-to effect skips rows with no `repoId`.
- **The flip (last commit, alone).** Absent `repoId` is 400 `repo_required` on both paths, after the secret guard and the setup branch, so Setup works with zero repositories. Reads stay global without `repoId`.

## Why

Decision #10 gives each repository its own conversation and history, and §12.1 needs an explicit New request beside live work. Classic's first-live selection (`workbench.tsx`, "Reply-to") retargets a message by itself, and its Enter guard lives in React state, which lags a double Enter.

## Compatibility

- **Storage:** no SQL migration. `intent` and `referencesWorkItem` are new fields in existing json docs.
- **Contracts:** `packages/contracts` is unchanged.
- **Old tab:** a tab on the old bundle gets a 400 after the flip. Classic restores the draft on failure, and a reload fixes it.
- **Legacy keys:** a message stored before this change has no `intent` or `referencesWorkItem`, so a retry crossing the upgrade with a reference gets a 409 rather than a replay. The retry window is seconds.

## Intended behaviour changes

- **The flip:** `server.test.ts`, `planner.test.ts` and `security-surface.test.ts` register a repository before posting. "absent repoId stays Unassigned" became "legacy rows stay in the global read", seeded from the store, because the route can no longer create such a row.
- **`api.test.ts`:** the `sendChat` signature and exact body.
- **`next.screens.playwright.ts`:** `?ui=next` no longer asserts zero requests or "not connected" for Conversation and Work. It now asserts reads only, no writes, and the zero-repository copy. The `live-*` baselines changed. Classic baselines did not.
- **Classic's idempotency key follows the payload (not in the handoff).** Classic held one key until a success. With the 409, a failed send that did land, followed by an edit, would have answered 409 on every retry with no way out. `classicKey` in `repo-target.ts` mints a new key when the text, repo or reference changes. It touches only the `sendChat` callback.

## Proposed spec lines (not edited here)

- **§12.1, Admission.** After "starts a new work item (explicit — chat is always authorised)": "An explicit New request starts a new work item even while the same repository has live work. It carries no reference; a follow-up must carry one."
- **§12.1.** The per-repo conversation line landed with M1.2. `conversationId` equals `repoId`, as that record proposes.
- **§18, work titles.** No title field exists in §10. The work title is the origin message's first line until the planner supplies one in M3.1.

## Left for later

- **Selector open.** With several repos and none chosen the selector is an inline list in the page, not the modal, because the modal lives in the rail and the rail is absent at drawer width.
- **Ack text.** The server's acknowledgements name work by id. The conversation substitutes the title where it has one. M2.2 owns message receipts.
- **Setup messages.** They have no repo, so a chat through Setup makes the Unassigned entry appear. That is true, and it is the handoff's definition, but the owner may find it surprising.
- **Secret paste retries.** The secret guard runs before the idempotency lookup, so a retried key-shaped message is stored redacted twice. `11-m1.4b` owns admit-once.
- **Concurrent same-key posts.** The key is written after `onUserMessage` returns, so two simultaneous posts both pass the lookup. The client's in-flight guard prevents it from one tab. `11-m1.4b` owns this too.
- **A follow-up to done work.** The reference resolves to nothing and falls through to §12.1, so it can start new work. The UI offers follow-up only on open work.
- **Hold, stop, Needs you, task and evidence inspection:** M3.2. The inspector shows only what `/api/work` serves and says so.
