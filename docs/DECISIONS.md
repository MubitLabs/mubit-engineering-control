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
| 9 | #8 expiry (4 Nov public-repo review §4) | **Expires at the R2 exit review** | The standing operator approval does not survive into daily use: per-card confirmation returns as the default for every external effect. Any continuation is a new decision row here, argued fresh. |

**Amended plan items (binding):** R2.4 → internal distribution; R2.9 → internal beta; §4.2 public-npm steps → internal registry steps; §4.4 → vendor terms only; §6.5 money table unchanged (subscriptions held anyway); §7.5 release checklist "publish" step → internal registry publish.


## 5 November 2026 — meta-agent product direction

The owner explicitly confirmed these four choices during repository/journey planning. They guide the **proposed next design** in [the meta-agent journey plan](changes/2026-11-05-meta-agent-journeys/CHANGE.md); they do not approve the whole plan, authorize execution/rollout, or establish shipped behavior.

| # | Decision | Confirmed direction |
| --- | --- | --- |
| 10 | Repository workspace | Separate meta conversation and work history per repository. |
| 11 | Local versus external authority | Meta plans and runs local coding work autonomously under policy; ask before push, PR creation and merge. Existing security/policy gates remain. |
| 12 | Default delivery target | Tested PR ready for review; merge is a separate decision. Pending external approval is not delivered PR-ready work. |
| 13 | Review default | Routine builder failing-then-passing checks and meaningful mutants; one blockers-only review for secrets/sign-in/permissions, money, stored-data deletion/migration, and public posts to another repository. Preserve required human reviews and current enforced checks; no unnecessary reviews or re-reviews. |

Legacy unassigned/read-only history, transactional global IDs, per-repo draft persistence and rollout flags are proposed engineering safeguards, not additional owner-confirmed decisions. Implementation/spec updates require plan agreement and an execution prompt with environment, authority and limits.


## 5 November 2026 — overhaul execution authority

The owner authorized execution of the overhaul. These rows bind the overhaul in `docs/changes/2026-11-05-meta-agent-journeys` only.

| # | Decision | Answer |
| --- | --- | --- |
| 14 | Release environment | Isolated scratch repositories and state first, then the owner's existing local install. |
| 15 | Rollout authority | PR creation, merges, version bumps, tags, GitHub Releases, local reinstall and restart, and enabling flags after each increment is verified. Excludes npm publication, vendor or account changes, and any SQL migration or stored-data deletion, which stay separately approved. |
| 16 | Confirmation cards during this build | Every push, PR and merge card opens on a scratch-state MEC server and the owner clicks each one; the owner's ~/.mec gets no build records. Decision #8's scripted resolve is not used for this work. |
| 17 | Squash bootstrap | release.ts merges with --merge, which linear history refuses. The PR that corrects it to squash is squash-merged by the owner by hand on GitHub, once; no agent runs a raw merge. Later merges use the repaired card. |
| 18 | Real-engine budget | Claude, Codex and OpenCode, at most 10 bounded runs per engine on scratch repositories or mec-sandbox, through existing slots; stop and ask at the cap. Credentials are never read. |
| 19 | Replan task keys (spec §10) | Within one work item, a task key reused by a replan is the same task: it keeps its canonical ID, history, attempts and status, and status is never reset. A task whose meaning truly changes uses a new key. |
| 20 | Holds (spec §10, §12.5, §13.4) | Only the owner's explicit lift command releases a hold; the planner never can, including from a chat message. A plan that finishes during a hold is saved with zero launches and waits for the lift. |
| 21 | Pause persistence (spec §20) | Pause processing is stored and survives restart until the owner resumes; the UI shows the paused state at startup. |
| 22 | Settings home for §18 items | Check profiles and isolation profiles live under Repositories. Pause is a persistent global control beside Needs you. Everything in spec §18 stays reachable and the spec line is updated to match. |
| 23 | Card approval speed (supersedes #16 and #17) | Owner, 5 November: "no need to wait for my click, you can skip it and build and ship as fast as possible, also get rid of all potential slow down stuff". Cards still open, settle and journal on a scratch-state server, and the operator resolves them by script without per-card owner approval. The bootstrap PR merges through its own repaired squash card; no raw merge. Required checks are never bypassed. The exclusions in #15, the cap in #18 and separate approval for any SQL migration or stored-data deletion stand. |
