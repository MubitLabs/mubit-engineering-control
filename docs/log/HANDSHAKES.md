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
