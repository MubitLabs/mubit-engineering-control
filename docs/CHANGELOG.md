# Changelog

## 0.3.12 (10 November 2026)

A fix from the second live run of UI evidence. See `docs/changes/2026-11-10-yield-same-diff/`. No migration.

- **MEC gives way only to the same change.** Before opening a pull request, MEC looks for a branch or pull request that already has the work. It used to give way when the other branch merely touched the same file names; now it needs the same commits, or the same contents in every changed file (spec §14). A delivery stopped under the old rule is checked again once, and goes on to the push card if it no longer matches.
- **When MEC does give way, Work says so**: "Same change already on GitHub", naming the branch and pull request, instead of showing Working.
- The Screenshots caption on Work no longer shows a doubled full stop.

## 0.3.11 (10 November 2026)

Fixes from the first live run of UI evidence. See `docs/changes/2026-11-10-self-findings-and-dropped-repair/` and `2026-11-10-settings-checkbox-and-stale-delivery-line/`. No migration.

- **A worker's own notes never start a repair.** Only a reviewer's findings, or a failing check, send a task to repair. Before, an implementer's report that described its own files was read as review findings.
- **A repair that finds nothing to fix no longer cancels the task.** The task is judged on the work it already has: acceptance, review when it's sensitive, screenshots, then delivery. A reviewer's finding the repair declined is recorded as declined, with its reason, in the pull request.
- **Work whose every task ended says so.** It blocks in plain words, with "Stop this work and ask again", instead of showing Working with nothing running.
- **The "Screenshots before review" checkbox sits inline with its label at normal size.**

## 0.3.10 (10 November 2026)

The 0.3.9 content, released. The v0.3.9 tag's release build failed before publishing anything: its check step had no Chromium for the UI evidence tests. The release workflow now installs Playwright's headless Chromium before `pnpm check`, as CI does. No code change and no migration.

## 0.3.9 (10 November 2026)

The owner's answers of 10 November, built. See `docs/changes/2026-11-10-owner-answers/`, `2026-11-10-planner-capabilities/`, `2026-11-10-codex-filechange/` and `2026-11-10-ui-evidence/`. No migration.

- **UI evidence (spec §15), a repository setting, off by default.** Settings › Repositories › "Screenshots before review". When it is on, MEC itself takes before and after screenshots, labelled with their revisions, of a change people can see, and holds the task until both exist. A screenshot it can't take says why and never counts as a pass. The captured page has no way out to the network. Turning it on doesn't disturb running work. The machine needs Playwright's Chromium (`npx playwright install chromium`).
- **The planner knows which connections can run commands.** OpenCode edits files but can't run commands; a task that needs commands is placed on a connection that can, or the plan says why not.
- **Codex file edits work.** MEC started Codex through the `~/.local/bin` link, which the worker's sandbox blocks, so every native file edit failed. It now starts Codex by its real path.
- **Bring up to date is not offered when someone else pushed to the branch**; MEC says so and points to the pull request (DECISIONS #68).

## 0.3.8 (9 November 2026)

A fix from the owner's horse tinder test on the installed 0.3.7. See `docs/changes/2026-11-09-stale-block/`. No migration.

- **A work no longer stays blocked once none of its tasks is.** When the task behind a block is cancelled or otherwise no longer blocked, the work resumes and integrates what was accepted, instead of reading Blocked with no action.
- **An accepted task doesn't wait behind a blocked task it doesn't depend on** (spec §14: accepted tasks merge in dependency order).
- **Cancelling a task reports it as cancelled**, and the Blocked line never names a task that is no longer blocked.

## 0.3.7 (9 November 2026)

Fixes from the owner's "build a horse tinder website" test on the installed 0.3.6. See `docs/changes/2026-11-09-follow-up-base/`. No migration.

- **A follow-up builds on what the work already made.** A new task in a work that already has integrated tasks starts from the work's integration head by default (owner decision, 9 November 2026: "A"); a truly independent task can opt out.
- **A replan restarts a blocked task** whose dependencies, base or goal changed, on a fresh worktree.
- **The planner reads a declined push correctly**: the work is integrated locally; only the push to GitHub was declined.
- **After a declined push, a fixed and checked result can be pushed** instead of leaving only Hold and Stop.
- **The stage shows running work** instead of "Push declined" while fix tasks run.
- **A page left open across an upgrade says "MEC was updated. Reload"** instead of "Could not read this delivery".

## 0.3.6 (9 November 2026)

Fixes from real Codex and OpenCode requests on the installed 0.3.5. See `docs/changes/2026-11-09-codex-sandbox/` and `docs/changes/2026-11-09-moved-head/`. No migration.

- **Codex can run Node checks in its worktree.** MEC's sandbox profile for Codex no longer hides the worktree's parent folder, which made `node --test` fail with EPERM. Other attempts' folders stay unreadable by name, and keys, engines and the store stay fenced (blockers-only review: no blockers). Each Codex file edit's paths and status are now recorded.
- **A pull request that changed on GitHub says so.** If the branch head is no longer the commit MEC pushed, Work and Needs you read "The branch changed on GitHub (now <sha>). MEC won't merge commits it didn't check." instead of "Working" indefinitely.
- **Bring up to date.** A pull request that is behind its target, or whose head moved, can be brought up to date: MEC merges the target in locally, runs the repository's checks, and asks to push on a card.
- **GitHub's Update branch is accepted** when it only merges the target into MEC's commit and the pull request's changes are unchanged.
- **Queued checks say so.** While GitHub's required checks wait, the work reads "Waiting for GitHub checks (queued since HH:MM)".

## 0.3.5 (9 November 2026)

Real Codex and OpenCode requests on the installed 0.3.4 surfaced three problems. Each is fixed and proven on the real binary. See `docs/changes/2026-11-09-opencode-2.2.6/`, `docs/changes/2026-11-09-codex-models/` and `docs/changes/2026-11-09-ui-leftovers/`. No migration.

- **OpenCode 2.2.6 is accepted.** The engine version gate takes a set of proven versions; OpenCode accepts 2.2.5 and 2.2.6, proven by a real run.
- **Codex runs only a model the signed-in account offers.** The connection's offered models are listed after the launch check (no login, no tokens), and placement never picks a model the connection doesn't offer: the next model at the same tier, then down the ladder only. The gpt-5.6 family comes first in the shipped table. A refused model reads "The connection cannot run the model chosen for this task: …" instead of "engine api error".
- **A finished sign-in checks itself**, so a fresh Codex sign-in reads Healthy without pressing Check again.
- **The unlinked send line updates once the tab is linked** and keeps Retry.

## 0.3.4 (9 November 2026)

From the installed 0.3.3 walkthrough. See `docs/changes/2026-11-09-stop-confirm/`. No migration.

- **A lapsed confirm says so.** An armed Approve, Deny or Stop disarms after 8 seconds; it now reads "Not done: the confirm lapsed after 8 seconds. Press it again to arm." instead of going quiet.
- **An open stop card stays open** when a refresh moves its delivery to another Work group.

## 0.3.3 (9 November 2026)

Fixes from Chrome walkthroughs of the installed 0.3.2, including real run 31 (a request to merged PR #6 on `mec-sandbox`, where the 0.3.2 card fixes held on a real card). See `docs/changes/2026-11-09-stuck-clarity/` and `docs/changes/2026-11-09-retry-truth/`. No migration.

- **Blocked work says what to press.** The Next line names the retry on offer ("Retry integration", "Ask to push again", "Try again") in Work and Needs you, and the detail puts that button at the top.
- **An unlinked tab says so in place.** A keyed action from a tab that isn't linked offers **Link this browser** where you pressed, instead of "refused this: approval_required". Known refusals read in words.
- **No raw codes.** Reasons such as `repo_profile_changed` and the launch and release refusals read as sentences. Work admitted under repository commands that have since changed reads that way, with "Stop this work and ask again", and no longer offers a retry that would be refused (spec §14, decision #41).
- **A sent message's draft stays gone** after a reload.
- **The inspector follows a card once it settles** instead of presenting it as open.
- **The A shortcut never denies.** It arms only the focused card's Approve; a second A used to press Deny.

## 0.3.2 (9 November 2026)

Fixes from the installed 0.3.1 walkthrough (a real request to a merged pull request on `mec-sandbox`), and the classic shell removed. See `docs/changes/2026-11-09-approval-cards/`, `docs/changes/2026-11-09-stop-and-stages/` and `docs/changes/2026-11-09-remove-classic/`. No migration.

- **Deny takes two clicks, and nothing moves.** On push, PR and merge cards Deny now arms first, like Approve, and neither button changes size when armed. The walkthrough denied a push by accident when an armed Approve pushed Deny under the cursor.
- **The push card shows what goes out.** Its Checks tab shows the checks recorded on its exact commit, its Diff tab the files and line counts from the work's base, both redacted, and the card face shows the short commit.
- **A PR body keeps its line breaks** on the card and in the inspector.
- **Card notices clear.** "The merge card is in Needs you" goes away once that card is answered.
- **`mec stop` stops the server.** It used to write the stop marker and print success without signalling anything. It now sends SIGTERM to the proven server pid, waits up to 45 s, and says `stopped pid N` only once it is gone; a survivor is reported with exit 1. Shutdown is bounded.
- **A declined push says so.** Work reads *Push declined* (or *Pull request declined*, *Push failed*) with *Ask to push again*, not *Working* (spec §10, decision #63).
- **Old answers show.** A question whose answer was filed on other work shows that answer instead of *stopped without answering*.
- **Try again on a blocked integration** whose repairs are used up, and the blocked sentence in chat names the task and the reason.

- **One shell.** The old workbench and its `?ui=` switch are removed (decision #35; merge held by #48). A leftover `?ui=` in an address or a stored choice in the browser is ignored and left as it is, with no migration. A view that throws while drawing is now contained to its pane. See `docs/changes/2026-11-09-remove-classic/`.
- **Card shortcuts.** J moves to the next open card, A arms the focused card's approval (it never confirms), and G then W opens Work. None fires while typing or under a dialog.

## 0.3.1 (8 November 2026)

Core coordination, delivery, per-repository agreement, the approval key and meta-agent visibility. Prepared on `chore/version-0.3.1` from `origin/main` at `3b40f25` (#51), then brought onto `8d8bc8f` (#52) with the fixes of 8 November; see `docs/changes/2026-11-06-core-ship/`, `docs/changes/2026-11-06-host-run-agreement/`, `docs/changes/2026-11-07-real-run-defects/`, `docs/changes/2026-11-08-ceiling-and-reference/` and `docs/changes/2026-11-07-release-0.3.1/`. Not tagged or released yet.

- **Nothing runs in a repository until you agree.** The real runner is on by default, but for each repository nothing runs there (no launch, no resume, no repository command, no check) until you agree for that repository in Settings, Repositories. Work waiting on it reads *Waiting for your agreement* in Work, and Needs you carries one agreement row per repository. A store from before this build starts unagreed, with no migration. You can withdraw the agreement: a running engine finishes its turn, its checks stop at the next one. This supersedes decision #25 (decision #50), and the risk is stated there: once agreed, a repository's setup and checks run on your machine without the engine sandbox.
- **"Link this browser" is needed after a restart.** Agreeing and answering a push, PR or merge card now need an approval key held in the server's memory and handed to a browser by a link the server opens. A restart ends the key, so a tab shows **Link this browser** and you press it once. Approving needs a browser on this machine. Before this, any local process could settle a card with one POST. `docs/known-limits.md` lists what the key does not stop.
- **Core coordination.** An answer reaches the chat as the message's reply; a question sent beside live work gets a real planner turn and answer, not "Noted as context" (spec §12.1, decision #52); work with no answer reads *No answer* and stays open; a question that is answered ends its work (spec §10 `planning -> done`, decision #53).
- **Delivery.** Work offers *Merge pull request* on a ready delivery through the merge card, a blocked delivery that a retry can answer says so, and bootstrap output (for example a generated lockfile) stays out of task commits and no longer blocks integration.
- **Meta-agent visibility.** Work and the live line show who a task is delegated to, what it is doing now, and which slot and model; a repository dropdown shows with two repositories or with unassigned history. Unassigned blocked work is listed but leaves every count.
- **Slots and capacity.** A task is placed only on a slot this build can launch, preferring a proven one. A planner `slot_class` hint is a preference (decision #43). A queued attempt gives its capacity back on a policy change. An attempt whose process group refuses to die stays failed but holds its capacity until the group is gone (decision #45). Capacity is checked when a row runs, so an agreement cannot release more rows than a slot has room for.
- **Meta slot units.** Specialists may use every unit of the meta slot; no reserved unit is enforced (spec §11 amended, decision #49).
- **Classic stays until the next release.** `?ui=classic` still works. Removal is held until a real pull request and merge pass on the installed build (decision #48); that pass came on 8 November and classic is removed in 0.3.2 (decision #62).
- **What the real runs found (#52).** A specialist that ends its turn on the base with no report, or whose last message opens with *Blocked:*, no longer counts as done (decision #57); a commit outside a task's owned paths goes back for repair. Specialists ignore your personal `~/.claude/CLAUDE.md` and get the repository's own `CLAUDE.md` and `AGENTS.md` in their brief (decisions #54, #56). Blocked work offers **Try again**, one fresh repair attempt, and your go-ahead in chat lifts the block so newly planned tasks start (decision #55). Integration repairs keep the tier you asked for. Waits and blocks read as words, not codes, and a failed setup command posts one chat line.
- **The approval key covers more.** Answering a question (decision #58) and sending a chat message (decision #59) need the key, like the cards, the agreement and Try again. A tab with no key keeps its draft and says the browser is not linked.
- **The ceiling is 95%.** New work starts on a connection until it reaches 95% of its limit (was 80%; decision #60). When work waits on it, Work, the live line and Delegation say so: "Waiting: Claude account preflight-a is at 96% of its weekly limit; MEC stops at 95%. Resets Tue 10 Nov 07:00", and chat gets one line the first time.
- **A question about running work is answered.** A question sent by reference to running work, through Discuss or a reference, gets a planner answer in chat and leaves the work alone (decision #61). A referenced message that asks nothing still goes to the specialist.
- **Proof.** Real Claude coordination runs A, B, C1 and C2 on the v0.3.0 base, with a fake `gh` and a `file://` remote, found the defects fixed here. This build's fixes are proven on fakes. No real engine has run the question turn, the *No answer* path or the agreement; the real `osascript` link has not run; `pnpm check` has not passed clean on a loaded machine (see `docs/changes/2026-11-06-core-ship/VERIFICATION.md`). Codex and OpenCode proof on the final build still follows. No migration.
- **Versioning.** Root, desktop and web move to 0.3.1 together (`apps/desktop/test/version-sync.test.ts`).

## 0.3.0 (6 November 2026)

The new workbench shell is the default. Prepared from `feat/next-final` (68c9658); see `docs/changes/2026-11-06-release-0.3.0/` and `docs/changes/2026-11-05-next-default/`.

- **New shell by default.** With no choice made, or an unknown one, or a browser store that throws, the page opens the new shell. `?ui=classic` and a stored `classic` still work, and the palette and the empty states link back. Classic is removed in a later release, after one verified install (decision #35). This is a changed default, not a new flag.
- **Measured limits.** Axe reported 0 violations over the six surfaces and their states at 1440, 1024 and 390, light and dark; sizes, field edges, clipping, focus rings, motion and reduced motion are checked by `limits.screens.playwright.ts`; a keyboard-only journey runs on every surface. Fixes were presentation, and keyboard focus return on forms and route changes. Screens: 931 of 931 on the last run.
- **Packaged server.** Axe (`apps/web/scripts/axe-server.mjs`) and Lighthouse (`apps/web/scripts/lighthouse.mjs --theme`) on nine routes of an extracted tarball, fake engine, scratch `HOME` and data dir: 0 violations and 100 in both themes. Neither gate is in `pnpm check` or CI.
- **Composed journey.** One request in the new shell reached a pushed branch and a pull-request card on real Claude 2.1.319 (66 s), and survived a server kill during `pr create` with one pull request. `gh` and the remote were fakes (`file://`), so no real pull request was opened. The fake-CLI journey suite passed 6 of 7 after the replay; the seventh passed alone once its wait was raised to 15 s, and the whole suite has not been repeated since.
- **Self-approval.** One real Claude worker's shell could not reach the inbox resolve route, direct or through the proxy. The route still takes no token; the sandbox is the whole of the fence.
- **Since 0.2.1:** M2 ship (coordination, delivery, recovery, Codex and OpenCode through the runner, inspection and work surfaces, backup and restore); see the M2 sections below and `docs/changes/2026-11-06-m2-ship/`. No migration.
- **Not claimed.** Codex and OpenCode in the composed journey (their own runner slices only, M2.4 Part B); a real GitHub pull request through the cards (the `mec-sandbox` pass is the coordinator's); assistive technology beyond axe, Lighthouse and keyboard; a green `pnpm check` on a quiet machine (8 load-related failures unresolved).
- **Versioning.** Root, desktop and web carry the same version, enforced by `apps/desktop/test/version-sync.test.ts`; the release workflow refuses a tag that is not `v` plus the desktop version.

## 0.1.0 (unreleased)

Internal build, week 1 (3 November 2026). Seeded from [`docs/log/week1.md`](log/week1.md) and [`docs/log/HANDSHAKES.md`](log/HANDSHAKES.md); behaviour of record is the plan.

### Foundations

- Monorepo `MubitLabs/mec` created from the hand-off kit: pnpm workspaces, TypeScript strict, Biome, Vitest projects `a`/`b`, CI (`static`, `suite-a`, `suite-b` on Node 22 and 24), CODEOWNERS.
- Contracts v0 (`packages/contracts`) written, reviewed against B's recorded Claude streams, tagged `contracts-v0` and frozen: events, briefs, reports, bridge, adapters, slots, store/effects, errors, fixtures — all Zod schemas with valid/invalid samples, no credential field anywhere.
- SQLite store (WAL, nested-rollback atomic, gap-free event log) with numbered migrations; effects queue with coalescing, backoff, `Later`, per-kind health; health board with one writer per entry.
- Domain port from v1: state machines, task-graph validation, impact summaries, caps, scheduler planning, specialist registry; stage table first-match tested row by row.

### Engines

- Claude adapter running the real binary headless (stream-json, permission bridge via `mcp__mec__confirm`, `rate_limit_event` normalisation, capability probe); conformance-proven on four real recordings.
- Codex adapter on the REAL ChatGPT login (R2.1): protocol reconciled to codex-cli 0.148.0, real recordings for smoke/permission/auth-expiry, gated canary green. OpenCode adapter on the REAL GLM Coding Plan + Gemini slots (R2.2): config-file providers with `{env:}` key substitution, real SSE protocol shapes, both live slots validate healthy. The rate-limit fixtures stay synthetic, honestly noted.
- Vendor-reality finding logged: `node-pty-prebuilt-multiarch@^1.0.0-beta` is not published; login cards ship with an injectable `ptySpawn` seam and a loud `pty unavailable` default.

### Runtime

- Journal port: per-append fsync, atomic ack cursor, torn-line-safe load, strict sequence refusal.
- Agent environment per §5.12 (allowlist is the scrub; exact-key-set test), supervisor (argv-only, process groups, SIGTERM→SIGKILL→confirm-gone, `(attempt, generation)` ownership), command shims + per-attempt gitconfig with hash manifest and foreign-file refusal.
- Isolation settings builder (Claude Code sandbox profile, Codex workspace-write, OpenCode permissions); checks on exact SHAs; park classification from engine events (quota/auth/provider).

### App

- Slot layer: credential homes, keystore courier (0600, fingerprint-only in the database, rotation, shred on retire), probes, redaction for every provider key shape.
- `mec` launcher with the §21.2 status contract (exit 0–3), intentional-stop marker and `restart --respect-stop`, `doctor` redacted by construction; one writer per state directory (O_EXCL lock, stale-pid recovery).
- Composition server (Fastify, loopback only) with chat intake and idempotency replay, confirmation inbox with compare-and-set resolve, work views, slots routes, login cards (serialised, bounded, live-only stream), SSE events; the workbench views (chat, inbox, work, slots, settings).
- Meta-agent rules (acks, routing, escalation, wake-vs-note), policy/guardrails with CAS confirmations and only-tighten repo overrides, prompt bundles with revisions and upgrade diffs, merge/conflict primitives, backup/restore with credential exclusion rules and drill, retention planning.
- §23 acceptance chain green on the bundled binary with the fake engine: message → ack → two-task plan → dependency-aware launch → duplicate idempotency replay. Caught and fixed the `x-idempotency-key` header seam and the pnpm-10 native-postinstall block that broke Linux CI.

### Gates H1 + H3

- **H0 contracts frozen — passed.** Both suites green on macOS and the Linux self-hosted runners.
- **R0 audit — passed** (cold clone, fresh reviewer instance): `pnpm install` + `pnpm check` green (1,361 tests); env scrub verified against a real child process; redaction verified for all five provider key shapes; compliance guard fails on a planted violation; two servers refuse one data directory. Findings filed (test-quality survey clean; `expectedInputSha` route bug found and fixed same day).
- **H1 one attempt end to end — passed** on the real binary (Claude Code 2.1.317, dedicated slot, macOS arm64): real attempt with a live `rate_limit_event`, journal appended, the sandbox denied reading `~/.ssh`, a permission request round-tripped through `mcp__mec__confirm`, checks passed on the head SHA.
- **R1.4 real meta brain — passed**: a real meta-agent turn made tool-mediated decisions (`mcp__mec__acknowledge`, `mcp__mec__propose_plan`) through the live mec-tools server.
- **H3 the §23 flow on a real GitHub repository — passed** (`MubitLabs/mec-sandbox`, branch protection strict + admin-enforced): implementer on a pinned worktree, integration `--no-ff` with checks on the exact merge SHA, then three approved cards — push, PR create (CI green), merge reported `merged` only after GitHub's state said `MERGED`.
- Not run: H2 (real request via chat through a real login), H4 (fault suite + Codex), H5 (full acceptance, mixed engines).

### Security

- No credential in any schema, event, journal or store doc: secret-field lint on contracts, pattern redaction for every provider key shape plus keystore fingerprints, secrets-in-chat guard (redact before durability, answer with the Slots pointer).
- Env scrubbing proven against a real child process; shims and gitconfig refuse foreign files; mec-tools tokens are attempt-scoped and role-fenced over real loopback HTTP.
- Compliance guard: static scan for reads of vendor credential stores, plus a self-scan over the product source in CI; verified by planting a violation on a throwaway branch.
- Repository-resident engine configuration treated as untrusted (no project settings, hooks, MCP servers or plugins from a cloned repo unless it is marked trusted).

### R1 completion + the R2 wave (3 Nov, evening — single operator)

- **R1.3–R1.7**: real node-pty login cards; the real meta brain (tool-mediated turns over the in-process MCP server); API-key slots end to end; the §26 composition rows closed (35/38 proven).
- **H3**: the §23 delivery on `mec-sandbox` — PR #2 merged GitHub-confirmed behind three approved cards.
- **H4 + R2.3**: mixed-engine delivery in BOTH pairings (Claude implements + Codex reviews; Codex implements + Claude reviews) — PRs #3/#4 merged; the Codex reviewer caught the `.mec` attempt-artifact leak class, fixed in `commitAll` and proven live; the restore drill ran against the real state dir with every credential excluded by rule.
- **R2.4/R2.5/R2.8**: `mec slot` CLI + internal tarball; first-run wizard; user guide, reference, CONTRIBUTING.
- **R2.7 + hardening**: threat model with every control cited to a test; the two High gaps (§22 origin/CSRF discipline, secrets-in-chat route test) closed the same day; `pnpm audit` clean.
- **Courier**: GLM + Gemini keys accepted (intake is a structure check, not a format oracle — vendor formats drift); live keys stored via the form only and validated healthy.
- **Repo readiness**: full Apache-2.0 LICENSE + NOTICE at root (tarball copies both verbatim); §21.1 CLI dispatch wired (`mec status|stop|restart|doctor|slot|update` from `bin/mec.js`).
