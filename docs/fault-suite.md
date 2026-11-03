# §26 verification matrix — evidence and gaps

Every row of plan §26, what proves it today, and what remains. Written 3 Nov (single-operator day 1 evening); update as gaps close.

**Relabelled by the R0 audit (3 Nov, cold clone).** Every row that claims evidence now names the test file and the provenance of what that test runs against, using three labels:

- **real fixture** — a `packages/testkit/fixtures` recording with `recorded_by: 'real'` (Claude 2.1.317 only; four scenarios).
- **synthetic fixture** — a recording with `recorded_by: 'fake'` (all Codex 0.148.0 and OpenCode 2.2.5 recordings; synthesised from documented protocols, never from a real binary).
- **no fixture** — a unit/integration test over inline inputs, an injected seam, the real git binary, the real filesystem or the real SQLite store. This is not a slight: most of these rows are domain/policy behaviour that needs no engine. But no row below is proven by a real Codex or OpenCode recording, and no row is proven by a real engine process.

| §26 row | Evidence today (test file · provenance) | Gap |
| --- | --- | --- |
| Quota park | engines fixtures: parse+classify per engine (`packages/engines/test/stream-conformance.test.ts` · **real fixture** for Claude smoke/max_turns; `codex.test.ts`, `opencode.test.ts` · **synthetic fixture**); runtime `parkFromEvents` quota/auth/provider, last-writer-wins (`packages/runtime/test/park.test.ts` · inline events, **no fixture**) | composition: park an attempt from a rejected event end-to-end |
| Slot failover | — | handoff orchestration across slots (same worktree, new attempt, recorded handoff) |
| Auth expiry | slots probes degraded `auth_expired` (`packages/slots/test/probes.test.ts` · injected `ProbeRun`, **no fixture**); scheduler defers `slot_unhealthy` (`packages/domain/test/scheduling.test.ts` · **no fixture**); engine-side auth_expired parse (`stream-conformance.test.ts` · **real fixture** Claude; `codex.test.ts`/`opencode.test.ts` · **synthetic fixture**) | re-login card + auto-resume after healthy probe |
| Confirmation race | policy CAS: double resolve throws `already_handled` (`packages/policy/test/confirmations.test.ts` · **no fixture**); server 409 path proven once by the R0 audit over real HTTP (docs/STATUS.md). The audit's `expectedInputSha` route bug (inputSha-bound confirmations resolving `stale` over HTTP) is FIXED: the route forwards the pending card's `inputSha` (`apps/desktop/src/server.ts`, tested in `server.test.ts` "inbox resolve binds to the card input (audit #5)") | server 409 path (repo test) |
| Stale confirmation | policy: opHash/inputSha mismatch → `stale`; expiry never consent (`packages/policy/test/confirmations.test.ts` · **no fixture**) | — |
| Meta-agent authority | mec-tools role fencing (`packages/mec-tools/test/tools.test.ts`, `server.test.ts` over real loopback HTTP, `tokens.test.ts` · **no fixture**); escalation counter (`packages/meta/test/escalation.test.ts` · **no fixture**) | four-invalid-proposal escalation wired to a real turn loop |
| Duplicate input | acks idempotent per message id (`packages/meta/test/acks.test.ts` · **no fixture**); journal dedupe by seq (`packages/runtime/test/journal.test.ts` · real fs journal, **no fixture**); server `x-idempotency-key` replay (`apps/desktop/test/server.test.ts:128` · fastify `inject` + `MemoryRepositories`, **no fixture**) | idempotency proven against the in-memory store only, not the SQLite store under the composed server |
| Crash between delivered/read | — | the full receipt ladder model (received→delivered→read→handled→settled) — only acks+handback exist |
| Restart mid-attempt | journal replay tests: torn line, ack cursor, reopen (`packages/runtime/test/journal.test.ts` · real fs, **no fixture**) | composition-level replay into store facts |
| Human stop | routing `stopped_refused` (`packages/meta/test/routing.test.ts` · **no fixture**) | mandate withdraw/revalidate ops |
| Parallel branches | git worktrees + clean-merge tests, two parents, exact SHA (`packages/git/test/repos-worktrees.test.ts`, `merge.test.ts` · **real git binary** against `file://` remotes, **no engine fixture**) | — |
| Integration conflict | mid-merge repair: both sides, parentCount 2, checks on repaired SHA (`packages/git/test/merge.test.ts` · **real git binary**, **no engine fixture**) | queue wiring to create the repair task |
| Prompt upgrade | prompts: identical-to-default removed, stale base → draft preserved (`packages/prompts/test/upgrades.test.ts` · **no fixture**) | Default-updated UI flow |
| Redaction | secrets lint over schema source (`packages/contracts/test/secret-fields.test.ts`); pattern unit tests (`secrets.test.ts`); slots redaction (`packages/slots/test/redaction.test.ts`); runtime `redactEvent` (`packages/runtime/test/redact-events.test.ts`); doctor (`apps/desktop/test/doctor.test.ts`) — all **no fixture** (inline key-shaped strings); R0 audit additionally fed all five provider key shapes through the real `redact()`/`redactEvent()` (docs/STATUS.md) | wire the filter into the journal write path at composition |
| Restore | backup/restore + drill (`apps/desktop/test/backup.test.ts`, `restore.test.ts` · real fs + system `tar`; the SQLite online-backup step enters via the `copyDb` hook — tests exercise the hook, production wires better-sqlite3) | restore drill against a store under load, not a quiescent tmpdir |
| Slot isolation | homes tests (`packages/slots/test/homes.test.ts` · real fs dir creation, **no fixture**); Keychain proofs are manual (3 items, issue #92252) — no automated Keychain test exists | Linux machine bubblewrap check |
| Env scrubbing | env builder exact-allowlist key-set test (`packages/runtime/test/env.test.ts` · **no fixture**); R0 audit spawned a real child through `buildAgentEnv`+`Supervisor` and verified the scrub (docs/STATUS.md) | — |
| Key courier | keystore: 0600, fingerprint, rotate, shred (`packages/slots/test/keystore.test.ts` · real fs, **no fixture**) | Slots UI form |
| Login serialisation | `LoginCardManager` serialisation, timeout, cancel, live-only stream (`apps/desktop/test/login-cards.test.ts` · **injected `FakePty` via the `ptySpawn` seam, no fixture** — node-pty is not a dependency of any package in this repo) | terminal cards on a real node-pty — deferred with B2 UI |
| Quota classification | per-engine fixtures (`stream-conformance.test.ts` · **real fixture** Claude; `codex.test.ts`/`opencode.test.ts` · **synthetic fixture** incl. Gemini `RetryInfo`-shaped 429 as inline unit data in `classifyOpencodeError` — no provider fixture library exists) | real provider 429 bodies (`providers/<provider>/` fixtures do not exist yet) |
| Pre-flight exclusion | scheduler `slot_unhealthy` deferral (`packages/domain/test/scheduling.test.ts` · **no fixture**) | — |
| Repo config hazards | manual proof (repo `opencode.json` dials MCP; disable var stops it); runtime `opencodeSlotEnv` always sets the var for untrusted repos (`packages/runtime/test/opencode-env.test.ts` · **no fixture**) | — |
| Sandbox profile | isolation settings builder (`packages/runtime/test/isolation.test.ts` · **no fixture**; asserts the settings JSON only — no test executes a process inside the sandbox) | Linux sandbox dependency check in `mec doctor`; a real sandboxed-execution proof on both OSes |
| Shims and gitconfig | shims manifest/tamper/foreign-file tests (`packages/runtime/test/shims.test.ts` · real fs, executes the real shim scripts, **no fixture**) | — |
| Platform-tool fencing | mec-tools stale generation → empty set; specialist cannot call `propose_plan` (`packages/mec-tools/test/server.test.ts` over real loopback HTTP, `tokens.test.ts` · **no fixture**) | — |
| Compliance guard | slots `scanSourceForViolations` + tests (`packages/slots/test/compliance.test.ts`) + self-scan over the product source in CI (`compliance-self.test.ts`) — **no fixture**; R0 audit planted a `readFileSync('.claude/.credentials.json')` line into `probe.ts` on a throwaway branch and the self-scan failed as required (docs/STATUS.md) | — (note: an aliased import — `readFileSync as x` two lines from the path — evaded the scanner; within its documented heuristic limits) |
| Capability drift | probe `flags_verified` from `--help` (`packages/engines/test/argv-classify-probe.test.ts` · injected `run`, **no fixture**); runtime `checkDrift` lost flag → `engine_unsupported` (`packages/runtime/test/drift.test.ts` · **no fixture**) | composition: degrade the slot before any attempt starts |
| Secrets in chat | — | server redact-before-durability + Slots pointer reply |
| Acknowledgement | acks: one per message id, first-text-final (`packages/meta/test/acks.test.ts` · **no fixture**) | — |
| Follow-up ownership | routing binds by reference only (`packages/meta/test/routing.test.ts`); hand-back once, never back (`packages/meta/test/handback.test.ts`) — **no fixture** | release-at-end to intake |
| Hold | — | hold model + persistence across restart |
| Stage table | domain state machines (`packages/domain/test/states.test.ts`); STAGE_TABLE first-match (`packages/domain/test/stages.test.ts` · inline state fixtures, **no engine fixture**) | the first-match stage projection table wired to store facts |
| Wake vs note | meta classifier: 22 cases incl. self-action → note (`packages/meta/test/wakes.test.ts` · **no fixture**) | — |
| Effects queue | store: coalescing, Later, ordered hold, backoff, health 3-strike (`packages/store/test/effects.test.ts` · **real SQLite store**) | — |
| Reserved wake slot | scheduling: last free unit deferred (`packages/domain/test/scheduling.test.ts` · **no fixture**) | — |
| Pause | — | no-launch/deliver/relay during pause; deadlines shift |
| Model surface | prompts compile budgets (`packages/prompts/test/bundles.test.ts` · **no fixture**) | per-role size budget tests |
| Yield to duplicate | integration: strict superset → dropped (`packages/integration/test/yield.test.ts` · inline branch sets, **no fixture**) | `gh` wiring at PR time |

## The gap list, as work items

1. Receipt ladder (received/delivered/read/handled/settled) + mandate ops + hold — one domain slice.
2. Stage projection table (first match) — domain slice.
3. Runtime wiring: park-on-rejected, journal pre-append redaction, opencode disable var, capability drift → degraded — composition slice.
4. Server pieces: idempotency 409, secrets-in-chat guard, pause — with the landing server agent. The `expectedInputSha` route bug (R0 audit issue #5) is fixed and tested.
5. Login terminal cards (node-pty) — B2 UI slice.
6. Compliance self-scan test in CI.
7. Slot failover orchestration.
8. Real fixtures for Codex and OpenCode — every engine row above that cites a synthetic fixture stays "unproven on real recordings" until the handshakes land (R1/R2 work), and the `providers/<provider>/` 429 bodies from CONTRACTS §9 do not exist.
