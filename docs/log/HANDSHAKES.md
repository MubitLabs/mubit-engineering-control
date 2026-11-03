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
