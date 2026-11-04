# Threat model — MEC v4.1 (R2.7 security review)

Written 3 Nov 2026 against the working tree (branch `main`). Scope: the six threats the
implementation plan names in §7.4, plus the three surfaces this review adds (native-module
supply chain, the mec-tools MCP loopback server, the SSE/chat HTTP surface) and the two
live checks §7.4 demands (`pnpm audit`, planted-violation coverage of the compliance
guard). Method: for every control, the test that proves it is cited by file and case name,
and every case name was verified present by `grep -rn` on this tree — a control with no
test is listed as a **GAP**, not papered over. Residual risk is stated in one honest
sentence per threat. Plan references are `docs/plan/spec.md` (§
numbers), the implementation plan is `docs/plan/product-plan.md`, and
`docs/fault-suite.md` is the §26 evidence matrix this document closes against.

---

## 1. A malicious repository

**The attack.** A cloned repository carries files engines treat as configuration and act
on in headless runs: `.claude/settings.json` (hooks run commands; `env` and
`apiKeyHelper` change credentials), `.mcp.json` (spawns servers), `.codex/` (config,
hooks, MCP — loaded only for trusted projects), `opencode.json` and
`.opencode/plugins/*.ts` (plugins execute; MCP servers connect), and `AGENTS.md` /
`CLAUDE.md` instructions.

**Controls in the spec.** §22 "repository-resident configuration is untrusted": Claude
runs with `--setting-sources user` and `--strict-mcp-config` and `disableAllHooks` in
`--settings`; Codex grants no project trust; OpenCode runs with
`OPENCODE_DISABLE_PROJECT_CONFIG=1` for untrusted repos; instruction files are treated as
data; a repo may be marked trusted explicitly. §8.4 carries the per-engine detail.

**Tests that prove them.**

| Control | Where | Test (verified) |
| --- | --- | --- |
| Claude launch flags (`--setting-sources user`, `--strict-mcp-config`) | `packages/engines/src/claude/argv.ts:43-47` | `packages/engines/test/argv-classify-probe.test.ts` — *implements mode: headless stream-json with settings, strict mcp and the bridge* (asserts both flags) |
| Hooks always disabled in the trusted `--settings` scope | `packages/runtime/src/isolation.ts` (`disableAllHooks: true`) | `packages/runtime/test/isolation.test.ts` — *hooks are always disabled* |
| OpenCode project config never loads for untrusted repos | `packages/runtime/src/opencode-env.ts` | `packages/runtime/test/opencode-env.test.ts` — *an untrusted repository gets OPENCODE_DISABLE_PROJECT_CONFIG=1 and nothing else* |
| Repo config cannot smuggle a sandbox bypass | `packages/runtime/src/isolation.ts` (settings file is a trusted scope; `allowUnsandboxedCommands: false`) | `packages/runtime/test/isolation.test.ts` — *sandbox required: enabled, failIfUnavailable, strict allowlist* |

**Gaps.** Codex project-trust refusal is spec'd (§8.4 "worktrees are never marked
trusted") but has no enforcing code path or test — the adapter's slot layer comment says
CODEX_HOME "until it lands, the ambient env is used" (`packages/engines/src/codex/adapter.ts:51`).
Instruction-files-as-data (§22) is bundle-convention work, unlanded and untested. The
explicit trusted-repo marking (and the trust-gated loading it permits) has no UI and no
test. `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (§8.4) is named in the plan but appears in no
code or test.

**Residual risk.** For Claude and OpenCode the launch-time switches are proven; for
Codex and instruction files the guarantee is still a paragraph in the plan, and any
repository a future UI lets the user mark trusted loads its config by design.

---

## 2. A compromised engine process

**The attack.** The engine process itself turns hostile: reads its own credential file,
reaches into other slots' homes, opens `~/.mec/db`, exfiltrates through the environment,
or tries to spawn sibling agents.

**Controls in the spec.** §5.12 environment construction (exact inherited allowlist —
the allowlist *is* the scrub); §8.3 shims and attempt gitconfig (blocked commands fail
by name; tampered or foreign files refuse the attempt); §8.4 sandbox profiles (read-denied
`~/.mec` state, other slot homes, `~/.ssh`, `~/.aws`, `~/.config/gh`; writes confined to
worktree + temp; network strictly allowlisted); §6/§8.6 attempt-scoped mec-tools tokens
with role and generation fencing; §5.4 keystores mode 0600.

**Tests that prove them.**

| Control | Where | Test (verified) |
| --- | --- | --- |
| Env allowlist scrub (no KEY/TOKEN/SECRET/KEY/PASSWORD name survives) | `packages/runtime/src/env.ts` | `packages/runtime/test/env.test.ts` — *matches the allowlist exactly: survivors + HOME + slot/attempt keys (§26 env-scrubbing)*; also proven live on a real child process by the R0 audit (`docs/STATUS.md` §3) |
| Read-denies cover MEC state, other slot homes, secret dirs | `packages/runtime/src/isolation.ts` (`defaultDenyRead`) | `packages/runtime/test/isolation.test.ts` — *covers MEC state, other slot homes and secret directories* |
| Blocked commands fail by name; tamper/foreign-file refusal | `packages/runtime/src/shims.ts` | `packages/runtime/test/shims.test.ts` — *a blocked command fails by name with a one-line reason and exit 127*, *refuses a tampered script (hash mismatch)*, *refuses a foreign file inside binDir* |
| Keystore file is 0600, fingerprint-only exposure | `packages/slots/src/keystore.ts` | `packages/slots/test/keystore.test.ts` — *store writes the file 0600 and returns a fingerprint (provider, last4, 64 hex)* |
| A hostile process cannot reach other attempts' tools | `packages/mec-tools/src/server.ts`, `tokens.ts` | `packages/mec-tools/test/server.test.ts` — *a stale generation sees an empty tools/list and a call error; a fresh token still works*, *tools/call refuses a tool the role does not have and runs one it does* |

**Gaps.** No test executes a process inside the sandbox — `isolation.test.ts` asserts the
settings JSON only (`docs/fault-suite.md` says so in its own words: "no test executes a
process inside the sandbox"). The journal pre-append redaction filter
(`packages/runtime/src/redact-events.ts`) is unit-proven but wired into no production
call site — `grep redactEvent` outside tests finds only its definition and export.

**Residual risk.** §8.3's own words: "shims and environment are defaults, not a security
boundary — a process can run a binary by absolute path; the OS-level boundary is the
engine sandbox", and nothing yet proves by execution that a sandboxed attempt cannot read
`~/.mec/db`.

---

## 3. A leaked diagnostics bundle

**The attack.** A `mec doctor` bundle (or a journal/events file that travels with a bug
report) is pasted into a public issue; it contains a credential.

**Controls in the spec.** §21.6 diagnostics are "redacted before durability"; §5.4 and
§22: redaction before durability everywhere; fingerprints, never keys, in the database;
§26 Redaction row (no credential string in journal, events, artifacts, logs, chat,
scorecards).

**Tests that prove them.**

| Control | Where | Test (verified) |
| --- | --- | --- |
| Doctor skips secret-named env vars outright | `apps/desktop/src/doctor.ts` | `apps/desktop/test/doctor.test.ts` — *skips secret variable names entirely* |
| Doctor masks key-shaped values under benign names | `apps/desktop/src/doctor.ts` | `apps/desktop/test/doctor.test.ts` — *redacts key-shaped values under allowlisted names like PATH* |
| Doctor redacts a secret-bearing health snapshot | `apps/desktop/src/doctor.ts` | `apps/desktop/test/doctor.test.ts` — *redacts secrets embedded in the health snapshot text* |
| Known key shapes replaced at any nesting depth | `packages/slots/src/redaction.ts`, `packages/runtime/src/redact-events.ts` | `packages/slots/test/redaction.test.ts` — *replaces a known key shape with [redacted:\<name\>]*; `packages/runtime/test/redact-events.test.ts` — *redacts inside nested raw fields, not just top-level strings* |
| Unpatterned key material caught by last-four sweep | `packages/slots/src/redaction.ts` | `packages/slots/test/redaction.test.ts` — *the last-four sweep catches key material from a fingerprint alone (one-way hash, no exacts)* |
| No secret-bearing field survives schema lint | `packages/contracts` secret-field lint | `packages/contracts/test/secret-fields.test.ts` (suite-level; case names are per-field) |

**Gaps.** The journal write path does not yet call the filter (§2's gap); the R0 audit
also watched an over-long GLM-shaped string pass all patterns and the last-four sweep
(`docs/STATUS.md` §4).

**Residual risk.** Redaction is exactly as wide as the known key patterns plus
fingerprint last-fours — a secret in a shape nobody fingerprinted ships in the bundle.

---

## 4. A pasted key in chat

**The attack.** The user pastes an API key into the chat box instead of the Slots panel;
the key becomes durable in messages, events or logs.

**Controls in the spec.** §26 "Secrets in chat": a message containing a key-shaped string
is stored redacted and answered with the Slots pointer; §5.4/§5.7: a key's only entry
door is the courier, which writes the keystore (0600) and the store's fingerprint only.

**Tests that prove them.**

| Control | Where | Test (verified) |
| --- | --- | --- |
| The courier is the only door; key lands in keystore and nowhere else (real SQLite + real fs) | `apps/desktop/src/server.ts` (`POST /api/slots/api-key`) | `apps/desktop/test/api-slots.test.ts` — *couriers a pasted key into the slot keystore and NOWHERE else* |
| Non-matching key / escaping label write nothing | `apps/desktop/src/server.ts` | `apps/desktop/test/api-slots.test.ts` — *rejects a non-anthropic key (and an escaping label) with 400, writing nothing* |
| Slot listing exposes fingerprints only | `apps/desktop/src/server.ts` | `apps/desktop/test/api-slots.test.ts` — *GET /api/slots lists slot docs as fingerprints only* |

**CLOSED (post-review fix).** The chat-route guard (`apps/desktop/src/server.ts`:
`matchesSecret` → store the redacted text, set `secretGuard`, answer with the Slots
pointer) is now tested at the route level: `apps/desktop/test/security-surface.test.ts`
— *a key-shaped message is stored redacted, answered with the Slots pointer, and the raw
key never persists* (asserts `secretGuard: true`, the Slots pointer in the answer, and
that the raw key appears nowhere in `GET /api/chat/messages`). Issue #8.

**Residual risk.** The guard only recognises the known key shapes — an unpatterned key
pasted in chat is stored verbatim today.

---

## 5. A stale confirmation replayed

**The attack.** An old approval is replayed against changed work: the plan changed, the
repo input SHA changed, or the card expired — or two answers race.

**Controls in the spec.** §13: resolution is compare-and-set; a record binds operation
hash, input SHA (when repo-related), mandate and expiry; the first answer wins; changed
operation or input is `stale`; expiry is a policy resolution and never consent.

**Tests that prove them.**

| Control | Where | Test (verified) |
| --- | --- | --- |
| First answer wins; no second resolution | `packages/policy/src/confirmations.ts` | `packages/policy/test/confirmations.test.ts` — *throws already_handled when anything is resolved twice (first answer wins)* |
| Expiry is never consent (even a late approve expires) | `packages/policy/src/confirmations.ts` | `packages/policy/test/confirmations.test.ts` — *expires an approve that arrives late — expiry is never consent (§13)* |
| Changed operation → stale | `packages/policy/src/confirmations.ts` | `packages/policy/test/confirmations.test.ts` — *goes stale on an operation hash mismatch — the question changed* |
| Changed repo input → stale | `packages/policy/src/confirmations.ts` | `packages/policy/test/confirmations.test.ts` — *goes stale on an inputSha mismatch when the record carries one* |
| The HTTP route resolves exactly once and binds to the card's input | `apps/desktop/src/server.ts` (`/api/inbox/:id/resolve`) | `apps/desktop/test/server.test.ts` — *lists pending confirmations as inbox cards and resolves an approve exactly once*, and describe *inbox resolve binds to the card input (audit #5)* → *approves a repo-bound confirmation carrying an inputSha* |

Note: the R0 audit's route bug (the route never forwarded `expectedInputSha`, so
inputSha-bound confirmations resolved `stale` over HTTP) is **fixed** — the route now
sends the card's own value (`apps/desktop/src/server.ts:393`) and the audit-#5 test
covers it. `docs/fault-suite.md`'s Confirmation-race row still describes the bug; that
row is stale, not the code.

**Residual risk.** The route binds the answer to the record's own hash and SHA — i.e. to
what the card rendered — so an attacker who controls what the user saw (a poisoned UI)
is outside this model, and the release routes' `gh` call is not transactional with the
card settle (a crash between settle and `gh` leaves an approved card and no PR).

---

## 6. A second MEC process

**The attack.** A second `mec server` (double-launch, stale terminal, cron) opens the
same data directory and writes the same SQLite store / effects queue concurrently.

**Controls in the spec.** §17/§21: one process owns the data directory; the composition
root acquires a directory lock before opening the store
(`apps/desktop/src/composition.ts:52`, `DirLock.acquire`).

**Tests that prove them.**

| Control | Where | Test (verified) |
| --- | --- | --- |
| A held directory refuses a second acquire | `packages/store/src` (`DirLock`) | `packages/store/test/lock.test.ts` — *a second acquire on a held directory is refused* |
| A live pid's lock is not treated as stale | `packages/store/src` | `packages/store/test/lock.test.ts` — *a lockfile naming a live pid is not stale* |
| An unreadable lockfile fails closed | `packages/store/src` | `packages/store/test/lock.test.ts` — *a lockfile with unreadable content cannot be proven stale, so it is treated as held* |
| Composed server releases the lock on close (restart works) | `apps/desktop/src/composition.ts` | `apps/desktop/test/composition.test.ts` — *serves status, writes health.json and releases the lock on close* |

The R0 audit also proved it live: a real second process against the same data dir exits 1
with "another process owns …" (`docs/STATUS.md` §7).

**Residual risk.** The lock serialises processes that agree to take it — two processes
pointed at *different* data dirs still share one machine's `~/.mec` engines tree and one
`gh`, and a non-MEC writer to the SQLite file (a user with a sqlite shell) is
uncoordinated.

---

## 7. Native-module supply chain (better-sqlite3, node-pty)

**The attack.** A poisoned npm tarball or prebuilt binary for a native dependency ships
code that runs at install time (postinstall) or at first `require`.

**Controls.**
- Exact lockfile pins: `better-sqlite3@12.11.1`, `node-pty@1.1.0` (`pnpm-lock.yaml`); specifiers are `^12.0.0` / `^1.1.0`, so the lockfile is the pin — installs are reproducible only with `--frozen-lockfile` CI discipline.
- Postinstall allowlist: root `package.json` `pnpm.onlyBuiltDependencies: [better-sqlite3, esbuild, node-pty]` — no other package's build scripts execute; a new native dependency fails closed (pnpm refuses to run its scripts) until listed.
- Provenance evidence: the R0 audit loaded the real `better_sqlite3.node` (prebuild-install path) and ran the store tests on it (`docs/STATUS.md` §2); node-pty's real binary is driven by `apps/desktop/test/login-cards.test.ts` — *drives a real interactive shell through the seam (no vendor command)*.
- `pnpm audit --prod` on this tree, 3 Nov 2026: **"No known vulnerabilities found"** (exit 0). Recorded verbatim per §7.4; nothing was fixed silently — there was nothing to fix.

**Gaps.** No allowlist/integrity pin of *where* prebuilds may come from (no
`--prefer-offline`/checksum policy beyond pnpm's lockfile integrity hashes); no automated
`pnpm audit` gate in CI.

**Residual risk.** Registry or prebuild-CDN compromise bypasses everything here — pnpm's
integrity hashes bind to the tarball npm serves, and onlyBuiltDependencies gates build
scripts, not what the registry ships.

---

## 8. The MCP loopback server (mec-tools)

**The attack.** A local process (or a compromised sibling attempt) calls the mec-tools
MCP server directly: without a token, with a forged token, with a stale-generation token,
or asking for a role's tools.

**Controls.** The server binds `127.0.0.1` on an ephemeral port
(`packages/mec-tools/src/server.ts:106-117`); every request authenticates a bearer token
(HMAC-SHA256, timing-safe compare — `tokens.ts:45-68`); the tool set is fenced by role
and by generation (`server.ts:232-276`); the signing secret is per-process
(`randomBytes(32)`, `composition.ts:120`); body size capped at 1 MiB.

**Tests (all over real loopback HTTP).**

| Control | Test (verified) |
| --- | --- |
| No/failed token → 401 | `packages/mec-tools/test/server.test.ts` — *a token that fails verification is a 401* |
| Forged/tampered tokens never verify | `packages/mec-tools/test/tokens.test.ts` — *returns null for a token signed with a different secret*, *returns null for a tampered payload or a tampered signature* |
| Stale generation fenced to empty set | `packages/mec-tools/test/server.test.ts` — *a stale generation sees an empty tools/list and a call error; a fresh token still works* |
| Role fencing | `packages/mec-tools/test/server.test.ts` — *tools/list exposes only the role’s tools, mapped onto TOOL_SPECS*, *tools/call refuses a tool the role does not have and runs one it does* |

**The 401 question, answered.** Yes — any local process *without* a token is refused
(the 401 test above); a local process *with* a valid attempt token is exactly the design
case: tokens are deliberately placed in the attempt environment (`MEC_TOOLS_TOKEN`,
the one sanctioned secret in `packages/runtime/src/env.ts:58`), so a compromised engine
can always call *its own* attempt's tools — the fence is role and generation, not process
identity.

**Residual risk.** The transport is plaintext HTTP over loopback (no TLS), so a local
eavesdropper on `lo0` could read a token in flight, and any process that reads another
attempt's environment owns that attempt's tool surface.

---

## 9. The SSE/chat surface (composition server) — what is actually enforced

**The attack.** A website in the user's browser (CSRF/DNS-rebinding) or any local
process reaches the workbench server: posts chat, resolves confirmations, reads the SSE
event stream.

**What `server.ts` actually enforces — the truth, re-checked after the fix (issue #7).**
`buildServer` (`apps/desktop/src/server.ts`) now carries §22's full sentence as an
`onRequest` hook ahead of every route: **(1) origin rejection** — any request carrying an
`Origin` must name a loopback host (`localhost`/`127.0.0.1`/`::1`; opaque `null` origins
are rejected too), else 403 before any route runs — this covers browser reads, the
"simple-request" POST that CORS response blocking would NOT have stopped, and
DNS-rebinding (the rebound origin still says the attacker's host); **(2) the custom
header** — any browser-shaped mutation (`Origin`/`Sec-Fetch-*`/`Referer` present) must
carry `x-mec-client: 1` — the header the workbench's `request()` wrapper
(`apps/web/src/api.ts`) sends on every call — which a cross-origin page cannot add
without a preflight this server never answers; local non-browser clients (the CLI,
tests, the engine-side MCP client whose `/mcp` route keeps its token fence) carry no
browser headers and are unaffected. Loopback bind remains (`composition.ts`,
`app.listen({ port: 0, host: '127.0.0.1' })`).

**Tests that prove the surface's access control.**

| Control | Test (verified) |
| --- | --- |
| Leg 1: mutation from `https://evil.com` → 403, nothing stored | `apps/desktop/test/security-surface.test.ts` — *a mutation from https://evil.com is 403 and nothing is stored* |
| Leg 1: read from `https://evil.com` → 403 (CORS response blocking is not execution blocking) | `apps/desktop/test/security-surface.test.ts` — *a read from https://evil.com is 403 too (CORS response blocking is not execution blocking)* |
| Leg 1: opaque `null` origin rejected | `apps/desktop/test/security-surface.test.ts` — *an opaque 'null' origin is rejected with the remote ones* |
| Leg 1: loopback origin allowed on reads (EventSource parity) | `apps/desktop/test/security-surface.test.ts` — *a loopback origin (the workbench, or its dev proxy) is allowed on reads — EventSource parity* |
| Leg 2: loopback-origin POST without the header → 403 (another local page cannot post as the user) | `apps/desktop/test/security-surface.test.ts` — *a loopback-origin POST without the header is 403 (another local page cannot post as the user)* |
| Leg 2: the same POST with `x-mec-client` accepted | `apps/desktop/test/security-surface.test.ts` — *the same POST with x-mec-client is accepted (the workbench request() wrapper)* |
| Leg 2: `Sec-Fetch-Site`-only (no Origin) cross-site mutation fenced | `apps/desktop/test/security-surface.test.ts` — *a cross-site fetch that omits Origin but carries Sec-Fetch-Site is still fenced* |
| Local non-browser clients unchanged | `apps/desktop/test/security-surface.test.ts` — *a local non-browser client (the CLI, tests, the engine MCP client) posts unchanged* |

The SSE/chat/login behavioural tests listed in the original review (streaming shapes,
idempotency, live-only login streams, serialised logins) are unchanged and still pass.

**Residual risk.** A local *non-browser* process remains able to talk to the server once
it knows the port — that is the accepted v1 posture (§22 scopes the discipline to the
browser surface; the port is printed to stdout for the user, and the privileged `/mcp`
route keeps its attempt-scoped token). Fingerprinting beyond loopback+port (a
server-shared secret the CLI and UI would carry) is a deliberate non-goal for v0.

---

## 10. Compliance-guard coverage — planted-violation check (live, 3 Nov 2026)

§7.4 requires the guard's coverage "checked by planting violations". Done, in a scratch
copy outside the repo (`/tmp/mec-guard-check`), running the **real**
`scanSourceForViolations` imported from the repo's package
(`packages/slots/src/compliance.ts` — the package ships source, no dist; the module is
import-free so Node 25's type-stripping runs it directly). Three planted violations plus
one positive control:

| Planted file | Shape | Result |
| --- | --- | --- |
| `positive-control.js` | direct `readFileSync(join(home, '.claude/.credentials.json'))` | **CAUGHT** (line 6, pattern `\.credentials\.json`) — the harness works |
| `aliased.js` | `import { readFileSync as x }`, used 5 lines below on the forbidden path | **EVADED** — the alias leaves no read marker within the scanner's ±1-line window |
| `template-literal.js` | `` readFileSync(`${home}/.claude/.credentials${suffix}`) `` with `suffix = '.json'` | **EVADED** — `.credentials.json` never appears literally, so the path pattern never matches |
| `keystore-require.js` | `` require('node:fs').readFileSync(`${root}/engines/${slot}/keys/${provider}.key`) `` | **EVADED** — `\..mec\/engines\/[^/]+\/keys\/` matches no assembled path, and `require` is not a read marker |

**Verdict, honestly.** The guard catches the careless form (the direct, same-line read —
as `packages/slots/test/compliance.test.ts` proves and the R0 audit reproduced on a
throwaway branch) and **all three deliberate evasions pass it**: aliasing, template-literal
assembly, and dynamic-path construction. This matches the module's own doc ("a
tripwire… not sound against deliberate obfuscation") and the R0 auditor's alias note —
the template-literal and dynamic-require evasions are confirmed here for the first time.
The self-scan over product source stays valuable as a regression tripwire (it caught the
R0 plant); it is not a control against an adversary inside the repo.

**Follow-up.** Issue filed: **#6** — "compliance guard: aliasing and template-literal
evasion" (MubitLabs/mubit-engineering-control), with the three samples and a proposal
(AST-based scan, or a standing review-checklist item).

**Residual risk.** Any contributor or compromised agent can defeat the guard with
two lines of indirection; the real custody rule (§22 "no code path opens these stores")
has no executable enforcer beyond review.

---

## 11. Dependency audit — recorded per §7.4

`pnpm audit --prod`, run 3 Nov 2026 on this tree: **"No known vulnerabilities found"**,
exit 0. Recorded verbatim; no findings, so nothing to fix and no issues to file. (A
`--prod`-only scan misses dev-chain advisories by design; the full `pnpm audit` also ran
clean on this date.)

---

## Gap register (controls named above with no test, or no control at all)

| # | Gap | Where it bites | Severity |
| --- | --- | --- | --- |
| 1 | ~~§22 CSRF discipline (origin rejection + custom header) not implemented on the composition server~~ **CLOSED 3 Nov 2026**: `onRequest` hook in `buildServer` + 8 tests in `apps/desktop/test/security-surface.test.ts` (issue #7) — see §9 | §9 — browsers and local processes reach every route | ~~High~~ |
| 2 | ~~Secrets-in-chat route guard has no test~~ **CLOSED 3 Nov 2026**: `apps/desktop/test/security-surface.test.ts` — *a key-shaped message is stored redacted…* (issue #8) — see §4 | §4 — silent regression would store keys | ~~High~~ |
| 3 | No test executes a process inside the sandbox; Linux sandbox path absent | §2 — the OS boundary is asserted-as-JSON only | High |
| 4 | Codex project-trust refusal, instruction-files-as-data, trusted-repo marking: no code, no tests | §1 — Codex + `AGENTS.md` surfaces unguarded | Medium |
| 5 | Journal pre-append redaction filter unwired in production | §3 — first durable stop unfiltered | Medium |
| 6 | Compliance guard evades under aliasing/template-literals/dynamic paths | §10 — tripwire only | Medium (issue #6) |
| 7 | No automated `pnpm audit` CI gate; no prebuild-provenance policy | §7 — supply chain | Low |
| 8 | ~~`docs/fault-suite.md` Confirmation-race row still describes the fixed `expectedInputSha` bug~~ **CLOSED 3 Nov 2026**: rows corrected to fixed+tested | §5 — doc drift | ~~Low~~ |

Every citation above was verified by `grep -rn` against this tree on 3 Nov 2026.
