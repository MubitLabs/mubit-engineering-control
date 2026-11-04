# Handshake record

Each gate's demo, recorded when it runs (implementation plan Appendix B). Honest by construction: a gate not yet run says so.

| Gate | Date | Result | What ran / what did not |
| --- | --- | --- | --- |
| H0 — contracts frozen | 2026-11-03 | **passed** | `contracts-v0` tagged; both test suites green (a/b split) on macOS + the Linux self-hosted runners; four real Claude 2.1.317 fixtures recorded and conformance-proven; part-1 contracts review done against the recorded streams (unifiedWindows fan-out, unix-seconds resetsAt, terminal_reason over subtype — all folded into the contract). Not real: no engine ran an attempt; the demo of the loop was on FakeEngine with a scripted brain. |
| H1 — one attempt end to end | — | not run | Requires the real `claude` binary on a dedicated slot (R1.2). |
| H2 — real request via chat | — | not run | Requires login cards with a real pty and the real meta-agent brain (R1.3–R1.5). |
| H3 — §23 on a real GitHub repo | — | not run | R1.7. |
| H4 — fault suite + Codex | — | not run | R2.1. |
| H5 — full acceptance | — | not run | R2.2–R2.5. |

## Acceptance runs (pre-R1, on fakes — recorded for honesty, not as gates)

- **2026-11-03, chat → plan → launch on the fake engine** (bundled `mec` binary, live): message → ack → two-task plan → one launch enqueued with the review task correctly held by its dependency → duplicate idempotency key replays verbatim. Caught and fixed: the route/server header-name seam bug (`x-idempotency-key`), and the pnpm-10 native-postinstall block that broke Linux CI.

## R0 audit gate — 3 November 2026

**PASSED on macOS (cold clone, fresh reviewer instance); Linux manual run pending (CI-Linux green as partial evidence).** Full report in PR #3; issues #4 (test-quality survey: clean — no self-mocking tests) and #5 (expectedInputSha route bug — fixed same day, closed). Honest absences recorded in docs/STATUS.md: node-pty is a seam not a dependency; real Codex/OpenCode fixtures; CONTRACTS §9 artifacts (recorder, providers/ bodies, conformance.spec.ts, 7 scenarios/engine) listed as R1 backlog. R0 exits; R1 starts.

## H1 — one attempt end to end, on the real binary — 3 November 2026

**PASSED** (`MEC_REAL_ENGINE=1`, dedicated slot `~/.mec/engines/claude/preflight-a`, Claude Code 2.1.317, macOS arm64; the canary lives at `apps/desktop/test/h1.real.test.ts` — the §7.1 real-engine canary, rerun at every handshake and engine pin change):
- stage 0: fixture repo → bare-clone cache → worktree on the pinned base → mec-tools server up
- stage A: real attempt through the real adapter/supervisor/env: assistant message, **live `rate_limit_event` observed**, usage, exit `completed`; journal appended; `parkFromEvents` correctly reports no park on an `allowed` reading (the rejected→park leg is proven on the recorded fixtures; a live rejected recording is opportunistic)
- stage B: the macOS sandbox **denied reading `~/.ssh`** from inside the attempt (settings from `buildAttemptSettings`, `failIfUnavailable`)
- stage C: a Bash permission request **round-tripped through `mcp__mec__confirm`** on our MCP server (initialize handshake answered; allow decision returned in Claude's `{behavior, updatedInput}` shape) and both files landed
- stage D: worktree commit + acceptance check **passed on the head SHA**

Fixed on the way: adapter mints a UUID session id; `--input-format stream-json` dropped for one-shot `-p` (it waits on stdin); settings/mcp paths flow via `brief.env`; engine stderr surfaced; MCP config URL already carries `/mcp`; mec-tools answers the MCP `initialize` handshake. Learnings recorded in docs/engines.md.

## R1.4 — the real meta brain — 3 November 2026

**PASSED** (gated real-engine test, dedicated slot): a real meta-agent turn made tool-mediated decisions — `mcp__mec__acknowledge` + `mcp__mec__propose_plan` round-tripped through the live mec-tools server, the plan validateGraph-clean, the ack a real sentence. Two real-integration fixes on the way: (1) `--permission-prompts none` BLOCKS MCP tool calls with no bridge — the brain now pre-approves `mcp__mec__*` via `--allowedTools` (they are its only permitted tools, validated server-side); (2) model nondeterminism (plain-text turns) is handled by §6's bounded repair: one corrective retry when zero platform tool calls happened. Also learned: a same-process `execSync` freezes the tools server (event loop) — probes must spawn async. The composed path now uses RealClaudeBrain when MEC_META_SLOT is set (fake only under MEC_FAKE_ENGINE=1).

## H3 — the §23 flow on a real GitHub repository — 3 November 2026

**PASSED** (`MubitLabs/mec-sandbox`, private, branch protection strict + admin-enforced, CI on the self-hosted runners). The full chain, live:
1. A real Claude implementer wrote `farewell.js` + tests on a worktree pinned to base `111e2a4`; acceptance checks passed on head `f9af3a6`.
2. Integration merged `--no-ff` → `d54355a`; checks passed on the exact merge SHA. Nothing had left the machine.
3. **Card 1 (push)** — user approved → branch pushed (API-verified).
4. **Card 2 (pr_create)** — user approved → PR #2 opened with the §14 body; CI green twice (9s).
5. **Card 3 (pr_merge)** — user approved → merged; MEC reported `merged` only after GitHub's state said `MERGED` (20:57:41Z). main advanced to `6bd0e35` with the full provenance chain.

Real bugs the run caught in the release module (all fixed, unit tests green): `gh repo view` takes the repo positionally (not `-R`); gh reports check states UPPERCASE (`SUCCESS` vs `success`); the PR body must travel by stdin (`--body-file -`) or gh hangs. Sandbox lesson recorded in docs/engines.md: the protection context must match the reported check name exactly (`check`, not `ci / check`).

## H4 — mixed-engine delivery + restore drill — 3 November 2026

**PASSED** (`MubitLabs/mec-sandbox`, PR [#3](https://github.com/MubitLabs/mec-sandbox/pull/3) merged GitHub-confirmed 21:58:57Z, main `a99d2b1`). The first flow ever to cross engines, live end to end:

1. **Claude implementer** (slot `preflight-a`, sandboxed, bridge) wrote the greeting feature on a worktree pinned to base `6bd0e35`; `npm-test` passed on head `ab5a8f2`.
2. **Codex reviewer** (slot `codex-1`, read-only, 3 real turns) — round 1 **CHANGES**: caught `.mec/` attempt artifacts (engine settings + attempt-scoped bearer token) staged into the task commit — a genuine leak class every fake-based check is blind to. Round 2 **CHANGES**: flagged the remediation itself as an unrelated deletion (H3's identical leak sits in BASE). Resolved by SPLITTING: task branch restored greeting-only; the H3-leak removal rode as its own labeled hygiene commit. Round 3 **LGTM** on the clean diff.
3. Integration at `819f617` (merge + hygiene), checks passed on the exact SHA; push/PR/merge behind three approved cards (the third under standing authority, DECISIONS #8); CI green twice on the self-hosted runner; merge confirmed by GitHub state only.
4. **Restore drill against the REAL state dir**: backup excluded by rule the Codex `auth.json`, every keystore key and salt, locks and tmp; the drill restored into scratch and verified db sha-vs-manifest, zero credential files, slots-to-reprobe. A stolen backup carries no credentials by construction.

Real product bug found and fixed (`packages/git` commitAll): `git add --all` staged the worktree's `.mec/` control directory into task commits (H3 pushed it to GitHub; f9af3a6 retains the dead attempt token in history — private repo, token dead, removal noted in 819f617, history rewrite not warranted). The seam now pathspec-excludes `.mec/` in both status and add — a tree whose only changes are attempt artifacts is CLEAN to it. Regression test included.

H4 quota: ~4 Claude implementer turns + 5 Codex review turns (vendor-accounted, cents).

## R2.3 — cross-engine pairs complete (the inverted pair) — 3 November 2026

**PASSED** — PR [#4](https://github.com/MubitLabs/mec-sandbox/pull/4) merged GitHub-confirmed 22:27:36Z, main `7c533cc`. With H4 this closes R2.3's pair evidence in BOTH directions:

- **Codex implementer** (slot `codex-1`, workspace-write sandbox, bridge allow) wrote the exclaim feature on base `a99d2b1`; `npm-test` passed on head `e06be12`.
- **Claude reviewer** (slot `preflight-a`, read-only): **LGTM**, request + diff delivered in the objective (first attempt hit max_turns hunting for context the prompt never carried — reviewer briefs must be self-contained; recorded).
- Cards opened/settled through the real store under DECISIONS #8; merge GitHub-confirmed.
- **The commitAll `.mec` exclusion held in production**: the merged commit touches `exclaim.js`/`exclaim.test.js` only — the leak class H3 shipped and H4's reviewer caught is closed for real runs.
- Transient lesson: a superseded check-run reports `CANCELLED` between check-suite updates; `mergeBehindCard` correctly refuses any non-green read — the retry with a fresh card merged cleanly. (Possible follow-up: treat CANCELLED-when-a-successor-exists as non-blocking.)

Quota: ~3 Codex turns + 2 Claude review turns.

## R2.6 — provider limits on real signals — 3 November 2026

**PARTIAL-PASS, honest.** Deliberate bursts against the live slots (keys from keystores inside the scripts, never printed; curl via stdin config; bodies carry no secrets):

- **z.ai GLM: REAL 429 captured.** 30-concurrent tiny chat-completions on the coding endpoint (`api.z.ai/api/coding/paas/v4`) — 16 of 75 requests across three waves answered HTTP 429 with body `{"error":{"code":"1302","message":"Rate limit reached for requests"}}`. Recorded verbatim at `packages/testkit/fixtures/providers/zai-coding-plan/429.json` (the exact `providers/<provider>/` artifact CONTRACTS §9 promised) with a real capture meta; drives a `classifyOpencodeError` regression case. The opencode turn-level fixture stays envelope-synthetic (no turn burned) — its meta says exactly that.
- **Gemini 429: NOT forceable on this key.** The billing-linked project absorbed 45 concurrent tiny `generateContent` calls with zero 429s (paid-tier RPM ≫ the free-tier 10 RPM the plan assumed). Recorded as attempted; the Google-429 fixture shape stays synthetic with RetryInfo/quotaId parsing exercised. A free-tier key would trip it in one burst if ever needed.
- **Claude `allowed_warning`: not forceable cheaply.** The real fixtures carry live `allowed` five-hour/seven-day events (smoke, max_turns) with utilization 0.23/0.07; pushing a Max-plan window to its warning tier means burning real subscription quota wholesale. R1.11 daily use will capture it naturally — the parser's warning tier is unit-covered until then.

Sequencing lesson recorded for the burst scripts: `--data-binary` without `content-type: application/json` makes Google's gateway bind the JSON as form fields ("Cannot bind query parameter") — 400s that look like payload bugs.

## The 4 November review — implemented — 4 November 2026

The review package (docs/review/2026-11-04/) implemented end to end across PRs #9–#12: the one-command install (artifact carries the workbench, meta slot from the store, browser-open first run, install.sh, release.yml with npm owner-gated; **v0.1.0 released and smoke-proven on clean hosted ubuntu+macos runners**), community/governance files, plan-file renames, and Sessions 2+3 — the tier layer (models.yaml capability table, contracts-v0.1, resolveModel per engine with ladder degradation, subagent-policy writers), prompts on disk (21 defaults, revisions, Default-updated; META_PROTOCOL_TEXT out of code), the real planner (§5.1 bounded context, NINE tools executed, tier/frontier/subagent validation, wakes; setup agent whose policy cards it can never apply), scorecard tier fields (≥5-attempt gate, hintsFor), and the full workbench port (prototype components, SSE, self-hosted OFL fonts, Playwright 21/21).

**T8 canary (MEC_REAL_MODELS=1, live)**: the shipped table's zai entries resolve against the live slot; ladder degradation holds. Real findings recorded: `opencode models --standalone` reads NO config (catalog only) and the managed-service variant collides with the ambient opencode install — availability probing is therefore **config-declared** in v0 (the slot's own opencode.json, method stated in the probe note); the glm-2 slot's config was stale (zai-coding/glm-4.7 from the R2.2 era) and was aligned to zai-coding-plan/glm-5.3{,-flash}.

**Process record, honestly**: four working-tree wipe events destroyed uncommitted lanes mid-build (an errant destructive git operation by an unidentified process). Countermeasures that ended it: a 3-second rolling snapshot daemon (recovered two lanes verbatim), a read-only .git lock between commits, Rule Zero (no git writes) in every agent brief, and commit-within-a-minute. The lost work was rebuilt each time; every merged lane was verified after its final recovery.
