# STATUS — what is verified, what runs on fakes, what is absent

Written by the R0 audit reviewer (3 Nov 2026), on a cold clone (`mec-audit-r0`, commit `804f0a3`, tag `contracts-v0` identical to HEAD for `packages/contracts`), macOS arm64, Node 25.8.2, pnpm 10.34.9. This file restates the 3 Nov report's claims as what an independent party actually reproduced. Evidence commands and outputs are quoted; the audit scripts lived in a scratch directory and were discarded.

## VERIFIED — reproduced by this audit, on this machine

1. **`pnpm install` + `pnpm check` green.** `pnpm check` = `pnpm typecheck && pnpm lint && pnpm test`, exit code 0. Typecheck: 17 workspace projects, all done. Lint (biome): "Checked 264 files … Found 7 warnings. Found 1 info." — warnings only (unused imports/params, one useless ternary, one broken symlink under `packages/contracts/contracts`); lint does not fail CI. Tests: `Test Files 104 passed | 1 skipped (105)`, `Tests 1360 passed | 1 skipped (1361)`. The one skipped file is `apps/desktop/test/bundle.test.ts` (`hasBundle ? it : it.skip` — it ran in this audit once the bundle was built). Linux: CI ran green on the repo's self-hosted Linux runners (partial evidence); the manual cold-clone Linux run is still pending for the other machine's operator.
2. **`better-sqlite3` native module loads and works.** Run from `packages/store`: `node -e "const m = require('better-sqlite3'); …"` → `better-sqlite3 OK: {"x":42}`; installed version 12.11.1 with a real `build/Release/better_sqlite3.node` (prebuild-install path; `pnpm.onlyBuiltDependencies` lists it). The SQLite-backed store/queue tests in `pnpm check` exercise the real binding.
3. **Env scrub, real child process.** Real `buildAgentEnv` (`packages/runtime/src/env.ts`) + real `Supervisor.spawn` (`packages/runtime/src/supervisor.ts`, detached, argv-only). Parent shell carried `ANTHROPIC_API_KEY=sk-ant-test…`, `GITHUB_TOKEN=gh-test…`, `OPENAI_API_KEY=sk-proj-test…`, `GEMINI_API_KEY=AIza…`, `MY_DB_PASSWORD`, `VENDOR_SECRET`, `CUSTOM_FOO_TOKEN`. Child env keys: `["CLAUDE_CONFIG_DIR","HOME","LANG","MEC_ATTEMPT_ID","MEC_TASK_ID","NO_PROXY","PATH","SSH_AUTH_SOCK","TERM","TMPDIR","USER","__CF_USER_TEXT_ENCODING","no_proxy"]` — leaked secret values `[]`, secret-named vars `[]`, `HOME` = the slot home. (`__CF_USER_TEXT_ENCODING` is added by macOS itself when spawning, not by MEC.)
4. **Redaction catches every provider key shape.** Real `redact()` (`packages/slots/src/redaction.ts`) and real `redactEvent()` (`packages/runtime/src/redact-events.ts`): `sk-ant-api03-…` → `[redacted:anthropic]`, `sk-proj-…` → `[redacted:openai]`, `AIza…35` → `[redacted:google-gemini]`, `32hex.16alnum` (GLM) → `[redacted:zai-coding-plan]`, `ghp_…` → `[redacted:github]`; both keys in one string caught; nested `raw` fields redacted while numbers/structure survive. Observation: an over-long Z.ai-shaped string (64 hex before the dot) is not pattern-matched, and without a fingerprint the last-four sweep cannot catch it — acceptable (not a real key shape) but worth knowing.
5. **Compliance guard fails on a planted violation.** On a throwaway branch, `const _auditPlanted = (): string => readFileSync(join(home, '.claude/.credentials.json'), 'utf8')` planted at the top of `packages/engines/src/claude/probe.ts`; `npx vitest run packages/slots/test/compliance-self.test.ts` → 1 failed, violation `{path: "packages/engines/src/claude/probe.ts", line: 1, pattern: "\\.credentials\\.json"}`. Branch discarded afterwards. Honest limit also verified: an aliased import (`readFileSync as x`, path two lines away) evaded the scanner — the scanner is a tripwire, as its own doc says.
6. **Confirmation CAS, real HTTP.** Real `buildServer` + real `app.listen` on 127.0.0.1, two concurrent `POST /api/inbox/:id/resolve` (Promise.all): exactly one 200 authoritative outcome and one 409 `{"error":"already_handled"}`; the store holds one terminal record. **Bug found and filed (not fixed):** the route forwards `expectedOperationHash` but never `expectedInputSha`, so any inputSha-bound confirmation resolves `stale` over HTTP (`resolvedBy: 'policy'`) even when answered in time. Unit tests miss it because they call `resolveConfirmation` directly with matching inputs.
7. **Second process refuses.** `node scripts/bundle-desktop.mjs` → `bundled apps/desktop/dist/mec.mjs (2416565 bytes)`. First `MEC_FAKE_ENGINE=1 MEC_DATA_DIR=<tmp> node apps/desktop/bin/mec.js` → healthy (`mec server listening on http://127.0.0.1:53863`, `/healthz` ok, lockfile records pid). Second process, same data dir → exit 1, `mec: failed to start: mec: another process owns /tmp/mec-audit-lock-…`. First killed afterwards; lock released (the composition test also proves close→restart works).
8. **Git layer runs the real git binary** (`packages/git/test/*` against `file://` remotes: worktrees, two-parent merges, mid-merge repair); **store/effects run on real SQLite**; **mec-tools role fencing runs over real loopback HTTP**. These are not mocked.
9. **Contracts hygiene**: `contracts-v0` == HEAD for `packages/contracts` (no drift since freeze). Schema/lint test suites (secret-field lint, samples coverage, fixtures schema) all green. Drift between the doc and the code is listed in the audit report (report-only items; the two most consequential: CONTRACTS §9's promised artifacts — `conformance.spec.ts`, `providers/<provider>/` bodies, `slots/reserve-race.json`, `mec-devtools record` — do not exist, and `meta.expected` is never asserted against a replay; and `AttemptBrief.tools.url` is constrained to `http://127.0.0.1` in code but not in the doc).

## ON FAKES — synthetic fixtures, fake brain, injectable seams

- **Engine fixtures**: Claude 2.1.317 — 4 recordings, `recorded_by: 'real'` (smoke, auth_expired, max_turns, crash_mid_turn). Codex 0.148.0 and OpenCode 2.2.5 — 4 recordings each, `recorded_by: 'fake'`, synthesised from documented protocols; no real Codex/OpenCode binary ever ran. The fixture library covers 4–6 of the 11 scenarios CONTRACTS §9 requires per engine; no `providers/<provider>/` error bodies exist.
- **FakeEngine** (`packages/testkit/src/fake-engine.ts`) — the fixture-replaying adapter double used anywhere an engine "runs" in tests; it spawns nothing.
- **Fake brain** — the acceptance run described in the 3 Nov report ran on the fake engine with a fake meta agent; `MEC_FAKE_ENGINE=1` is also how this audit's composed server ran. No real meta-agent turn loop exists yet.
- **Injectable seams standing in for real things**: `LoginCardManager`'s `ptySpawn` (tests inject `FakePty`); adapter transports (`post`, `notifications`, `sse`, `versionProbe`, `loginStatus`, `authList` injected in engines tests); probes' `ProbeRun`; backup's `copyDb` hook (tests take the hook; production wires better-sqlite3); fastify `app.inject` instead of sockets in server tests (SSE end-points explicitly branch on `raw.socket instanceof Socket`); `MemoryRepositories` in place of SQLite for server/meta tests; `FakeHealthBoard` doubles.
- **Engine probes (`probeClaude`/Codex/OpenCode probe)** never ran a real engine binary in tests — `--version`/`--help`/auth outputs are injected strings.
- **Sandbox**: the isolation tests assert the settings JSON that would configure a sandbox; no test executes a process under Seatbelt or bubblewrap.

## ABSENT

- **node-pty reality**: `node-pty` is not a dependency of any package in this repo (no package.json lists it; not in the `pnpm.onlyBuiltDependencies` allowlist; not in node_modules). `login-cards.ts` ships an injectable `ptySpawn` seam and a loud default refusal (`pty unavailable: node-pty-prebuilt-multiarch@^1.0.0-beta is not published yet (§21.7)`). The implementation plan's audit-gate line "node-pty … load(s) in a smoke script" cannot hold today — there is nothing to load. Deciding the real dependency (node-pty 1.1.x vs `@homebridge/node-pty-prebuilt-multiarch`) is R1.3 work.
- **Real-binary handshakes (H1–H5)**: none. No slot was created through a real login, no real engine attempt ran, no PR was opened by MEC, no real `rate_limit_event` from a live subscription was replayed outside the recorded fixtures.
- **Real Codex/OpenCode fixtures**: all synthetic (see ON FAKES).
- **Open §26 rows** (no evidence at all): slot failover, crash-between-delivered/read (receipt ladder), secrets-in-chat, hold, pause. Plus the composition-level gaps now relabelled in `docs/fault-suite.md` (park-on-rejected wiring, journal pre-append redaction wiring, drift→degraded wiring, stage projection wiring, slot failover orchestration).
- **Packaging beyond the dev bundle**: `npx` distribution, prebuild matrix, first-run wizard, `mec slot` CLI surface — not started; `apps/desktop/dist/mec.mjs` is a dev bundle only. The unbundled source entry (`node bin/mec.js` without `dist/`) cannot run under stock Node resolution (extensionless TS imports) — the bundle is the working path.
- **Known route bug**: `/api/inbox/:id/resolve` drops `expectedInputSha` (see VERIFIED §6; issue filed).

---

## Update — 3 Nov evening (single operator; R1 completion + R2 wave, commits `9ba065f`..`d824e54`)

The audit above is unchanged as a record. What moved since, against its own three buckets:

**ABSENT → real (with evidence in this repo):**
- **H1** (real-binary canary): `apps/desktop/test/h1.real.test.ts` — real Claude attempt, live rate_limit journal, sandbox denies `~/.ssh`, `mcp__mec__confirm` round-trip, checks on head SHA.
- **H3** (the §23 flow on a real repo): `MubitLabs/mec-sandbox` PR #2 merged behind three user-approved cards, GitHub-confirmed (main `6bd0e35`); record in `docs/log/HANDSHAKES.md`.
- **node-pty**: real `node-pty@1.1.0` drives login cards (R1.3); the §21.7 pin question resolved to it (DECISIONS).
- **Real meta agent**: R1.4 RealClaudeBrain — tool-mediated turns over the in-process MCP server (`MEC_META_SLOT`).
- **R1.5 API-key slots**: courier + keystore custody proven against real SQLite.
- **R1.6**: the §26 composition rows closed — 35/38 proven (`docs/fault-suite.md`).
- **R2.1**: Codex 0.148.0 on a real ChatGPT login (`~/.mec/engines/codex/codex-1`) — smoke/permission/auth_expired fixtures now REAL recordings; gated canary `MEC_REAL_CODEX=1` green. Protocol deltas vs the plan's 0.166 row in `docs/engines.md`.
- **R2.4/R2.5/R2.8**: `mec slot` CLI + internal tarball (`pack:internal`, never publishes); first-run wizard (`#/wizard`, argv-only repository validation); user guide + reference + CONTRIBUTING.
- **R2.1/R2.2 (all three engines real)**: Codex on the ChatGPT login (`d824e54`) and OpenCode on the live GLM/Gemini slots (`f05e7a5`) — real fixtures, live canaries, per-provider zero-token probes; both API-key slots validate healthy through the server.
- **H4 + R2.3 (mixed-engine delivery, both pairings)**: PRs [#3](https://github.com/MubitLabs/mec-sandbox/pull/3)/[#4](https://github.com/MubitLabs/mec-sandbox/pull/4) merged GitHub-confirmed; the Codex reviewer caught a real leak class (`.mec` attempt artifacts in task commits — fixed in `commitAll` with a regression test, proven live in #4's file list); the restore drill ran against the real state dir with every credential excluded by rule.
- **R2.7 security review** (`docs/security/threat-model.md`, all controls cited to grep-verified tests) — and its two High gaps CLOSED same day (§22 origin-rejection + `x-mec-client` hook, secrets-in-chat route test; issues #7/#8). `pnpm audit --prod` clean. Honest residual: the compliance guard is a tripwire, not a boundary (issue #6, three planted evasions).

**ON FAKES → honest where they remain:**
- OpenCode fixtures were synthetic until R2.2 landed (commit f05e7a5): smoke + auth_expired are now REAL recordings, both live slots validate healthy through the server's per-provider probe, and the permission round-trip is proven on the real binary. The synthetic rate-limit fixture stays, honestly noted.
- Codex `rate_limit_rejected` fixture synthetic by necessity (window exhaustion not forceable cheaply); meta notes say so.

**Still open:** R1.11 (the owner's week of daily use — repo not yet chosen), H5's two-clean-machines leg, Linux §26 rows (second machine), the natural-capture fixtures (Claude `allowed_warning`; Gemini 429 needs a free-tier key), `docs/guide.md`'s troubleshoot row for `expectedInputSha` corrected in `docs/fault-suite.md` (the bug was fixed in R1.6-era server work and re-tested at `server.test.ts` "audit #5").

---

## Update — 4 November 2026 (the review implementation, PRs #9–#12)

- **v0.1.0 released**: the artifact carries the workbench, installs one-command on clean hosted runners (both OSes smoke-proven in CI), `mec --version/help/--no-open`, `doctor --json` (the bundle the docs always promised).
- **The tier layer is real**: models.yaml capability table with provenance, contracts-v0.1 (`model_request`/`resolved_model`), per-engine flag resolution with degradation, subagent-policy writers confined to slot homes; the gated models canary ran live (config-declared availability — see HANDSHAKES for why).
- **Prompts on disk** (21 shipped defaults, revisions, Default-updated), **the nine-tool planner** with bounded honest context and wakes, **the setup agent** (policy cards it can never apply), **scorecard tier projections** (≥5 gate), **the ported workbench** (two-step approvals, keyboard-first, SSE, Playwright 21/21).
- **Repo**: branch protection live (nine required checks, linear history), all CI on GitHub-hosted runners, community files, plan files renamed, docs/README.md index.
- Still open: the Session-2 acceptance demo on mec-sandbox (a tiered plan → cheap-tier attempt visible in resolved_model → cross-provider review → prompt-edit visible in the next attempt → setup-agent draft applied); R1.11 (owner's week); the R2 exit review (DECISIONS #8/#9 expiry); Linux §26 rows.

## M2.1 real specialist slice (5 November 2026)

- **Proven with a real binary, behind `MEC_REAL_RUNNER=1`:** one Claude specialist on a scratch repo through a linked slot, from a seeded launch row to `succeeded` on the exact head, with a real journal, a commit, a check on that SHA and a report through `mcp__mec__report`. Evidence is in `docs/log/HANDSHAKES.md`.
- **Real-process, on the fake CLI:** process-group stop, wall-clock stop, the journal order, redaction, the `.mec/` guard, close stopping owned groups.
- **Not built here:** `deliver` and `replay` throw `NotWiredError` until M2.2 and M2.4. `ask_user`, `handback` and `request_confirmation` answer a named error. Orphan cleanup, live parking and second-wave dispatch are M2.4 and M2.2. Only `claude-sub` slots launch.
- **Superseded above:** "no real engine attempt ran" and "no test executes a process under Seatbelt" no longer hold for Claude on macOS.
