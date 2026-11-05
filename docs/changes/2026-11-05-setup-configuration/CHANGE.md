# M3.3 Stage A: complete setup and configuration

Handoff `32-m3.3-setup-configuration.md`. Base `5be0ef8` (`feat/durable-commands`), branch `feat/setup-config`. Default stays classic: all of this is behind `?ui=next`, except the server guards, which apply to every client.

## Outcome

The new shell's Setup, Connections and Settings are real. Setup shows what is saved, not where the owner has clicked. Connections can add, replace, sign in again and retire, and every irreversible step says what it does. Policy, prompts, models and repositories save durably, and a stale save keeps the draft. Pause sits beside Needs you. A control that cannot work says so before the click.

## What changed

**Server.** `apps/desktop/src/config-routes.ts` is the appended block, so `server.ts` carries one call. It serves readiness, skip, connections, a dedicated slot, a local probe, slot impact, key replacement, policy, models text, repository edit, draft apply and dismiss, and backups. `readiness.ts` holds the five stages and `metaSlotRefusal`, the one predicate for the route, the setup-agent tool and the screen. `policy-store.ts` is the saved policy.

- `server.ts`: the retire label guard, `metaSlotRefusal` on `/api/wizard/meta-slot`, one `registerRepository` for both paths, `capabilities` on `/api/status`, `revision` on `GET /api/repositories`, and a `setupDecide` seam.
- `composition.ts`: reads the saved policy at boot and hands that text to the launch gate, the server and all three `MetaAgentService` sites, and wires backups with `VACUUM INTO`. Under `MEC_FAKE_ENGINE=1` only, a scripted `propose <target> <json>` setup turn lets a scratch server walk a proposal to Apply.
- `backup.ts`: skips all of `outDir`, not only its staging folder. Without this, a second backup in `<data dir>/backups` would archive the first.

**Web.** `next/SetupView`, `ConnectionsView`, `SettingsView`, `ConnectionForm`, `RepositoryForm`, `SaveBar` and `config-model.ts` are props-only. `live/config.tsx`, a lazy chunk, binds them through `api-config.ts` and `config-decode.ts`. `live/config-store.ts` keeps drafts above the routes. `live/pause.ts` reads pause from the server.

**Spec.** §18 item 5, as the handoff words it. `docs/reference.md` covers the new routes.

## Facts the handoff did not have

- **A sign-in slot never reached the store.** `POST /api/slots/login` starts a card and writes no doc, and nothing in the server probed a Claude or Codex slot afterwards. A link stayed `home_ready` for good, so with the meta-slot rule no real install could ever have finished Setup. Hence `POST /api/slots/dedicated` and `POST /api/slots/:id/probe`, which the handoff does not list. The probe runs the vendor's own status command, spends no tokens and reads no credential.
- **`registerRepositoryDoc` already stored `{name, cmd}`.** The marker and stream parts of requirement 4 were real; the shape part had been fixed. Its `patch.checks` filter did drop a draft's `{name, cmd}` objects, and that is fixed.
- **The meta service never received the policy.** `composePlanner` built `MetaAgentService` with no `policyText`, so it used its own default. With a saved policy the launch gate would have refused every launch as `policy_changed`. All three sites now pass the text.
- **A Claude API-key slot cannot run the brain.** `real-brain.ts` launches with `CLAUDE_CONFIG_DIR` alone, so a key never reaches it. `metaSlotRefusal` refuses it, which is stricter than the handoff's wording. See the owner question below.
- **The setup agent has no model in production.** `SetupAgent` is built with no `decide`, so outside the fake engine no draft can arise from chat. The Apply path is complete and tested; nothing real feeds it yet.

## Decisions taken

- **Open questions 1 to 5** are as #36 settled them. Retire is an inline two-step plus the server label guard. A policy edit needs a restart, because making it live needs `service.ts`. No repository removal. Drain and pairs show as unavailable. Trust is a two-step with the change recorded on the event.
- **Stale base for a repository** is a hash of bootstrap, checks and trust, not `updatedAt`: two edits in one millisecond would share a timestamp.
- **Apply uses the routes.** A prompts or models draft calls the manual `PUT` through `app.inject`, so validation and the stale check have one home. A replaced key re-probes through `POST /api/slots/:id/validate` the same way.
- **A yes in chat no longer applies prompts or models.** It carries no base, so the agent is told to apply from Settings. Repository drafts still apply by yes, as before.
- **`PUT /api/policy` requires `base_sha256`**, and a key-shaped string in the text is refused rather than stored.

## Beyond the shared-file table

Each was needed by a requirement and is one small block.

| File | Why |
| --- | --- |
| `apps/web/src/live/LiveApp.tsx` | The route entries and the `pause` prop live here, not in `workspace.tsx`. `NextApp.tsx` needed no edit. |
| `apps/desktop/src/backup.ts` | One word, see above. |
| `GET /api/repositories` in `server.ts` | One additive `revision` field: the stale base has to reach the client. |
| `apps/web/src/components/Slots.tsx` | Classic Retire now meets the label guard. It says where to go instead of "could not reach the runtime". |
| `apps/web/src/views/SettingsView.tsx` | The stale classic Prompts line. |
| `apps/web/test/next.screens.playwright.ts` | Intended change: `#slots`, `#setup` and `#settings` are live, so the "Return to classic" assertion holds for the other three. Every other assertion stands. |
| `apps/desktop/test/api-slots.test.ts`, `wizard.test.ts` | Intended changes: retire needs the label, and an unprobed link is not a usable meta slot. |

`shell-split.test.ts` refuses `/api/` in the next entry chunk, so the configuration surface is a lazy chunk rather than a loosened test.

## Risks

- **A policy edit plus a restart blocks queued work.** After the restart, `launchAuthority` drops queued launches admitted under the old hash as `policy_changed` and blocks that work. That is M1.4's gate, unchanged, and the screen says so. It is wider than "new admissions only" in open question 2.
- **Retire does not stop running work.** The impact read names it, and the owner decides. Retiring the meta slot leaves `settings/meta-slot` pointing at it until another is chosen; Setup shows that as missing.
- **`POST /api/backups` is synchronous.** The tar blocks the server for its length.
- **The probe route skips capability drift.** It checks sign-in and version only. `mec slot probe` also checks required flags.
- **A setup-agent repository registered before this change** keeps no marker, so `has_repository` stays false for it. No migration, as ruled. Readiness reads the docs and counts it.

## A proposal's comparison

A proposal first showed its patch as plain text, which missed what requirement 12 asks for. With `install: repo_a` saved, a proposal for `repo_prop` showed only the new key, and Apply dropped `repo_a` with nothing marking it. `GET /api/setup/drafts` now carries `preview` on a pending policy, models or prompts proposal. The route moved from `server.ts` into `config-routes.ts` to sit beside the code Apply runs: the policy merge and the prompt parts are one function each, so the comparison cannot drift from the save. The screen renders `preview` with `lineDiff`.

- **Apply sends `preview.base`, not the section's newest read.** The two differ when the text moves after the comparison was drawn. Sending the newest would pass the stale check and overwrite text the owner never compared. A stale refusal now redraws the comparison, and so does a save in the editor.
- **Policy is compared re-spaced on both sides.** The default and many saved files are compact JSON, so a line diff would mark the whole file changed. Spacing has no meaning there. The stored text is unchanged.
- **Plain text stays where nothing compares:** a new repository, or a stored text that no longer loads. That one costs the comparison, not the list.
- **Unchanged runs fold to three lines of context.** A one-line models change once sat 1965px down a block showing 318px, with no marked line in the first view. `foldDiff` keeps every line behind a Show or Hide control, and leaves a single hidden line in place. All comparisons share `DiffView`: proposals and the prompts compare.

## A proposal and trust

Requirement 13 makes trust a two-step control in Settings, but applying a repository proposal stored `patch.trust`, so a chat suggestion could trust a repository in one Apply. `registerRepositoryDoc` now always stores `trust: false`.

- **The other caller keeps its behaviour.** The agent's `register_repository` tool passes trust as a string, which never equalled `true`, so it already stored false. The pass-through is gone and a test holds the result. `POST /api/repositories` does not go through this function: the owner's own form still chooses.
- **The card says so.** It prints the patch verbatim, so `trust: true` would read as a promise. `GET /api/setup/drafts` sets `trustIgnored` when a repository proposal carried any trust value but `false`, a string included, because the printed patch looks the same. The card then says it starts untrusted.

## Left open

- A sign-in that failed to start leaves its `home_ready` connection. The form says the sign-in did not start, and trying the same name is refused with "retire it first". The row offers Check and Retire but no sign-in, because `connectionActions` offers that only for `auth_expired`.
- Stage B: `capabilities.switchWork`, parked notices, Switch work.
- `NoRepositories` in `live/surfaces.tsx` still links to classic Setup, and `next.screens` pins that. It belongs to `31`'s surfaces.
- The sidebar footnote still says "Conversation and Work are live", in `LiveApp`'s shared area.
- `defaultSetupSettingsApi.read` still answers "not wired" for `prompts` and `models`. It is outside this handoff's blocks and nothing real calls it.
