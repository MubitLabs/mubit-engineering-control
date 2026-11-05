# MEC reference

The surfaces a user or script touches, exactly as they exist in the tree. The `mec` CLI lives in `apps/desktop/src/mec.ts` (entry `apps/desktop/bin/mec.js`); the HTTP API lives in `apps/desktop/src/server.ts`; the policy schema in `packages/policy/src/policy.ts`; the fixture library under `packages/testkit/fixtures/`. Behaviour of record: [`docs/plan/spec.md`](plan/spec.md).

## The `mec` CLI

What the router recognises today (`runCli` in `apps/desktop/src/mec.ts`; usage line: `mec <status|stop|restart|doctor|slot|update> [flags]`):

| Command | What it does |
| --- | --- |
| `mec` | Starts the server and the workbench (the bin entry, `apps/desktop/bin/mec.js`); honours `MEC_DATA_DIR`, refuses to start while an intentional stop stands. |
| `mec status` | Prints the health snapshot's verdict and exits by the §21.2 contract (below). |
| `mec stop` | Writes the intentional-stop marker; `mec restart --respect-stop` will honour it. |
| `mec restart` | Clears the stop marker and starts the server; `--respect-stop` does nothing if an intentional stop stands. |
| `mec doctor` | Prints a redacted-by-construction diagnostics bundle (engine versions, allowlisted env, health snapshot) safe to paste into a bug report. |
| `mec slot add <kind> <label>` | Creates a slot home (kinds: `claude-sub`, `claude-api`, `codex-sub`, `opencode-glm`, `opencode-gemini`); local state in the data dir, never a server call — works before any server has started. |
| `mec slot list` | Lists slots with their state. |
| `mec slot probe <label>` | Probes a slot with the vendor's own `--version`/`--help`/auth-status commands (§5.8). |
| `mec slot retire <label>` | Shreds the slot's keystore and marks the slot retired. |
| `mec update` | Reports the installed version and the internal reinstall path (git repo or `MEC_REGISTRY`); no network check and no auto-update by design. |

`mec status` exit codes (first match wins, `apps/desktop/src/status.ts`):

| Code | Meaning |
| --- | --- |
| 0 | Runs normally (paused included); degraded parts add lines |
| 1 | Not running, running twice, not answering, or runtime error — a restart may fix it |
| 2 | A part other than the runtime reports an error — a restart will not fix it; output names the part |
| 3 | Waiting for setup (no slot, no repository, not initialised) |

Planned §21 surfaces not yet in the router — `backup`, `restore`, `migrate` — are documented as gaps in [`docs/fault-suite.md`](fault-suite.md); the backup/restore engines exist as modules (`apps/desktop/src/backup.ts`, `restore.ts`), and the slot subcommands above plus the HTTP API below are the live slot surface.

## HTTP API

Every route in `apps/desktop/src/server.ts`. **Auth model: loopback only** — the server binds `127.0.0.1` with an ephemeral port (`apps/desktop/src/composition.ts`); there are no remote listeners and no tokens in the API. The browser is the intended client.

### Chat

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| POST | `/api/chat/messages` | `{ text, referencesWorkItem? }` (+ `x-idempotency-key` header) | Sends one message. Key-shaped text is stored **redacted** and answered with a Slots pointer; the meta-agent path returns the acknowledgement, routing (`conversation`/`new_work`/`attach`) and launch count; a replayed idempotency key returns the first answer verbatim. |
| GET | `/api/chat/messages` | — | All messages, oldest first. |

### Inbox (confirmations)

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/inbox` | — | Pending confirmation cards (id, class, operation hash, expiry). |
| POST | `/api/inbox/:id/resolve` | `{ answer: 'approve' \| 'deny' }` | Resolves a card compare-and-set: the first answer wins; a second answer gets `409 already_handled`. |

### Work

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/work` | — | Work items with state, stage and task counts by status. |

### Slots

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/api/slots` | — | All slots — fingerprints only, never keys. |
| POST | `/api/slots/api-key` | `{ label, provider, key }` | The only way an API key enters MEC: key goes from the request straight into the slot keystore (0600); the store keeps the fingerprint; provider must be `anthropic-api` in v0. |
| POST | `/api/slots/:id/validate` | — | Zero-token validity probe (`GET /v1/models`): 200 → healthy; 401 → degraded `key_rejected`; network failure → `provider_unreachable`, state unchanged. |
| POST | `/api/slots/:id/retire` | — | Shreds the slot's keystore file and marks the slot retired. |

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
| POST | `/api/release/merge` | `{ repo, prNumber, confirmationId? }` | Opens a `pr_merge` card bound to that repo, PR and the head GitHub reports. |
| POST | `/api/release/merge/:confirmationId/resolve` | `{ answer }` | Deny settles at once and reads nothing. On approve, reads GitHub **before** touching the card: the PR must be open, on the bound head, with **required** checks passing (`SUCCESS`, `NEUTRAL` or `SKIPPED`; a check nobody requires cannot hold it), and `mergeStateStatus` must be `CLEAN`, `HAS_HOOKS` or `UNSTABLE`. Otherwise the card stays pending and `reason` says why: `ci_pending`, `ci_failed`, `ci_unreadable`, `no_required_checks`, `behind`, `blocked`, `dirty`, `draft`, `merge_state_unknown`, `pr_unreadable` or `pr_not_open`. Then runs `gh pr merge --squash --match-head-commit <head>` and reports `merged` only once GitHub's state says `MERGED`. |
| GET | `/api/inbox/:id/detail` | — | What a release card approves: repository, branch, head, and the title, body or PR number. 404 for a card with no release payload. |

Refusals to open a card answer 422 `{ error, detail }` (404 for `unknown_repo`). An always-confirm card nothing can run, such as `branch_delete`, answers an approve with 422 `no_executor` and stays pending; deny still settles it. Release events also land on the fixed `inbox` stream, which the workbench subscribes to.

### Events

| Method | Path | Query | What it does |
| --- | --- | --- | --- |
| GET | `/api/events` | `stream`, `after?` | SSE over the store's gap-free event log (`work:<id>`, `slot:<id>`, `release:…`), from `after` onwards. |

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
