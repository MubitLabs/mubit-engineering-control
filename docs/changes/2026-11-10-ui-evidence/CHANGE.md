# UI evidence required: a repository flag, MEC's own before and after screenshots, and a held handoff

Branch `feat/ui-evidence`, base `3844b0a` (main after #78, which carried owner decision #69: UI evidence on for MubitLabs/mec-sandbox once the flag exists). Spec §14 (a repository registers "whether UI evidence is required") and §15 ("when a repository requires it, a change to what users see is `ready` only with before and after captures of the same scenario from the real application, labelled with their revisions; after-only or mocked evidence keeps the handoff explicitly incomplete"). This change builds the flag. It turns it on nowhere: turning it on for mec-sandbox is a live step after install.

## The setting

The repository record (`store.engines`, `repo_*`, not in `packages/contracts`) gains an optional `uiEvidence`:

```json
{ "required": true, "start": { "argv": ["npm", "start"], "port": 3000 }, "paths": ["/", "/about.html"], "patterns": ["web/**"] }
```

- `required` (boolean). Absent, or anything unreadable, is off.
- `start` (optional): `argv` (run as argv, never a shell; shell metacharacters are refused as for setup and checks), and `url` (http on 127.0.0.1, localhost or [::1] only) or `port`. With neither, MEC picks a free loopback port and passes it as `PORT`. With no `start`, MEC serves the revision's files itself from a loopback port it picks: the first real use, mec-sandbox, is a static site (`index.html`, `style.css`, `app.js`, no build).
- `paths` (optional): the scenario, one to five paths starting with `/` (not `//`). Default `["/"]`.
- `patterns` (optional): globs for "what users see". Default below.

It is set with `PATCH /api/repositories/:id` `{ base_revision, uiEvidence }`, the route that already saves repository settings, and read back on `GET /api/repositories` (always present, with defaults filled in). The `repository_updated` event says `changed: ['ui_evidence']` and `uiEvidence: { from, to }`. The web app's repository settings have a "Screenshots before review" section: a checkbox "Require before and after screenshots for changes people can see", an optional start command and port, and the pages to capture.

**Turning it on or off invalidates nothing in flight.** `profileHashOf` (`packages/meta/src/admission.ts`), the hash a work item is pinned to and the `repo_profile_changed` gates compare, still hashes only bootstrap, checks and trust; it is untouched. The flag is read at each acceptance judgement, so it takes effect at the next one. `repositoryRevision` (the stale-edit base) includes `uiEvidence` only once it is set, so a repository that never had it keeps its revision and an open settings page is not made stale by this upgrade.

## When a change counts as user-visible

A change is user-visible when **any file its commits changed** (`changed_paths`, as MEC read them against the attempt's base) matches **one of the repository's `patterns`**, or these defaults when it registers none:

`**/*.html` `**/*.htm` `**/*.css` `**/*.scss` `**/*.sass` `**/*.less` `**/*.js` `**/*.mjs` `**/*.jsx` `**/*.tsx` `**/*.vue` `**/*.svelte` `**/*.svg` `**/*.png` `**/*.jpg` `**/*.jpeg` `**/*.gif` `**/*.webp` `**/*.ico` `**/*.woff` `**/*.woff2` `**/assets/**` `**/public/**` `**/static/**`

A glob is matched against the whole repo-relative path: `*` stays inside one segment, `**` crosses segments, `?` is one character. `.ts` is not in the defaults (it is as often server code); a repository whose UI is in `.ts` lists its own globs. A `.js` that is not UI (a Node script) counts by default; the same globs narrow it. There is no planner or task override: one would need a new planner tool field, its schema, the planner prompt and the model-surface tests, and the repository's globs already answer the cases found. It is listed as an open item.

## Captures are MEC's, not the engine's

OpenCode cannot run commands, and Codex and Claude have no network, so the engine never takes them. The capture service (`apps/desktop/src/ui-evidence.ts`, on the composition's 2 s timer beside delivery) finds every task the scheduler's own acceptance holds back for screenshots (`screenshotsDue`, which calls the scheduler's `taskAcceptance`, so the two can never disagree) and takes:

- **before** at the attempt's `base_sha` (the task's base) and **after** at its `head_sha` (the reported head that acceptance judges), with the same paths and the same 1280x800 viewport;
- each revision exported with `git archive` from the clone into MEC's `tmp/` (no worktree, no index, removed after), then served (MEC's static server, or the repository's setup commands and start command in the scrubbed environment checks use; a start command needs the owner's host-run agreement, static serving runs nothing of the repository);
- by Playwright's Chromium (`playwright-core`, the version the web screens already use, now a runtime dependency of `@mec/desktop`, external to the bundle and installed with the tarball like the native modules). The page has no channel out (§13, hard invariant 1: the page's script may be an engine's work, and the engine had no network). There are three fences, each tested on its own:
  1. Chromium's only proxy is a fence MEC runs on loopback (`openFence`), with no bypass. Playwright adds `<-loopback>`, so loopback goes through it too. The fence forwards only to the app's own host and port. It refuses every other request with 403 and closes every other CONNECT tunnel, whatever opened it: a redirect from the app, a WebSocket, or a subresource. A port-specific proxy bypass would have been simpler, but Chromium ignores the port on an IP-literal bypass rule (probed on 1.64.1: `127.0.0.1:<port>` sent the app itself to the proxy, and `127.0.0.1` let every loopback port through).
  2. `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`: WebRTC may send UDP only through the proxy, and an HTTP proxy carries none, so no STUN packet leaves.
  3. In the page, `route('**/*')` aborts any request to another origin, and `routeWebSocket(/.*/)` closes every WebSocket the page opens. `route` alone never saw WebSockets, and the browser follows redirects without asking `route`. An independent check found both: a WebSocket upgrade reached a second loopback listener, and so did redirected requests and a STUN packet. The tests now prove none does.
- stored as PNG under `<data dir>/ui-evidence/<work>/<attempt>/<side>-<n>.png`, at most `MAX_PNG_BYTES` (4 MiB) each. The record `ui-evidence/<attempt>` holds, per side, the commit, and per shot the path, file, bytes, time and HTTP status, with the viewport and paths. Nothing is written into a worktree, so no capture can enter a task commit; the `.mec/` exclusion in `commitAll` is untouched.

Anything that goes wrong (the commit cannot be read, the app exits or does not answer within 30 s, the agreement is missing, Chromium cannot start, a page does not load, an after page answers HTTP 400 or more, a PNG over the bound) is recorded as `could_not` with its reason in words, redacted. It is never a pass. The HTTP status rule is one-sided. On the after side, 400 or more is `could_not` ("the page /about.html answered HTTP 404 at the result"), because the result must show the page. On the before side the status is recorded and the capture stands, because a 404 before is legitimate evidence for a page the change adds. A reviewer's attempt changes nothing, so a task whose latest attempt is a review is judged on the captures of the work attempt with the same head.

## Holding back the handoff

`acceptance` (`packages/domain/src/acceptance.ts`) takes an optional `uiEvidence` input, which the scheduler passes **only where the repository requires it**; absent, acceptance decides exactly as before (tested). Where present, after checks, owned paths, findings and review would accept, it returns `pending`:

- `ui_evidence_waiting` until both captures exist on the right commits (before on the base, after on the head, each with at least one shot). After-only, or a capture of another commit, is waiting.
- `ui_evidence_failed: Couldn't take the <side> screenshot: <reason>` when a side could not be taken.

A pending task stays `active`, so it is not accepted, not integrated, and no push or PR card opens: the work stays explicitly incomplete. Two stages (`packages/domain/src/stages.ts`, from a `screenshots` fact that Work, Needs you and the planner's context all read through `screenshotWait`):

- `waiting/screenshots` (system): **Waiting for before and after screenshots**; reason "MEC is taking the before and after screenshots of the change".
- `person/screenshots` (person): **Couldn't take the after screenshot** (or before); reason "Couldn't take the after screenshot: <reason>"; Next **Take the screenshots again**.

The retry is a new `retryOffer` kind, `screenshots`, through `POST /api/work/:id/retry`. It puts the failed records back to `requested` with no captures in them, and the service takes both sides again. The planner reads the same stage label, so no planner context line or delivery prompt change was needed (the delivery prompt and the PR reviewer prompt already state the rule).

## Showing and recording it

- Work detail (`GET /api/inspect/work/:id`) carries `screenshots`: the newest five records, each side with its full and short SHA and each image by `GET /api/work/:id/screenshots/:attempt/:file`. The work view shows **Before, `<short>`** and **After, `<short>`** side by side, or why one could not be taken. `GET /api/work/:id/screenshots` lists them too. The image route serves only a file name the record holds, for that work item.
- The PR body MEC writes gains a **UI evidence** section, one line per integrated task whose after capture is on its accepted head: "`a: before \`1a2b3c4\` and after \`5d6e7f8\` of / at 1280x800, taken by MEC in Chromium from the real application. The images are kept on the machine that ran the work.`" No image is uploaded to GitHub.

## Files

- `packages/domain/src/ui-evidence.ts` (new): setting, globs, verdict. `acceptance.ts`, `stages.ts`, `index.ts`.
- `packages/meta/src/ui-evidence.ts` (new): store reads, `screenshotWait`, retry offer and retake. `scheduler.ts` (`acceptanceOf`, `taskAcceptance`), `context.ts`, `index.ts`.
- `apps/desktop/src/ui-capture.ts` (new), `apps/desktop/src/ui-evidence.ts` (new). `composition.ts`, `server.ts`, `config-routes.ts`, `delivery.ts` (retry kind and PR body, small and local), `inspection.ts` (two stage cases, the fact, `screenshots` on detail), `release.ts`, `reason-words.ts`.
- `apps/desktop/package.json` (`playwright-core` 1.64.1, already in the lockfile), `scripts/bundle-desktop.mjs` and `scripts/pack-tarball.mjs` (external, installed).
- `apps/web`: `config-model.ts`, `config-decode.ts`, `api-config.ts`, `SettingsView.tsx`, `live/config.tsx`, `inspection-wire.ts`, `inspection-decode.ts`, `work-model.ts`, `WorkView.tsx`, `shell.css`.
- Tests and `tools/mutants/ui-evidence.json`; `docs/reference.md`.

`packages/contracts` is untouched: the repository record is a store document, not a contract type. `docs/DECISIONS.md` is untouched.

## Risks

- **Chromium on the installed machine.** `playwright-core` finds Playwright's Chromium in `~/Library/Caches/ms-playwright` (present here, from the web screens). An install without it reads as "Couldn't take the before screenshot: Chromium could not start: …", never as a pass; the fix is `npx playwright install chromium`.
- **A page that animates or loads late** may differ run to run. Both sides use the same wait (`load`, then up to 3 s of network idle) and animations are disabled for the shot.
- **The fence proxy** is in MEC's process, for the length of one capture. An app that needs another origin to render (a CDN font or script) renders without it, on both sides alike. That is a difference in the evidence, not a hole in the fence.
- **Load.** Each user-visible task with the flag on costs two Chromium launches. The service takes one task at a time.
- **A start command** runs on this machine like setup and checks, gated on the same agreement. It is killed by process group after the shots.
