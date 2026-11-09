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

## Session-2 acceptance run — PARTIAL, honest — 4 November 2026

The §8 acceptance paragraph, driven live against the composed server on the real state:

**Proven live:**
- The real nine-tool planner planned from a real chat message: acknowledged, one implementer task with `originalRequestRef`, `ownedPaths`, `acceptanceChecks`, `budget` — and an honest deferral ("no slot is ready yet") that was CORRECT at the time (the store's slots were unvalidated; the meta slot had no slot doc).
- Slots made real: both API-key slots validate healthy through the server; the Claude slot doc created and probed healthy on 2.1.318.
- **F1 fixed by the run**: propose_plan tasks now REQUIRE `model_request` (tier|model + reason) end to end — the first live plan omitted it silently.
- **§5.8 drift catch, live**: Claude Code self-updated 2.1.317→2.1.318 mid-run; the probe degraded the slot on `--max-turns` leaving `--help`; functional check showed the flag still works; probe's required set corrected; engines.md records the drift.
- The prompt-edit flow end to end: PUT with base_revision+parts → revision 0→1 → the 8.2KB assembled implementer bundle for opencode carries the edit; Default-updated diff machinery answers.

**Open findings (issues filed):**
- F2: the real planner's tasks persist `ready` but the composed flow enqueues no launches (`launchesEnqueued: 0`) — the R1.4-era launch wiring does not consume the new brain's propose_plan path.
- Claude 2.1.318 headless regression: planner turns (MCP tools + restricted headless) end `api_error` deterministically (three turns) while plain one-shots succeed — blocks claude-side planner/attempt assertions until diagnosed; the §10 monthly re-verification exists for exactly this.
- The release bundle 404s route blocks that the source serves (the prompt routes are registered identically; fastify route-tree shows them; yet bundled-server requests fall to the SPA) — and `DEFAULT_MODELS_YAML_PATH` resolves to a nonexistent path inside the bundle. Both need bundle-layer fixes before the next tag.

## The three-issue fix wave — 4 November 2026 (PR #18, `b60517e`)

#14/#15/#16 closed by finding the real chain, live:

- **The composed planner now places and launches.** Three integration seams, all built in T5 and never wired: the capability-table supplier (every real turn planned against an EMPTY table), the availability-marks supplier (every slot honestly unlisted, so no tier was placeable), and the dispatch's slot list (FAKE_SLOT-or-EMPTY — real mode placed nothing). A fourth: the shipped meta protocol was the OLD three-tool text, so the model's conforming plans were rejected into ack-only turns.
- **Proof (the new gated canary, MEC_REAL_PLANNER=1)**: one real service turn on the real store copy → task created with tier `fast` and a reasoned modelRequest that names the slot by cost ("cost 1 vs 3 for balanced on slot_glm-2") → `launchesEnqueued: ["att_1"]`.
- **#15 reclassified**: not a 2.1.318 regression — the deterministic api_error turns ran wiper-corrupted bundles; real brain turns on 2.1.318 succeed repeatedly.
- **#16**: the models default resolves via three candidates and the tarball ships it beside the bundle; the route "shadowing" was a stale-bundle artifact (clean builds serve every block).

## M2.1 real specialist slice — 5 November 2026

Claude Code 2.1.318 (the installed binary, one above the pinned 2.1.317), `claude-haiku-5-5`, a linked slot with `CLAUDE_CONFIG_DIR` unset, real `HOME`, scratch `MEC_DATA_DIR`, fake `gh` first on `PATH`, a scratch repo. A seeded queued attempt and launch row, so no planner ran. Builder evidence, three runs, logged in `engine-runs.md`. Independent verification is still to come.

| Run | Outcome | What it proved |
| --- | --- | --- |
| 1 | `queued → running → work_complete → succeeded`, 35 s | Journal 12 events, ack 12. Branch head equal to the recorded SHA, check doc on that SHA, repo identity on the commit, one report stored. `.mec` absent from `git log -p`. No process left. Sandbox refused `cat mec.db`, a `touch` outside and the push. `mcp__mec__confirm` was never asked. |
| 2 | `failed`, `engine_max_turns` | With `--permission-mode default`, asks arrive. Deny rules refused `git push` and `gh pr list` by name. Found that confirm read the wrong input field, so `git -C . push` was allowed and stopped only by the sandbox, and an outside Write was denied for having no path. Fixed: confirm reads `input`, and an empty command is denied. |
| 3 | `succeeded` | Confirm saw the real command and path, and allowed `git status` and a Write inside the worktree. The model declined the steps that would have been refused, so this run proves the allow path only. |

Not proven here: the composed chat path with a planner, and a real Read-tool denial on a text file. The token and key-shape sweep over the data dir of runs 1 and 3 found nothing.

## M2.4 Part B: Codex and OpenCode through the runner — 5 November 2026

Each engine was proven on its own, through a seeded queued attempt and the real runner: no planner, scratch `MEC_DATA_DIR`, real `HOME`, fake `gh` first on `PATH`, a scratch repo, and the task's objective naming each step. Logins were the existing default homes. No key was read and no Claude ran. Report, head and checks are the runner's own path.

| Engine | Run | Outcome | What it proved |
| --- | --- | --- | --- |
| Codex 0.148.0, `gpt-5.6-luna` low | 1 | `queued → running → succeeded`, 72 s | Check on the exact head, `report` through MCP, `head_matches` true, no `.mec` in history, `MEC_TOOLS_TOKEN` not in the worker's env. Sandbox refused the database, `health.json`, `~/.codex/config.toml`, an outside `touch`, `git add`, `git commit`, `packed-refs`, `objects`, `.mec`. `git push` reached the remote side and failed there, on the same sandbox. |
| Codex 0.148.0 | 2 | `succeeded`, 41 s | Two real asks, a command and a file change, each recorded and answered `decline`; neither file exists. Sandbox refused a new loose ref, `packed-refs`, `objects`, `update-ref`. |
| OpenCode 2.2.5, `glm-5.3-flash` | 1 | `failed`, 2 s | MEC's own bug: the client ended the stream on a verdict's name in the echoed brief. No tool ran. Fixed with a test. |
| OpenCode 2.2.5 | 2 | `succeeded`, 56 s | Check on the exact head, `report` through `mec_report`. Allow round trip: a write inside the worktree came through the bridge, `once`. Deny round trip: `git status`, `git push` and a write into `.mec` asked, were rejected and the turn went on. The engine's own rules refused the database, an outside write and `.mec/opencode.json`. No tool of the linked home's MCP servers reached the model. |

A sweep of each data dir for bearer, key and password shapes found nothing. No process was left. Not exercised on either engine: resume, `turn/interrupt` or `/interrupt`, delivery into a running attempt, a read-only role, the composed path with a planner, a quota or auth park, and a keystore key at launch (a fake covers that one). `gh` on Codex was the fake: the profile refuses network, which `curl` to GitHub under `codex sandbox` showed, and a real `gh` was not run. Not checked: OpenCode's and Codex's own session stores under the linked homes, which are credential stores or sit beside them.

## M3.4 Stage B: self-approval and the composed journey on real Claude — 6 November 2026

Three bounded runs, real Claude 2.1.319 through the linked login: real `HOME`, scratch data dir, scratch repository, `file://` bare behind a github.com `origin`, fake `gh` first on `PATH`. `engine-runs.md` lines 16 to 18 of 20. `gh` and the remote are fakes in all three.

| Run | Sha | Outcome | What it proved |
| --- | --- | --- | --- |
| Self-approval probe, one `fast` specialist, no planner | 5c58079 | `refused`, 18 s | A worker's shell did not reach `POST /api/inbox/:id/resolve` or `GET /api/inbox`, direct or through the proxy: the script finished, no request answered 2xx, no answer held the card, the outside `touch` did not land, and the card stayed `pending`. The same URL and card answered a deny 200 from outside the sandbox. The reporter dropped the printed probe output, so the raw lines were not kept; the verdict is the test's own assertions |
| Composed journey, real planner and specialist | 5c58079 | Passed, 66 s | Request in the new shell, no question asked, one task, `fast` as `haiku`, `succeeded` on 3a3b5c6, check passed, integrated as 62d628e. Push card and PR card approved in the UI. The bare holds `a.txt` and `hello.txt`, no `.mec`. `pr create` once, `pr merge` never, delivery `pr-ready` |
| Same, server SIGKILLed during a slow `pr create` | 8095c4a | Passed, 60 s | After `pr create` ran and before MEC heard its URL. The boot read `pr list --head`, recorded `pr_created` with `reconciled: true`, then `pr_ready`. One `pr create`, no second card |

This settles the question for the shell on the route tested, on Claude only. It says nothing of Codex or OpenCode, and it is no authority on the route itself: the route still takes no token, and the sandbox is the whole of the fence. Not exercised: a model that hunts for another way out, a push or merge card killed mid-effect, and a real GitHub.


## Installed 0.3.1, real request to a merged pull request (8 November 2026)

Decision #48's gate for removing the classic shell. Installed `mec-0.3.1.tgz` (tag v0.3.1, `7a7dd82`), the real runner on, driven in Chrome as a normal user on `MubitLabs/mec-sandbox`. Link this browser, agree for `mec-sandbox`, one request ("Add shout.js …"). One cheap-tier task on the Claude slot ran on `claude-haiku-5-5`; checks passed; integrated with `shout.js` and `shout.test.js` only. Push card (first one denied by a mis-click, asked again, approved), PR card approved: PR #5. Sandbox CI passed and Work showed it. Merge card approved: GitHub reports PR #5 MERGED at 2026-11-08T21:28:18Z, merge commit `dbe767b`. Claude run 30 in `engine-runs.md`. The owner confirmed the pass and the removal on 9 November 2026.

## OpenCode 2.2.6 through the runner (9 November 2026)

The installed `opencode` self-updated to 2.2.6 and installed 0.3.4 refused an OpenCode launch on the version gate (OpenCode run 5 in `engine-runs.md`). Two runs on branch `fix/opencode-2.2.6` (base `77bcdb4`), with the proven-set change in the tree: real binary `~/.opencode/bin/opencode`, `opencode v2.2.6`. No keystore was read and no key reached the test; the real `HOME` was used only for the default home's existing `zai-coding-plan` login. `engine-runs.md`, OpenCode runs 6 and 7.

| Run | Command | Outcome | What it proved |
| --- | --- | --- | --- |
| 6, zero tokens | a scratch Node script: `opencode serve --hostname 127.0.0.1 --port 0 --stdio` on scratch XDG homes with `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_CONFIG` = `opencodeAttemptConfig(…)`; `GET /openapi.json`, `POST /api/session` (`build`, `plan`, a missing directory), `GET /api/agent`, `GET /api/mcp`, a reply to an unknown ask, `POST …/interrupt` on an idle session | All 200 except the reply (404 `PermissionNotFoundError`) and 401 without auth; exit 0 on stdin EOF | The serve API the adapter uses is unchanged (`docs/engines.md`, OpenCode 2.2.6 drift). A missing directory now gets a session. The merged agent rules end with two added `browser` denies |
| 7, one turn | `MEC_KEEP_SCRATCH=1 MEC_REAL_OPENCODE=1 node_modules/.bin/vitest run --project b apps/desktop/test/opencode-runner.real.test.ts` (`glm-5.3-flash`; the scratch tree was read for the counts, then removed) | `succeeded`, stream 25 s, test green | `session_started` engine 2.2.6. The edit ask for `made.txt` was allowed through the bridge and the file written; the shell ask `git status` was refused and the turn went on; `mec_report` stored; the check passed on the head; no `.mec` in history; exit `completed`; cost 0. No key shape or bearer value in the data dir. No serve process left |

Not exercised on 2.2.6: the read-only `plan` agent through the runner, interrupt and resume, a keystore key at launch (an `opencode-glm` slot with its own home), the composed path with a planner, and the adapter-level canary `packages/engines/test/opencode.real.test.ts`, which reads a slot under `~/.mec` this run was not allowed to touch. No fixture was recorded on 2.2.6.
