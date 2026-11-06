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
| 24 | What counts as a run (#18) | One bounded request counts as one run per engine involved, however many processes it starts. |
| 25 | Repo checks and the sandbox (spec §8.4) | Unsandboxed repo checks are allowed only on scratch repositories and mec-sandbox, with a scrubbed environment and no tools token. The runner flag stays off for real repositories until the owner decides again. |
| 26 | Failed attempts (spec §10, §17) | Attempts get a terminal `failed` state reachable from queued and running, with one §10 line. |
| 27 | Chat during Pause (spec §20) | Record only: a message is stored and its planner turn runs after resume, so nothing spends quota while paused. |
| 28 | Hold on a running turn (spec §10, §12.5) | The running turn finishes and receives no new input. Stop is the way to halt it. |
| 29 | When work is done (spec §10, #12) | Work stays integrating, shown as Ready for review, until GitHub confirms the merge or the owner closes it. |
| 30 | Mid-turn input on Claude (spec §9, §12.3) | Use stream-json as the spec says. If unreliable on the pinned version, deliver at turn end through --resume in the same slot, marked delivered only then. |
| 31 | Engine server scope (spec §9, §8.1) | One engine server per attempt for this release, with a matching spec §9 change. |
| 32 | Routine acceptance (spec §10, §15, #13) | Passing registered checks on the exact head accepts a routine task. Sensitive tasks also need the one blockers-only review. Spec §15 gets a matching line. |
| 33 | Sensitive classification (spec §15, #13) | A planner-set flag now, plus a deterministic per-repo path list once that repo field exists. No invented classifier. |
| 34 | Repositories with no required checks | A PR may be ready on local combined checks with that limit stated. The merge card stays held until the owner decides for that repo. |
| 35 | UI default and releases (spec §18, §21) | Flip to the new UI in 0.3.0 once one engine path is proven end to end, with unproven engines shown as unavailable. `?ui=classic` stays for one verified install, then 0.3.1 removes classic. |
| 36 | Remaining open questions | The owner accepted every other recommendation in the "Open questions" sections of the files in `docs/changes/2026-11-05-meta-agent-journeys/handoffs/`, as written on 5 November 2026. |
| 37 | Claude budget (supersedes the Claude part of #18) | The owner raised the Claude cap to 20 runs on 5 November and asked for side lanes to run in the coordinator session. Codex and OpenCode stay at 10 runs, with #24 defining a run. |
| 38 | Inspection index and SQL migration (M3.1) | No inspection index and no SQL migration for now. Reads of 109-182 ms at 50,000 docs in every kind, and the `needs?recent=1` cost, are recorded as known limits in `docs/known-limits.md`. The handoff's scenario (50,000 tasks, 1,000 work items) reads in 30-54 ms. Owner decision, 5 November 2026. |
| 39 | Landing and release speed (beside #15) | Owner, 5 November 2026, after #38: "Push and make live as soon as they're ready. I have my full permission and authority to do so." Each branch lands as soon as it is verified, and release and install follow as soon as verified. The limits in #15 stay: no npm publication, vendor or account changes, SQL migration or stored-data deletion. |
| 40 | Shared clone denied to a specialist (spec §26) | Coordinator ruling under spec §26, prompted by a real worker overwriting a sibling's ref (handoff 20, verifier run 3). A specialist's shell cannot write the shared clone's refs, packed-refs or objects (`<dataDir>/repos/*.git` in `sandbox.filesystem.denyWrite`). Workers do not commit; MEC commits the leftover tree on a completed exit. The cost is in `docs/known-limits.md`. |
| 41 | Pace, reviews and the restart port (beside #13, #15, #39) | Owner, 6 November 2026: "yes to all and skip all unnecessary reviews and tests... directly ship and make everything live without long blockers". Restart reuses the last port. Editing a repository keeps refusing admitted work at its next launch (`repo_profile_changed`). Routine work ships on the builder's tests and mutants, and separate verifiers are dropped for the rest of this overhaul. Rebase agents run focused tests; `land.py`'s `pnpm check` and the required CI stay. The standing blockers-only review stays for permissions, sign-in and secrets, scoped narrowly for 23 A and 30 S2. The real runs reserved for the 22 and 23 A verifiers are unspent, so that real-engine evidence moves to 33 B and the installed checks. |
| 42 | One PR for seven handoffs, Claude-only proof | Owner, 6 November 2026, approved the single PR and Claude-only proof. 21, 22, 23 A, 23 B, 30 S2, 31 C and 32 stage B land as one PR, superseding small PRs for these seven. 0.3.0 is proven on Claude only. Codex and OpenCode real-run proof on the final build follows after release. |
| 43 | Planner `slot_class` hint (spec §10) | A planner's `slot_class` hint is a preference. A task runs on any healthy slot if no slot matches. Recorded 6 November 2026 from the coordinator's pending records, with no owner quote; the code (commit 772f683) reached `origin/main` in #47. |
| 44 | Owner answers on queued capacity, the approval route, restart and J/A/G W (6 November 2026) | Owner, 6 November 2026, four answers. (1) Policy change: a queued attempt gives its capacity back; running work is not cancelled. The owner approved changing the pinning test. (2) If a worker can reach the approval route in the real test, 0.3.0 holds until an approval secret is added and retested. (3) `mec restart` really restarts the server. (4) J, A and G W come to the new shell in 0.3.1. |
| 45 | A process group that refuses to die (spec §8.1, §10) | Owner, 6 November 2026. 0.3.0 ships as built: the attempt is failed, the failed stop is recorded and capacity is freed. This is a known limit (`docs/known-limits.md`). 0.3.1: the attempt stays failed, but its capacity stays held until the group is gone, so `reconcileProcesses` must track failed attempts with a live group. |
| 46 | Merged work and the test baseline (record only) | Recorded 6 November 2026 from the coordinator's pending records, with no owner quote. #44 (vendor login from an installed package, a package with no catalogue refused), #45 (five gaps before the new shell is default), #46 (`mec backup` and `mec restore`) and #47 (the combined M2 ship PR, decision #42) are merged on `origin/main` (head `1900dcb`). `login-cards.test.ts` is no longer a permitted baseline failure: `nodePtySpawn` restores the `spawn-helper` execute bit, so the test passes (`docs/changes/2026-11-06-package-contents/change.md`). A red `login-cards` now counts as a new failure. |
