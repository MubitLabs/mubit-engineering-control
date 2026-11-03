# MEC v4.1 — Contracts v0 (`packages/contracts`)

The shared interfaces between Stream A (core and workflow) and Stream B (engines, slots and runtime). Written by A from this file in the first three days, reviewed by B against the installed engines and the v1 adapter, tagged `contracts-v0`, then frozen. Everything below is a Zod schema or a TypeScript interface in `packages/contracts/src`; this file is the design, the code is the truth.

## 0. Conventions

- **Schemas, not types.** Every data shape is a Zod schema with an inferred type; every schema has a spec with two valid and two invalid samples.
- **Ids** are opaque strings with a prefix: `wi_` work item, `task_`, `att_` attempt, `slot_`, `eng_` engine, `msg_` message, `conf_` confirmation, `q_` question, `rep_` report, `inp_` input. `generation` is an integer that increases per attempt relaunch.
- **Times** are ISO-8601 UTC strings (`Date#toISOString`) and compare as text. **SHAs** are 40 hex characters. **Paths** are absolute.
- **Unknown is explicit.** A reading that does not exist is the literal `'unknown'`, never `null`, `0` or a guess.
- **No credential has a field.** The only secret-adjacent shape is `KeyFingerprint { provider, last4, hash }`. A schema with a field named `token`, `key`, `secret` or `password` fails the contracts lint.
- **Who implements what**: A = `packages/domain`, `effects`, `mec-tools`, store; B = `runtime`, `engines`, `slots`, `git`. Each interface below says which.

Files: `events.ts`, `brief.ts`, `report.ts`, `bridge.ts`, `adapter.ts`, `runtime.ts`, `slots.ts`, `core-facts.ts`, `store.ts`, `effects.ts`, `health.ts`, `errors.ts`, `fixtures.ts`, `index.ts`.

## 1. `events.ts` — `EngineEvent`

The normalised, engine-agnostic stream every adapter emits and the `FakeEngine` replays. Discriminated on `type`; every event also carries `seq` (monotonic per attempt, assigned by the runtime), `at`, `attempt_id`, `generation`.

| `type` | Fields | Notes |
| --- | --- | --- |
| `session_started` | `session_id`, `engine`, `engine_version`, `model?` | first event; `session_id` is what resume needs |
| `message` | `role: 'assistant' \| 'user' \| 'system'`, `text`, `truncated?: boolean` | text already redacted |
| `tool_call` | `tool`, `input: json`, `output?: json`, `ok?: boolean`, `duration_ms?` | one event per call, emitted when the call completes |
| `permission_request` | `request_id`, `operation: Operation`, `evidence: Evidence` | the adapter has already asked the bridge or is about to; see §3 |
| `permission_result` | `request_id`, `decision: Decision` | echo of what the engine was told |
| `usage` | `input_tokens`, `output_tokens`, `cache_read?`, `cache_write?`, `cost_usd?: number \| 'unknown'` | cumulative per attempt when the engine reports cumulatively; the adapter says which in `Capabilities.usage_mode` |
| `rate_limit` | `window: Window`, `status: 'allowed' \| 'warning' \| 'rejected'`, `utilization?: 0–1`, `resets_at?: string \| 'unknown'`, `raw?: json` | `Window = 'five_hour' \| 'seven_day' \| 'seven_day_opus' \| 'seven_day_sonnet' \| 'weekly' \| 'per_minute' \| 'per_day' \| 'overage' \| 'unknown'` |
| `report` | `report: Report` | §2 |
| `error` | `class: ErrorClass`, `detail`, `raw?: json` | `ErrorClass = 'quota' \| 'auth' \| 'provider_down' \| 'engine_bug' \| 'repo_failure' \| 'unknown'` |
| `exit` | `code: number`, `terminal_reason: 'completed' \| 'max_turns' \| 'budget' \| 'api_error' \| 'aborted' \| 'killed' \| 'crashed'` | last event |

Invariants the conformance test checks: exactly one `session_started` first and one `exit` last; `seq` strictly increasing; no `message.text` matches a provider key pattern (§9 redaction patterns live in `packages/slots` but the contracts package exports the regex list so the lint can run everywhere).

Clarifications from part 1, from B's recordings of Claude Code 2.1.317 (`docs/engines.md`):

- One `rate_limit_event` carries several `unifiedWindows`; the adapter emits one `rate_limit` per window. `raw` carries the engine event's top-level fields, so on the `seven_day` event `raw.rateLimitType` names the binding window, not that event's window.
- `resetsAt` arrives in unix seconds; the adapter converts it to `toISOString` form. Claude's `allowed_warning` maps to `warning`.
- `system/commands_changed` is not normalised; the raw stream and the journal keep it.
- `role: 'user'` appears only for streamed two-way input: a static `-p` prompt is not echoed, and user-type events carrying `tool_result` blocks complete a `tool_call` instead.
- `exit.terminal_reason` comes from the engine's `terminal_reason`, never `result.subtype`. With no `result` (a crash), the runtime emits `exit { code: 128 + signal, terminal_reason: 'crashed' }`.
- `checkEventStream(events)` in `events.ts` implements the invariants and accepts fixture bodies (no `seq`) as well as enveloped events.

## 2. `brief.ts` and `report.ts`

**`AttemptBrief`** (A builds, B launches):

```
attempt_id, generation, task_id, work_item_id
role: { name, revision }
engine: 'claude' | 'codex' | 'opencode'
slot_id, worktree, base_sha, branch
origin: { messages: { id, text | pointer }[] }      // the original request, verbatim or by read pointer
objective, owned_paths: string[], acceptance_checks: string[]
routing_note?: string                                // ≤ 50 words, context only
budget: { turns, wall_clock_ms, usd?: number }
bundle_revision
tools: { url, token }                                // attempt-scoped, §6 of the plan
env: Record<string, string>                          // non-secret additions only; lint rejects secret-named keys
isolation: IsolationProfile                          // §5 below
```

**`Report`** (closed vocabulary; plan §10):

```
kind: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
summary: string                                      // ≤ 2,000 chars
head_sha?: string
checks_run?: string[]
artifacts?: { kind, ref }[]
question?: Question | null                           // omitted = keep the open question; null = clear it
round?: { reviewer?: string, count: number }         // review/repair round bookkeeping
handled_inputs?: string[]                            // inp_ ids acknowledged or answered
handback?: { message_id, reason }                    // once per message
```

**`Question`**: `{ id?, text (≤ 400 chars), options?: string[], for_message_id?: string, evidence_ref?: string }`. Same `text` as the open question = reuse; different = replace.

Clarifications from part 1:

- **`AttemptRef`** = `{ attempt_id, generation }` (`common.ts`); every runtime call, bridge request and fact names an attempt this way.
- **`IsolationProfile`** is defined in `brief.ts`, because the brief carries it; part 2's `slots.ts` re-exports it.
- **`tools.token`** is the one field the §0 secret-field lint exempts. `issueToken` mints it at launch; it is never written to an effects payload or any table (plan §17).
- `origin.messages` items carry `text` or `pointer`, never both. `env` refuses names that contain `KEY`, `PASSWORD`, `SECRET` or `TOKEN` (plan §5.12), and values that match a provider key pattern; `MEC_TOOLS_TOKEN` therefore travels only through `tools.token`.

## 3. `bridge.ts` — permissions

```
Operation = { kind: 'shell' | 'edit' | 'write' | 'network' | 'external_directory' | 'mcp_tool' | 'other',
              summary: string, command?: string[], paths?: string[], hosts?: string[], tool?: string }
Evidence  = { raw: json, worktree: string, head_sha?: string }
Decision  = 'allow' | 'deny' | 'expired'

interface PermissionBridge {                                   // A implements (in mec-tools)
  request(attempt: AttemptRef, operation: Operation, evidence: Evidence, deadline: string): Promise<Decision>
}
```

Both paths end here: Claude Code calls the MCP tool `mcp__mec__confirm` on A's server directly; Codex and OpenCode adapters receive a native request id and call `request` in-process, then answer the engine with the mapped native decision. `expired` means the deadline passed; the adapter denies the native request and emits `permission_result`.

## 4. `adapter.ts` and `runtime.ts`

```
interface EngineAdapter {                                      // B, one per engine
  probe(slot: SlotRef): Promise<{ capabilities: Capabilities, auth: AuthHealth }>
  launch(spec: LaunchSpec): Promise<AttemptHandle>             // the adapter builds argv and engine config files
  send(h: AttemptHandle, input: Input): Promise<void>
  interrupt(h: AttemptHandle): Promise<void>
  stop(h: AttemptHandle): Promise<void>
  events(h: AttemptHandle): AsyncIterable<EngineEvent>
  classify(error: unknown): ErrorClass
  mapReport(final: unknown): Report
}
LaunchSpec    = { brief: AttemptBrief, env: Record<string,string>, cwd: string, resume?: { session_id }, bridge: PermissionBridge }
AttemptHandle = { attempt_id, generation, pid?: number, session_id?: string }
Input         = { id: string, kind: 'message' | 'note' | 'policy_changed' | 'recovery', text: string, message_id?: string }

Capabilities  = { engine_version, flags_verified: string[], structured_stream, questions, tool_approval, interrupt,
                  resume, usage, rate_limit_events, sandbox, restricted_mode, mcp_http: boolean,
                  usage_mode: 'cumulative' | 'delta' | 'none' }
AuthHealth    = { logged_in: boolean, method?: string, expires_soon?: boolean, detail?: string }

interface Runtime {                                            // B
  launchAttempt(attempt: AttemptRef, brief: AttemptBrief): Promise<void>   // env, shims, gitconfig, worktree, journal, then adapter.launch
  deliver(attempt: AttemptRef, input: Input): Promise<void>
  stop(attempt: AttemptRef): Promise<void>
  replay(attempt: AttemptRef): Promise<void>                   // journal → CoreForEngines facts after a restart
}
```

Division of labour inside `launch`: the runtime builds the environment (allowlist, scrub, slot layer, attempt layer), the shim directory, the gitconfig and the worktree; the adapter builds argv, the per-attempt settings/config files and the MCP configuration from `brief.tools`, and starts the process inside the runtime's process group.

## 5. `slots.ts`

```
EngineId   = 'claude' | 'codex' | 'opencode'
SlotKind   = 'claude-sub' | 'claude-api' | 'claude-glm' | 'codex-sub' | 'codex-api' | 'opencode-glm' | 'opencode-gemini'
ProviderId = 'anthropic-sub' | 'anthropic-api' | 'openai-sub' | 'openai-api' | 'zai-coding-plan' | 'google-gemini'
SlotState  = 'draft' | 'home_ready' | 'login_pending' | 'healthy' | 'degraded' | 'retired'
Degraded   = 'auth_expired' | 'key_rejected' | 'quota_exhausted' | 'engine_missing' | 'engine_unsupported' | 'provider_unreachable'

Slot = { id, label, engine: EngineId, kind: SlotKind, provider: ProviderId, home: string,
         credential_kind: 'oauth' | 'api_key', fingerprint?: KeyFingerprint,
         identity?: { email?, org?, plan?, auth_method? },
         state: SlotState, state_reason?: Degraded, resets_at?: string | 'unknown', last_probe_at?,
         usage: UsageReading | 'unknown', engine_version?, capabilities?: Capabilities,
         pinning: { roles: string[] }, pairs: string[], concurrency: number }
UsageReading = { window: Window, utilization?: 0–1, resets_at?: string | 'unknown', observed_at,
                 source: 'engine_event' | 'provider_error' | 'status_command' }
KeyFingerprint = { provider: ProviderId, last4: string, hash: string }     // salted SHA-256

interface Slots {                                              // B
  list(): Promise<Slot[]>
  healthy(filter: { engine?, kind?, provider?, role?, exclude?: string[] }): Promise<Slot[]>
  reserve(slot: string, attempt: AttemptRef): Promise<Reservation | 'full'>
  release(r: Reservation): Promise<void>
  usage(slot: string): Promise<UsageReading | 'unknown'>
  probe(slot: string): Promise<SlotState>
  on(event: 'slot.changed', handler: (slot: Slot) => void): void
}

IsolationProfile = { sandbox: 'required' | 'preferred' | 'off', read_only: boolean,
                     allow_write: string[], deny_read: string[], allowed_domains: string[],
                     blocked_commands: string[], background_cap_ms: number,
                     permission_mode: 'bridge' | 'none', repo_trusted: boolean }
```

`reserve` is the only way an attempt consumes slot capacity; the scheduler (A) never counts for itself. A fixture of concurrent reservations (`slots/reserve-race.json`) is part of the conformance suite.

## 6. `core-facts.ts` — `CoreForEngines`

A implements; the runtime and adapters report facts in the past tense; they may not be refused.

```
attemptStarted(attempt, generation, session_id?, at)
inputsDelivered(attempt, input_ids[])
inputsRead(attempt, input_ids[])             // only once a report or turn end followed
turnEnded(attempt, generation)
reportReceived(attempt, generation, report)
permissionRequested(attempt, request_id, operation)   // record only; the decision came from the bridge
rateLimitObserved(attempt, slot, reading)
usageObserved(attempt, usage)
attemptExited(attempt, generation, exit)
deliveryFailed(attempt, input_ids[], error)
slotChanged(slot)                            // from packages/slots
```

Until A1 lands, B tests against `MemoryCoreForEngines` from `packages/testkit` (A ships it on day 3 as a recording stub).

## 7. `store.ts`, `effects.ts`, `health.ts`

```
interface Store {                                              // A
  atomic<T>(fn: () => T): T                                    // nested rollback; afterCommit(fn) runs only on commit
  workItems, tasks, attempts, messages, confirmations, slots, engines: Repository<...>  // get, save, list*
  events: { append(stream: string, event: DomainEvent): void; read(stream, after?: number): DomainEvent[] }
  effects: Effects
}
interface Effects {                                            // A
  enqueue(kind: EffectKind, key: string, payload: json): void   // inside a transaction; one row per kind+key, coalescing
  handle(kind: EffectKind, run: (payload) => Promise<void>, opts: { concurrency: number, ordered?: boolean }): void
}
class Later extends Error {}                                   // defer without counting a failure
EffectKind = 'launch' | 'deliver' | 'relay' | 'note' | 'reply' | 'external' | 'probe'
// B registers handlers for launch, deliver, probe; A for relay, note, reply, external.

interface HealthBoard {                                        // A
  claim(name: HealthName): { starting(), ready(detail?), paused(), error(detail) }   // second claim throws
}
HealthName = 'runtime' | 'scheduler' | `effects:${EffectKind}` | 'outbox' | `slot:${string}` | `engine:${string}` | 'integration' | 'meta_agent' | 'backup'
```

`MemoryRepositories` (A, in `packages/testkit`) mirrors the store's ordering and nested rollback so B's unit tests need no SQLite.

## 8. `errors.ts`

`UserError(code, values)` — refusals a person or an agent can cause; the API answers `missing` with 404, `stale_revision` with 409, the rest with 400; the panel words each code.

Codes v0: `missing`, `stale_revision`, `invalid_plan`, `cap_exceeded`, `budget_exceeded`, `slot_unhealthy`, `slot_full`, `mandate_withdrawn`, `work_item_held`, `not_owner`, `already_handled`, `confirmation_stale`, `confirmation_expired`, `policy_violation`, `secret_in_input`, `engine_unsupported`, `login_in_progress`, `invalid_key`, `repo_untrusted`.

## 9. `fixtures.ts` — the fixture library

Path: `packages/testkit/fixtures/<engine>/<engine_version>/<scenario>/` containing `meta.json`, `raw.jsonl` (the engine's own stream, redacted) and `events.jsonl` (the normalised `EngineEvent`s without `seq`, `at`, `attempt_id`, `generation`, which the replayer assigns).

```
meta.json = { engine, engine_version, scenario, recorded_at, recorded_by: 'fake' | 'real',
              redacted: true, expected: { reports: ReportKind[], permission_requests: number,
              rate_limits: Window[], exit: ExitReason },
              notes?: string }
```

Clarifications from part 1 (the schema itself lands in part 3): `notes` is free text on what the recording shows; a scenario directory may also hold `stderr.log` (the engine's stderr, redacted, possibly empty); `recorded_at` is in `toISOString` form like every other time (§0).

Scenarios every engine must have before its handshake: `smoke`, `permission_request`, `rate_limit_warning`, `rate_limit_rejected`, `auth_expired`, `provider_down`, `max_turns`, `report_ready_with_question`, `report_blocked`, `report_dropped`, `crash_mid_turn`. Provider error bodies (GLM 429, Gemini 429 with `RetryInfo`, Anthropic/OpenAI 429) live under `providers/<provider>/`.

**Conformance test** (`packages/testkit/conformance.spec.ts`, run by both suites): for each fixture, (a) the adapter parsing `raw.jsonl` yields `events.jsonl`; (b) the `FakeEngine` replaying `events.jsonl` yields the same `EngineEvent`s; (c) the invariants of §1 hold; (d) `meta.expected` matches. A fixture is recorded by B with `mec-devtools record --engine claude --scenario smoke`, which redacts with the §1 pattern list and fails on any residual match.

## 10. Change log

| Date | Change | Reviewers |
| --- | --- | --- |
| 2026-11-03 | v0 frozen (tag `contracts-v0`), all nine parts implemented. Two documented exemptions to the §0 credential-field lint: `AttemptBrief.tools.token` (attempt-scoped, minted at launch, never stored) and `EffectJob.key` (the §7 coalescing key — an id, never a secret). §4 `SlotRef` = `Pick<Slot, 'id'\|'engine'\|'kind'\|'home'\|'credential_kind'>`; §6 `attemptStarted` takes `session_id: string \| undefined`. Engine facts from Claude 2.1.317 recordings folded into §1 (see `docs/engines.md` in the pre-flight record) | A, B (one operator from 3 Nov evening) |
