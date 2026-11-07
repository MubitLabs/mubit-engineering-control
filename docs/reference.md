# MEC reference

The surfaces a user or script touches, exactly as they exist in the tree. The `mec` CLI lives in `apps/desktop/src/mec.ts` (entry `apps/desktop/bin/mec.js`); the HTTP API lives in `apps/desktop/src/server.ts`; the policy schema in `packages/policy/src/policy.ts`; the fixture library under `packages/testkit/fixtures/`. Behaviour of record: [`docs/plan/spec.md`](plan/spec.md).

## The `mec` CLI

What the router recognises today (`runCli` in `apps/desktop/src/mec.ts`; usage line: `mec <status|stop|restart|doctor|setup|slot|update|backup|restore> [flags]`):

| Command | What it does |
| --- | --- |
| `mec` | Starts the server and the workbench (the bin entry, `apps/desktop/bin/mec.js`); honours `MEC_DATA_DIR`, refuses to start while an intentional stop stands. |
| `mec status` | Prints the health snapshot's verdict and exits by the §21.2 contract (below). A start that lost its last port adds a line naming the new one. |
| `mec stop` | Writes the intentional-stop marker; `mec restart --respect-stop` will honour it. |
| `mec restart` | Clears the stop marker, stops the data dir's running server and starts a new detached one from the same install on the same port, then prints the port and pid. If nothing is running it starts one. It stops a server with SIGTERM only, and only a pid proven to be MEC's: `.mec.lock` and `health.json` must name the same pid, with the same process start time (or, for a server from before that field, a fresh heartbeat and a `mec` command line). Exit 1, with the reason and no second server, if the pid is not proven, the server has not exited within 45 s, or the new server has not answered within 40 s. The new server takes this command's environment, opens no browser and has no log: to see why a start failed, run `mec`. `--respect-stop` does nothing if an intentional stop stands. |
| `mec doctor` | Prints a redacted-by-construction diagnostics bundle (engine versions, allowlisted env, health snapshot) safe to paste into a bug report. |
| `mec slot add <kind> <label>` | Creates a slot home (kinds: `claude-sub`, `claude-api`, `codex-sub`, `opencode-glm`, `opencode-gemini`); local state in the data dir, never a server call — works before any server has started. |
| `mec slot list` | Lists slots with their state. |
| `mec slot probe <label>` | Probes a slot with the vendor's own `--version`/`--help`/auth-status commands (§5.8). |
| `mec slot retire <label>` | Shreds the slot's keystore and marks the slot retired. |
| `mec backup [--out <dir>]` | Writes a redacted archive of the store and state dir, by default to `<data dir>/backups`. `--out` can name any folder, including the data dir or a parent of it: only the backup's own archives and staging folder stay out of the archive. Reads the store through a read-only connection, so it needs no server and works beside a running one. Prints counts of files redacted and left out. |
| `mec restore <archive> [--target <dir>]` | Restores an archive into the data dir, or `--target`. Refuses a target holding anything at all and deletes nothing: move a damaged data dir aside yourself first. The archive is verified in a staging directory beside the target. Every `healthy` slot comes back `home_ready` and must re-probe before it can be scheduled. |
| `mec restore --drill <archive>` | Restores into a scratch dir, prints each check and removes the scratch dir. Touches no store. Exit 1 if a check fails. |
| `mec update` | Reports the installed version and the internal reinstall path (git repo or `MEC_REGISTRY`); no network check and no auto-update by design. |

`mec status` exit codes (first match wins, `apps/desktop/src/status.ts`):

| Code | Meaning |
| --- | --- |
| 0 | Runs normally (paused included); degraded parts add lines |
| 1 | Not running, running twice, not answering (`health.json`'s heartbeat is missing or more than 10 s from now), or runtime error — a restart may fix it |
| 2 | A part other than the runtime reports an error — a restart will not fix it; output names the part |
| 3 | Waiting for setup (no slot, no repository, not initialised) |

The planned §21 surface not yet in the router, `migrate`, is documented as a gap in [`docs/fault-suite.md`](fault-suite.md); the slot subcommands above plus the HTTP API below are the live slot surface.

## HTTP API

Every route in `apps/desktop/src/server.ts`. **Auth model: loopback only** — the server binds `127.0.0.1` with an ephemeral port on first start and the same port after a restart; if that port is taken it takes a new ephemeral one and prints a line saying so (`apps/desktop/src/composition.ts`); there are no remote listeners and no tokens in the API. The browser is the intended client.

### Chat

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| POST | `/api/chat/messages` | `{ text, repoId, referencesWorkItem?, intent?, setup? }` (+ `x-idempotency-key` header) | Sends one message. `repoId` names the repository's conversation: absent is `repo_required`, unknown (`unknown_repo`) or crossing (`repo_mismatch`) is a 400 before any write. `setup: true` and key-shaped text need no `repoId`: Setup talks to the setup agent, and key-shaped text is stored **redacted** and answered with a Slots pointer. `intent: 'new'` starts work even beside live work and refuses a reference (`new_refuses_reference`); `intent: 'follow_up'` needs one (`follow_up_needs_reference`). With no `intent`, §12.1 routing decides. The meta-agent path returns the acknowledgement, routing (`conversation`/`new_work`/`attach`) and launch count. A follow-up to stopped work is refused with routing `conversation` here; the signal is `stopped_refused` on the stored message, not this field. A replayed idempotency key returns the message's id and work item as `routing: 'duplicate'`, at once, even while its first turn is still planning; the same key with a different text, intent or reference is a 409 `idempotency_mismatch`, and with a different repository a 400 `repo_mismatch`. While paused a new request is stored and acknowledged, and its planner turn runs after resume. |
| GET | `/api/chat/messages` | `?repoId=` | All messages, oldest first, or one repository's. `unassigned` returns the rows with no repository. An unknown id is a 400. A turn that planned nothing and asked nothing has its report as `ackText`, the one line the chat shows. |

### Inbox (confirmations)

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/inbox` | — | Pending confirmation cards (id, class, operation hash, expiry). |
| POST | `/api/inbox/:id/resolve` | `{ answer: 'approve' \| 'deny' }` | Needs the approval key (see below), or answers `403 approval_required`. Resolves a card compare-and-set: the first answer wins; a second answer gets `409 already_handled`. `continues: true` says a running specialist was waiting on this approval. An approve of a card with no evidence answers `422 no_evidence`, and one nothing here can run answers `422 no_executor`; both stay pending and can be denied. | For a `slot_switch` card, an approve while the work is held answers `{ status: 'pending', reason: 'held' }` and keeps the card, and an approve of stopped work answers `{ status: 'stale', reason: 'mandate_withdrawn' }`.

### Approval key

Every `POST .../resolve` route and `POST /api/repositories/:id/host-run/agree` need the header `x-mec-approval`, or answer `403 approval_required`. The server mints the key at start, keeps it in memory, and never writes or serves it. A restart makes a new one.

| Method | Path | Body | Behaviour |
| --- | --- | --- | --- |
| POST | `/api/approval/link` | — | Opens a link with a one-time code in the default browser, at most once every 5 s. Answers `{ opened }`, never the code. |
| POST | `/api/approval/redeem` | `{ code }` | Answers `{ key }` once for a live code (2 minutes), or `403 approval_link_invalid`. |

A script that must answer cards starts the server itself with `mec --approval-key-fd=N`, handing its own key of at least 32 characters on that inherited descriptor. There is no environment variable, and `mec restart` does not carry the flag.

### Work

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/work` | `?repoId=` | Work items with title (the origin message's first line, 80 characters), state, stage, `held`, `blockedReason` when blocked, and task counts by status, or one repository's. `unassigned` returns the rows with no repository, which are read-only. An unknown id is a 400. |
| POST | `/api/work/:id/hold` | `{ reason? }` | Holds the work: `{ id, status: 'held' }`. A hold survives restart, a plan finishing during it is saved with no launches, and launches already queued wait. 404 unknown, 409 `{ error }`: `terminal`, or `read_only` for legacy Unassigned work. |
| POST | `/api/work/:id/lift` | — | The only release of a hold. Revalidates the mandate, lifts, and launches saved ready tasks that have no attempt: `{ id, status: 'lifted', launches }`. A launch queued before the hold restarts within 30 s. Work not held answers `status: 'free'` and writes nothing. 404 unknown, 409 `{ error }` with the hold kept: `mandate_withdrawn`, `mandate_expired`, `mandate_policy_changed`, `read_only`, or `no_meta_agent`. |
| POST | `/api/work/:id/retry` | — | The owner's retry (§11), once per press: `{ id, status: 'retrying', kind }`, where `kind` is `integration` for a blocked integration, or `push` or `pr` for a declined or failed delivery, which opens one new card and sends nothing. `GET /api/inspect/work/:id` carries the offer as `retry`. 404 unknown, 409 `{ error }`: `held`, `mandate_withdrawn`, `mandate_expired`, `mandate_policy_changed`, or `nothing_to_retry`. |
| POST | `/api/work/:id/stop` | — | Ends the work, withdraws its mandate, interrupts queued attempts and records an interrupt request for running ones: `{ id, status: 'stopped' }`. Final: only a new request starts the work again. Idempotent, works with no meta agent and on legacy work. 404 unknown, 409 `{ error: 'done' }` on finished work. |
| POST | `/api/processing/pause`, `/api/processing/resume` | — | Stops or restarts queue passes: `{ status: 'paused' \| 'running' }`. Idempotent. A pause is stored and survives restart; resume moves waiting deadlines later by its length. 404 when the server has no pause control. |
| GET | `/api/processing` | — | `{ paused, pausedAt? }`. `/api/status`, `health.json` and `mec status` report `paused` too. |

### Inspection (read-only, bounded)

Additive routes for the overhaul's views; `/api/work` and the other routes above are unchanged. Every string is redacted on the way out. A page is at most 100 rows (default 50, a larger `limit` is held to 100), and a byte cap ends a page early at 1 MiB of JSON with a valid `nextCursor`. In a detail answer each list has a count and a byte budget, and a `*Truncated` or `truncated` field counts what it left out. Many long ids, times and names are cut. Those bounds do not cover every field, so 1 MiB is enforced once more on the finished response: no response over 1,048,576 bytes of JSON is sent, and the route answers 500 with `{"error":"response_too_large","detail":...}` instead. Only an oversized record can cause that, and nothing writes one; retrying gives the same answer. The cursor is opaque. A malformed `limit` or `cursor`, or an unknown `repoId`, is a 400 before any query. A row with no `repoId` is Unassigned: `repoId: null`, `repoLabel: null`, `readOnly: true`. What is not recorded yet is `null`, `[]` or `coverage: false`, never zero. The stage is computed from facts (spec §10); an ended item shows its outcome.

| Method | Path | Query | What it does |
| --- | --- | --- | --- |
| GET | `/api/inspect/snapshot` | `?repoId=` | The oldest 100 registered repositories with their needs counts (`repositoriesTruncated` counts those left out), the needs count for the scope, and the event cursors (`repositories` and the newest 100 `work:<id>` streams) read in one consistent call. |
| GET | `/api/inspect/meta` | — | The meta agent's connection (`slotLabel`, `engine`, and `model` with `modelAt` from what the last turn really started on, null until one has) and one row per repository: `state`, `line`, `workItemId`, `running`, and `at`, which is when a running turn began, else the last recorded event. Nothing here is inferred from a clock. |
| GET | `/api/inspect/work` | `?repoId=&cursor=&limit=` | A page of work rows: title, repository, stage (`key`, `label`, `waitingOn`), reason, next action, task counts, last activity. |
| GET | `/api/inspect/work/:id` | — | One work item: its tasks (`tasksTruncated` counts those left out, and each task's `dependsOnTruncated` the ids left out), hold, delivery, `delegation` (one row per task from its attempts: role, requested tier or model, attempt count, the latest attempt with its actual model and placement reason, why it waits, the last recorded step), `turnOutcome` and `answer` (a request whose turn planned nothing: `answered`, or `no-answer` when it stopped with no report), coverage and cursors (`cursorsTruncated` counts attempt streams left out; the work stream and the newest attempts are kept). 404 for an id that is not a work item. |
| GET | `/api/inspect/tasks/:id` | — | One task: attempts (requested and actual model kept apart), checks and diff for the exact head only, reported usage with `usage.coverage` (`total`, `subtotal` or `unknown`), `outcome` (`process`, `validation` and `delivery` of the latest attempt with a head; a clean exit proves only the first), coverage. What was cut is counted: `dependsOnTruncated`, `attemptsTruncated` (older attempts; the newest are kept), `checks.truncated`, `diff.truncated`. |
| GET | `/api/inspect/needs` | `?repoId=&recent=1&cursor=&limit=` | A page of open questions, pending cards and `agreement` rows together, oldest first. An `agreement` row is one repository whose work waits on the owner, with its `waiting` count. `recent=1` adds up to 20 recently settled and expired ones after them, latest settled first (`answeredAt`, `resolvedAt`, or the expiry of a card that lapsed unanswered, then record order). The cursor is keyed by record, so an item settling between pages never skips another, and one walk serves at most 20 recent items; an item that settles while the walk is still on the open rows can appear again under `recent=1` with its new status. A card's `workItemId` is set only from a stored `workItemId` or `mandateId`, never from a branch name. |
| GET | `/api/inspect/search` | `?q=&repoId=` | Messages by text or id (wake rows are not messages and are left out), work by title, tasks by name, attempts by id, and references (`#12`, a GitHub PR URL, a SHA) where a stored field holds them. At most 20 per kind. |
| GET | `/api/inspect/attempts/:id/activity` | `?cursor=&limit=` | A page of `{seq, type, at, summary, detail}` from the attempt's stream, redacted. Only the contract's engine event types; a page can be short, or empty, with `nextCursor` still set. `tool_call` is a completed call, so nothing here says what is running now. 404 for an unknown attempt. |
| GET | `/api/inspect/artifacts` | `attemptId`, `ref`, `?cursor=` | One file under the attempt's worktree, as `text/plain` with `nosniff`, redacted on read, at most 1 MiB a page. `x-mec-artifact-size` gives the size and `x-mec-next-cursor` the next page. Every redaction layer applies: patterns, slot fingerprints and the attempt's exact token. A page never ends inside a key or a character, and a cursor inside a key answers from the start of that key. Binary files answer `{ref, binary: true, size}`. `..` and absolute refs answer 400; a symlink out of the worktree, and `.mec/` and `.git` in any case, answer 403; a file that is missing, or an attempt with no worktree, answers 404. |

Every `/api/inspect/*` route answers 403 `forbidden_host` unless `Host` is loopback, and 403 `client_header_required` for a browser-shaped request (`Origin`, `Referer`, `Sec-Fetch-*` or a `Mozilla/` user agent) without `x-mec-client: 1`.

### Slots

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/slots` | — | All slots — fingerprints only, never keys. |
| GET | `/api/connections` | — | `{ rows, options }`: one row per live slot from saved facts (engine version, identity, state and reason, last check). `usage`, `pin` and `pair` are `null` until something records them. `concurrency` and `slotClass` appear only when a slot doc sets them; absent means the scheduler's default. `options` lists each engine's real add paths: `link`, `sign_in`, `api_key`. |
| GET | `/api/parked` | — | `{ rows }`: each parked attempt that has not moved, with its work item, slot, state, redacted reason, `resetAt` (null when none was reported) and `worktreeKept` (§5.10). |
| POST | `/api/work/:id/switch-slot` | `{ toSlot, reason? }` | Moves parked work to a healthy slot on a new attempt in the same worktree. 202 `{ status: "confirmation", confirmationId }` opens a `slot_switch` card, unless policy pre-authorises it (200 `{ status: "switched" }`). 409 `{ error }` refuses, and an auth park always does. `capabilities.switchWork` says whether this is served. |
| POST | `/api/slots/dedicated` | `{ engine, label }` | Creates the slot a sign-in fills, `home_ready`, for `claude` or `codex`. 409 for a label in use. |
| POST | `/api/slots/:id/probe` | — | A signed-in slot's local status command in its own environment, at no token cost: `{ ok, state, reason? }`. Records version and non-secret identity. API-key slots use `validate`. 409 and no write if the slot is retired, even while the check runs. |
| GET | `/api/slots/:id/impact` | — | `{ slotId, label, running, queued, metaSlot, keyStored }`: what a retire touches, from saved docs. |
| POST | `/api/slots/:id/key` | `{ key }` | Replaces the key in place (same shape gate as `api-key`), then re-probes. Answers `{ id, fingerprint, probe }`, never the key. 400 for a slot with no key, 409 for a retired one. A retire during the re-probe keeps the 200, with `probe: { ok: false, reason: 'slot is retired' }`. |
| POST | `/api/slots/api-key` | `{ label, provider, key }` | The only way an API key enters MEC: key goes from the request straight into the slot keystore (0600); the store keeps the fingerprint; provider must be `anthropic-api` in v0. |
| POST | `/api/slots/:id/validate` | — | Zero-token validity probe (`GET /v1/models`): 200 → healthy; 401 → degraded `key_rejected`; network failure → `provider_unreachable`, state unchanged. 409 and no write if the slot is retired, even while the check runs. |
| POST | `/api/slots/:id/retire` | `{ label }` | Shreds the slot's keystore file and marks the slot retired. The body must repeat the slot's exact label, or it answers 400 `label_mismatch` and destroys nothing. `mec slot retire` is the owner's own terminal and takes no such step. |

### Setup and configuration

Readiness is read from saved facts: walking through Setup changes none of them. A step is `done`, `missing` or `skipped`, and a skip is never done. Every save that replaces something names the version it was drafted against; a stale one is 409 `stale_base`, nothing is written and the screen keeps the draft.

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/setup/readiness` | — | The five steps with their next action, the engines found, `metaCandidates` with the server's verdict on each, `finish`, and `completion` naming the repository and meta slot once the first four steps hold. It waits for the engine probes. With `?engines=known` it answers at once from the last probe and probes again behind the answer; until a first probe has answered, the `engines` step says `checking` and Finish stays off. |
| POST | `/api/setup/skip` | `{ step, skipped? }` | Notes that the owner moved on. A saved fact outranks it. |
| GET | `/api/setup/drafts` | — | Setup-agent proposals. A pending policy, models or prompts proposal carries `preview`: `{ base, changes: [{ label, before, after }] }`, the current text and the text Apply would save. `base` is the version `before` was read at. A repository proposal has none, and neither does one whose stored text no longer loads. A repository proposal that carried `trust` has `trustIgnored: true`: applying one always stores it untrusted. |
| POST | `/api/setup/drafts/:id/apply` | `{ base }` | Applies a proposal through the manual save's validation and stale check. `base` is the hash or revision the owner was looking at, which is `preview.base` when there is one; a repository draft needs none. |
| POST | `/api/setup/drafts/:id/dismiss` | — | Marks it `denied`. It can never apply. |
| GET | `/api/policy` | — | `{ text, sha256, revision, source, activeSha256, restartRequired, updatedAt? }`. |
| PUT | `/api/policy` | `{ text, base_sha256 }` | Validates with `loadPolicy`, so an always-confirm class is refused, and writes revision `n+1` to `settings/policy` with a `policy_updated` event on the `policy` stream. It applies to new work after the next restart. A launch queued under the old version never starts: the launch gate fails its attempt, which gives its capacity back, and blocks the work with `policy_changed`. Running attempts are not touched (§13). |
| GET | `/api/models/text` | — | `{ yaml, sha256, source, summary }`: the words a `PUT /api/models` replaces, and `summary` as `{ tiers, engines: [{ engine, models: [{ id, tier }] }] }` read from the same table. |
| POST | `/api/repositories/:id/host-run/agree` | — | Needs the approval key. The owner's agreement: sets `hostRunAgreedAt`, appends `host_run_agreed`, and wakes waiting launch rows. A repository starts unagreed, and absent means not agreed. Until then launches, resumes, setup and checks defer with `host_run_unagreed` and nothing runs. |
| POST | `/api/repositories/:id/host-run/withdraw` | — | Clears the agreement and appends `host_run_withdrawn`. Needs no key. New launches, setup and checks stop; an engine already running finishes its turn and its checks wait. |
| PATCH | `/api/repositories/:id` | `{ base_revision, bootstrapCmds?, checkCmds?, trusted? }` | Edits a repository under the argv rules and appends `repository_updated` to the `repositories` stream. `base_revision` comes from `GET /api/repositories`. Work already admitted keeps its pin. |
| GET | `/api/backups` | — | `{ lastAt?, archive?, note, excluded }`. Served only with a backup seam. |
| POST | `/api/backups` | — | Takes one backup into `<data dir>/backups` with `VACUUM INTO`, the same redacted backup as `mec backup`: `{ status, lastAt, archive }`. It runs on the request and blocks the server until it finishes. A failure answers 500 `backup_failed` and records nothing. |

`POST /api/wizard/meta-slot` refuses a retired, non-Claude, API-key or unhealthy slot with the reason. `GET /api/status` also carries `capabilities`: `{ switchWork, drain, backups, isolationEdit, pause }`.

### Login (OAuth terminal cards, §5.6)

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| POST | `/api/slots/login` | `{ engine, slotHome }` | Starts a login card for the vendor's own login command; serialised machine-wide — while one runs, returns its id with `busy: true`. |
| GET | `/api/slots/login/current` | — | SSE stream of the running card's events, live-only (never journaled, no replay); 404 when nothing runs. |
| POST | `/api/slots/login/cancel` | `{ id }` | Cancels the active card; the slot returns to `home_ready` with nothing half-written. |

### Release (the §14 GitHub leg — always-confirm)

Every card binds the exact head SHA it shows (`inputSha`). A card that cannot read its head never opens, and a head that moves after opening makes the card `stale`: nothing runs and a new card is needed. Approving is the action: a card is answered once, from the workbench or the routes below. `/api/inbox/:id/resolve` acts on release cards the same way.

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| POST | `/api/release/push` | `{ repoId, branch, headSha? }` | Opens a `push` card. `repoId` is a repository registered by local path; its clone is the git directory and its `origin` names the GitHub repository, so no path or repo is taken from the caller. The URL `gh` reports for that repository must be on the origin's host, or the card does not open (`remote_unreadable`), and the card binds and shows that URL. Refuses the default branch. |
| POST | `/api/release/push/:confirmationId/resolve` | `{ answer }` | On approve pushes exactly the bound SHA to `refs/heads/<branch>`. Never forces: a diverged branch is rejected. A failure spends the card and leaves a `push_failed` event. |
| POST | `/api/release/pr` | `{ repo, branch, title, body?, headSha? }` | Opens a `pr_create` confirmation card for the exact PR; nothing leaves the machine while it is pending. The branch must already be on GitHub. |
| POST | `/api/release/pr/:confirmationId/resolve` | `{ answer }` | Settles the card; on approve opens the PR through your own `gh`. It does not push; that is the `push` card. |
| POST | `/api/release/merge` | `{ repo, prNumber, confirmationId?, workItemId? }` | Opens a `pr_merge` card bound to that repo, PR and the head GitHub reports. With `workItemId` the card joins that work, whose delivery must be ready on this same PR (`404 unknown_work`, `409 delivery_mismatch`, `409 delivery_not_ready`). A card already open on the same head is answered, not doubled. |
| POST | `/api/release/merge/:confirmationId/resolve` | `{ answer }` | Deny settles at once and reads nothing. On approve, reads GitHub **before** touching the card: the PR must be open, on the bound head, with **required** checks passing (`SUCCESS`, `NEUTRAL` or `SKIPPED`; a check nobody requires cannot hold it), and `mergeStateStatus` must be `CLEAN`, `HAS_HOOKS` or `UNSTABLE`. Otherwise the card stays pending and `reason` says why: `ci_pending`, `ci_failed`, `ci_unreadable`, `no_required_checks`, `behind`, `blocked`, `dirty`, `draft`, `merge_state_unknown`, `pr_unreadable` or `pr_not_open`. Then runs `gh pr merge --squash --match-head-commit <head>` and reports `merged` only once GitHub's state says `MERGED`. |
| GET | `/api/inbox/:id/detail` | — | What a release card approves: repository, branch, head, and the title, body or PR number. 404 for a card with no release payload. |

Refusals to open a card answer 422 `{ error, detail }` (404 for `unknown_repo`). An always-confirm card nothing can run, such as `branch_delete`, answers an approve with 422 `no_executor` and stays pending; deny still settles it. Release events also land on the fixed `inbox` stream, which the workbench subscribes to.

### Events

| Method | Path | Query | What it does |
| --- | --- | --- | --- |
| GET | `/api/events` | `stream`, `after?`, `compact?` | SSE over the store's gap-free event log (`work:<id>`, `slot:<id>`, `release:…`), from `after` onwards. `stream=a,b&after=1,5` is one connection with comma-aligned cursors, and `Last-Event-ID` is ignored, so a client resumes with its own cursors. Bodies are redacted. `compact=1` sends `{stream, seq, type, at}` and no body. At most 100 events per stream per pass, and nothing while the socket pushes back. A client more than 10,000 events behind on one stream gets one `event: reset` frame (`{reason, stream}`) and the response ends: take a fresh snapshot and reopen. 403 `forbidden_host` unless `Host` is loopback. |

Also: `GET /healthz` → `{ ok: true }`, and `GET /api/status` → the §21.2 snapshot (`runtime`, `parts`, `setup.has_slot` / `setup.has_repository`) that `mec status` reads. The built workbench is served at `/*` with an SPA fallback.

## The policy file schema

From `packages/policy/src/policy.ts` — v0 is JSON (the plan's YAML is a later serialisation of the same shape). Loading (`loadPolicy`) validates and refuses unknown fields rather than ignoring them, so a typo can never silently loosen a guardrail. The parsed doc carries `versionHash`: sha-256 of the exact text, so formatting changes count as new versions.

```jsonc
{
  "capsOverride": { "parallel_attempts": 4 },     // optional: cap ceilings by name, non-negative
  "preAuthorised": {                              // REQUIRED ({} means nothing is pre-authorised)
    "install": [ { "scope": "repo", "repoId": "my-repo" } ],
    "spend":    [ { "scope": "work_item", "maxUsd": 5 } ]
  },
  "repoTightening": { "my-repo": { "spend": [ { "scope": "work_item", "maxUsd": 1 } ] } }
}
```

- **Entry shape** (`preAuthorised.<class>[]`): `{ scope: 'repo' | 'work_item', repoId?, maxUsd? }`; a `repo`-scoped entry must name its `repoId`; `maxUsd` is a non-negative ceiling.
- **Classes you may pre-authorise:** `install`, `migration`, `spend`, `slot_switch`, `unsandboxed`, `close_own_pr`.
- **Always-confirm means it cannot be turned off by policy:** `push`, `pr_create`, `pr_edit`, `pr_merge`, `branch_delete`, `force_op`. A document that pre-authorises any of them is a `policy_violation` at load; every resolution of these classes is a card a person answers (compare-and-set, first answer wins; expiry is never consent).
- **Repo overrides only tighten:** every class in `repoTightening` must exist in the base with entries at least as broad (same or narrower scope/repo, spend bound no higher); cap ceilings may only be lowered or added.

## Server flags

| Variable | Default | Effect |
| --- | --- | --- |
| `MEC_REAL_RUNNER=0` | on | Since 0.3.1 a launch effect starts a real specialist by default, through the attempt runner, on any engine `apps/desktop/src/engine-registry.ts` lists: Claude, Codex and OpenCode. `0` or `false`, in any case, turns it off: the launch then fails with `no_runner`, the work blocks with that reason and no process starts. The variable grants no authority: mandate, hold, repo and agreement checks run on every launch. An agreed repository's setup and checks run unsandboxed on the host as you, with your files and network (`docs/known-limits.md`). On, a launchable slot's marks are the capability table's entries. On or off, plans and placement see only launchable slots. `mec restart` passes on the environment of the shell that runs it, so an off server stays off only if that shell sets it too. |
| `MEC_FAKE_ENGINE=1` | off | The fixture replay stands in for an engine. It wins over `MEC_REAL_RUNNER`. |

## How a task gets its slot

The planner asks and deterministic code grants (spec §11). The rule, in order; each attempt's `placement` says which steps decided:

1. **Launchable only.** A slot takes work only if this build has proved its kind: a row in `apps/desktop/src/engine-registry.ts`, and a home. Today that is `claude-sub`, `codex-sub` and `opencode-glm`. Anything else, `opencode-gemini` and `claude-api` included, is left out of plan validation and placement alike, with the runner on or off, so a plan pinning one is refused. `MEC_FAKE_ENGINE=1` places on its one fake slot instead.
2. **What can take it.** Healthy (§5.5), serving the task's model or tier (§3), under the utilisation ceiling and with a free unit (§11).
3. **A pin wins.** A task pinned to a slot waits for that slot and goes nowhere else.
4. **A `slot_class` hint is a preference** (DECISIONS #43). Slots in the class go first; if none can take the task, any other may, and the placement says the class was missed.
5. **The meta slot's engine** (`settings/meta-slot`, chosen in the wizard) goes next, on slots where the tier fits without degrading. If none does, another engine takes the task and the placement says so. With no meta slot chosen, or a retired one, this step does nothing.
6. **A stable order:** lowest utilisation, then fewest attempts, then id. No reading ranks as least utilised.

Step 5 outranks utilisation, so work stays on the meta engine until its slots are full, over the ceiling or short of the tier.

## Fixture library layout

Per [`docs/handoff/CONTRACTS.md`](handoff/CONTRACTS.md) §9: `packages/testkit/fixtures/<engine>/<engine_version>/<scenario>/` holding

- `meta.json` — `{ engine, engine_version, scenario, recorded_at, recorded_by: 'real' | 'fake', redacted: true, expected: { reports, permission_requests, rate_limits, exit }, notes? }`
- `raw.jsonl` — the engine's own stream, redacted
- `events.jsonl` — the normalised `EngineEvent`s (no `seq`/`at`/`attempt_id`/`generation`; the replayer assigns them)
- optionally `stderr.log` (redacted, possibly empty)

The eleven scenarios every engine needs before its handshake: `smoke`, `permission_request`, `rate_limit_warning`, `rate_limit_rejected`, `auth_expired`, `provider_down`, `max_turns`, `report_ready_with_question`, `report_blocked`, `report_dropped`, `crash_mid_turn`. Provider error bodies (GLM 429, Gemini 429 with `RetryInfo`, Anthropic/OpenAI 429) belong under `providers/<provider>/` (not yet recorded — see [`docs/fault-suite.md`](fault-suite.md)).

Today the library holds Claude 2.1.317 (`smoke`, `auth_expired`, `max_turns`, `crash_mid_turn` — recorded from the real binary, `recorded_by: 'real'`) and synthetic Codex 0.148.0 / OpenCode 2.2.5 recordings (`recorded_by: 'fake'`). Conformance runs in `packages/engines/test/stream-conformance.test.ts` (both suites): the real adapter parsing `raw.jsonl` must yield `events.jsonl`, the `FakeEngine` replay must yield the same events, the stream invariants must hold (one `session_started` first, one `exit` last, `seq` strictly increasing, no key-shaped text) and `meta.expected` must match.

## What is tested

The plan's §26 verification matrix — every fault row, what proves it today (test file and provenance: real fixture / synthetic fixture / no fixture) and what remains — lives in [`docs/fault-suite.md`](fault-suite.md). That file is the honest answer to "is this verified?"; handshake runs that gates depend on are recorded in [`docs/log/HANDSHAKES.md`](log/HANDSHAKES.md).
