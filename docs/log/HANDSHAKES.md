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
