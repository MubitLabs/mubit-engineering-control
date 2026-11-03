# Owner decisions — recorded 3 November 2026

Answers to the implementation plan §9, given by Shankha. These bind the plan where they touch it; amendments are noted per item.

| # | Decision | Answer | Implications |
| --- | --- | --- | --- |
| 1 | Licence and openness | **Apache-2.0** | Patent grant included; NOTICE file for third-party deps; redacted fixtures may be public. Contributor docs remain a nice-to-have, not a gate (see #4). |
| 2 | Product name / distribution | **Keep `mubit-engineering-control`, bin `mec`** | No landing page; no rename before R2. Revisit only if the product is ever published externally. |
| 3 | Pricing | **Free forever** | No paid tier ever. The plan's R6 "paid team edition" framing is void — R6 (if it ever starts, per #6) is a free internal/team capability. |
| 4 | Default conservatism | **This product is for internal use within the company** | The plan's stranger-facing assumptions are amended: R2.4 packaging distributes INTERNALLY (private registry / git install, not public npm); the R2.9 beta cohort is Mubit engineers, not outside users; the §4.4 legal work narrows to vendor-terms compliance (still required) — no end-customer licensing; conservative defaults remain the ship default but the audience is colleagues, so the utilisation ceiling may be set by one internal policy. §4.2's npm-org reservation and §4.5 design pass drop to optional. |
| 5 | R3 proactive intake | **Keep planned, re-decide at R2 exit** | No commitment now; the §5 calendar's R3 slot stands as provisional. |
| 6 | R6 trigger | **Explicit team demand** | R6 starts only when a real team asks to share a fleet / run it hosted — and per #3, it would ship free, not paid. |
| 7 | Beta shape | **Claude-only, internal** (3–5 Mubit engineers) | Beta support surface = R1-shape Claude slots; four-config breadth is validated by the team, not strangers. Names TBD by the owner at R2 exit. |
| 8 | Operator authority (3 Nov, mid-H4) | **Standing approval for external effects** | The owner delegates the per-card approval to the operator for the remainder of the build: pushes, PRs, merges, real-engine test turns and gate runs proceed without per-action confirmation. The card machinery stays (every external effect still opens, settles and journals a confirmation); the operator's scripted resolve stands in for the click. Revisit at the R2 exit review. |

**Amended plan items (binding):** R2.4 → internal distribution; R2.9 → internal beta; §4.2 public-npm steps → internal registry steps; §4.4 → vendor terms only; §6.5 money table unchanged (subscriptions held anyway); §7.5 release checklist "publish" step → internal registry publish.
