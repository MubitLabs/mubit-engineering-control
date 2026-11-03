# §26 verification matrix — evidence and gaps

Every row of plan §26, what proves it today, and what remains. Written 3 Nov (single-operator day 1 evening); update as gaps close.

| §26 row | Evidence today | Gap |
| --- | --- | --- |
| Quota park | `engines` fixtures: codex/opencode `rate_limit_rejected` parse+classify; claude `rate_limit` fan-out conformance | runtime wiring that parks an attempt from a rejected event (composition) |
| Slot failover | — | handoff orchestration across slots (same worktree, new attempt, recorded handoff) |
| Auth expiry | slots probes (degraded `auth_expired`); scheduler defers `slot_unhealthy` | re-login card + auto-resume after healthy probe |
| Confirmation race | policy CAS: double resolve throws `already_handled` | server 409 path (server agent in flight) |
| Stale confirmation | policy: opHash/inputSha mismatch → `stale`; expiry never consent | — |
| Meta-agent authority | mec-tools role fencing; escalation counter; no tool touches policy/prompts | four-invalid-proposal escalation wired to a real turn loop |
| Duplicate input | acks idempotent per message id; journal dedupe by seq | server `x-idempotency-key` path (in flight) |
| Crash between delivered/read | — | the full receipt ladder model (received→delivered→read→handled→settled) — only acks+handback exist |
| Restart mid-attempt | journal replay tests (torn line, ack cursor, reopen) | composition-level replay into store facts |
| Human stop | routing `stopped_refused` | mandate withdraw/revalidate ops |
| Parallel branches | git worktrees + clean-merge tests (two parents, exact SHA) | — |
| Integration conflict | mid-merge repair: both sides, parentCount 2, checks on repaired SHA | queue wiring to create the repair task |
| Prompt upgrade | prompts: identical-to-default removed, stale base → draft preserved | Default-updated UI flow |
| Redaction | secrets lint (schema fields); slots redaction patterns; doctor by-construction | journal pre-append redaction filter wiring |
| Restore | backup/restore + drill (agent in flight) | — |
| Slot isolation | pre-flight Keychain proofs (3 items, issue #92252); homes tests | Linux machine bubblewrap check |
| Env scrubbing | env builder: exact-allowlist key-set test | — |
| Key courier | keystore: 0600, fingerprint, rotate, shred | Slots UI form |
| Login serialisation | — | terminal cards (node-pty) — deferred with B2 UI |
| Quota classification | per-engine fixtures incl. Gemini RetryInfo shape | — |
| Pre-flight exclusion | scheduler `slot_unhealthy` deferral | — |
| Repo config hazards | manual proof: repo `opencode.json` dials MCP even from `auth list`; disable var stops it | env builder must ADD `OPENCODE_DISABLE_PROJECT_CONFIG=1` for opencode slots |
| Sandbox profile | isolation settings builder + macOS Seatbelt implicit | Linux sandbox dependency check in `mec doctor` |
| Shims and gitconfig | shims manifest/tamper/foreign-file tests | — |
| Platform-tool fencing | mec-tools stale generation → empty set; specialist cannot call `propose_plan` | — |
| Compliance guard | slots `scanSourceForViolations` + tests + **self-scan over the product source in CI** (compliance-self.test.ts) | — |
| Capability drift | probe `flags_verified` from `--help` | drift → `engine_unsupported` degradation wiring |
| Secrets in chat | — | server redact-before-durability + Slots pointer reply |
| Acknowledgement | acks: one per message id, first-text-final | — |
| Follow-up ownership | routing binds by reference only; hand-back once, never back | release-at-end to intake |
| Hold | — | hold model + persistence across restart |
| Stage table | domain state machines | the first-match stage projection table |
| Wake vs note | meta classifier: 22 cases incl. self-action → note | — |
| Effects queue | store: coalescing, Later, ordered hold, backoff, health 3-strike | — |
| Reserved wake slot | scheduling: last free unit deferred | — |
| Pause | — | no-launch/deliver/relay during pause; deadlines shift |
| Model surface | prompts compile budgets | per-role size budget tests |
| Yield to duplicate | integration: strict superset → dropped | `gh` wiring at PR time |

## The gap list, as work items

1. Receipt ladder (received/delivered/read/handled/settled) + mandate ops + hold — one domain slice.
2. Stage projection table (first match) — domain slice.
3. Runtime wiring: park-on-rejected, journal pre-append redaction, opencode disable var, capability drift → degraded — composition slice.
4. Server pieces: idempotency 409, secrets-in-chat guard, pause — with the landing server agent.
5. Login terminal cards (node-pty) — B2 UI slice.
6. Compliance self-scan test in CI.
7. Slot failover orchestration.
