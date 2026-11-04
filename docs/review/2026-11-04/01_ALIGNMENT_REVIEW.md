# MEC — alignment review against the v4.1 plan

Reviewed 4 November 2026 on a cold public clone of `MubitLabs/mubit-engineering-control` at `e5ae484` (52 commits). Read: every top-level file, `docs/*`, `packages/meta`, `packages/prompts`, `packages/domain/src/registry.ts`, `apps/web/src/**`, the server's route list, `docs/engines.md`, `docs/fault-suite.md`, `docs/STATUS.md`, `docs/DECISIONS.md`. Not run: the test suite (no machine with the engines here); the claims below about what runs are taken from the repo's own evidence files and the commit messages, which cite PRs on `MubitLabs/mec-sandbox`.

## Verdict in one paragraph

The direction is right and the discipline is unusually good: authority in deterministic code, credentials never in the database, every external effect behind a CAS confirmation, fixtures with honest provenance, gates recorded with their limits. The build went well past the day-one report — H1, H3, H4 and R2.1–R2.8 are on real binaries, all three engines ran on real logins, two mixed-engine PRs merged on the sandbox repo. Where it diverges from the plan, it is almost always *depth*: the skeleton of a spec section exists, with the simplest possible interior. Four areas are thin enough that the product does not yet do what the plan's §0 promises in daily use: the meta agent's brain (a fixed three-tool protocol with no roles, no model choice, no follow-up routing), the prompt system (a compiler with nothing to compile — no shipped defaults, no editing, no revisions on disk), the specialist roster (eight names with empty instructions), and the workbench UI (a functional scaffold with no design system, no work-item pages, an empty Settings view). Items 4–6 of your request land exactly on these four.

## What is aligned (keep)

| Plan area | Evidence in repo | Note |
| --- | --- | --- |
| §3–§4 architecture, one writer, role-scoped interfaces, contracts seam | 17 packages matching the layout; `contracts-v0` unchanged since freeze; CODEOWNERS | three packages added beyond the plan (`meta`, `integration`, `failover`, `scorecards` split out) — sensible |
| §5.3–§5.8 slots, custody, courier, probes | `packages/slots`, keystore 0600 + fingerprint-only proven against real SQLite; zero-token validators per provider; real z.ai 429 captured | the `claude-glm` slot kind is not implemented (OpenCode-GLM covers GLM); fine for now |
| §5.6 login cards | real `node-pty 1.1.0`, serialised, bounded, live-only stream | the §21.7 pin question resolved correctly |
| §5.11/§22 compliance | guard self-scans the source; no OAuth store read anywhere; terms text present | guard is a tripwire, honestly stated (issue #6) |
| §8 runtime | env allowlist + scrub proven on a real child process; journal fsync/replay; shims + gitconfig; Claude sandbox profile proven live (H1 denies `~/.ssh`) | Linux sandbox rows still pending on the second machine |
| §9 adapters | all three on real recordings; protocol deltas documented in `docs/engines.md` (Codex 0.148 vs the plan's 0.166 row, OpenCode SSE envelope, the reply-inside-pump stall) | the plan's §9 table should be updated from `engines.md` |
| §13 guardrails | CAS resolve, stale, expiry-never-consent; the audit's `expectedInputSha` bug fixed and route-tested | pre-authorised classes and pairs exist in policy; policy *file* editing UI absent |
| §14–§15 integration and PRs | integration queue, yield-to-duplicate, PR behind three cards, merge GitHub-confirmed (H3, H4) | review rounds and findings model are thin (see below) |
| §17 store/effects/health | SQLite WAL, nested rollback, gap-free events, effects coalescing/`Later`/backoff, health board | matches the plan closely |
| §20–§21 recovery, CLI, packaging | backup/restore drill excludes credentials by rule; `mec status` 0–3; `mec slot`; internal tarball; refuse-to-compile | `mec doctor --json` exists for SETUP.md |
| §26 fault suite | 35–36 of 38 rows proven, provenance labelled | the open rows are honest |

## Where it diverges (fix)

### 1. The meta agent is a protocol, not a planner (plan §6, §7, §12)

`packages/meta/src/real-brain.ts` runs one `claude -p --restricted` turn with a hard-coded 11-line protocol: acknowledge → propose_plan (id, objective, depends_on, optional role) → report_result. Missing against the plan:

- No **context compiler**: the turn sees the message and a list of `workItemId (stage)`; no chat history, no slot health or utilisation, no confirmations pending, no holds, no budgets (§6 "each turn").
- No **routing**: `packages/meta/src/routing.ts` exists in the domain sense, but the real brain's decision has no `route` tool — follow-ups to live work, stops and holds do not reach the brain as decisions (§12.1, §12.3, §12.5).
- No **questions** (`ask_user`), no **spawn hints** (slot class, provider), no **read resources** in the brain's tool set (§6 tool set lists nine tools; the brain executes three and answers `{ok:true}` to the rest).
- Task briefs carry `objective` only: no owned paths, no acceptance checks beyond the `manual-review` pseudo-check, no verbatim original request pointer (§6 "the original message travels verbatim with every task brief").
- **No model or tier anywhere**: `AttemptBrief` has `engine` and `slot_id`; `--model` is pushed only when an input carries it, and nothing does. Codex ran `gpt-5.6-sol`, OpenCode ran `glm-4.7` and `gemini-2.5-flash` because those were the defaults at hand (`docs/engines.md`). This is your item 4.
- Wakes vs notes are classified (`wakes.ts`) but the brain is invoked only for user messages; specialist reports do not wake a planning turn with the report in context.

### 2. Prompt bundles have no content and no surface (plan §16)

`packages/prompts` compiles components and hashes revisions correctly, but: no default text ships for any role (`BUILTIN_ROSTER[*].instructions === ''`); nothing reads `~/.mec/prompts/`; there are no revisions on disk, no `Default updated` flow in the UI, no proposal area wired, no model-surface tests over real text. The only prompt text in the product is the meta protocol constant inside `real-brain.ts`. "Modular and editable" (your item 5) is therefore a design that exists on paper only.

### 3. Specialists are names, not roles (plan §7)

The roster defines tools, context policy and slot-class preference per role, which is right, but every role runs with empty instructions, the same `manual-review` pseudo-check, and the same `budgetTurns: 12`. Scope and delivery sections (§7 "scope discipline", §15 "review by outcome, bounded rounds") are not in any prompt. The agent graph (§7) is not exposed by the API or UI.

### 4. The workbench is a scaffold (plan §18)

~1,900 lines, dark-only, no design tokens beyond six colours, 13px base, 2px radii, no keyboard model, no focus styles beyond browser defaults, no reduced-motion handling, no work-item page, no agent graph, `SettingsView` is a stub ("select a section"), the inbox card shows an operation hash as the "evidence", the chat has no acknowledgement/plan/decision card types — every message renders the same. Polling (3–5 s) instead of the SSE feed that exists. Your item 6.

### 5. Smaller divergences

- `docs/plan/PLAN_v4.1_implementation_plan.md` is the product plan under a different name; `docs/plan` should carry the three plans with their real titles and a one-line index.
- README says "Linux pending" and "macOS arm64 is the proven platform"; the plan makes both first-class — the second machine's §26 rows are the gap.
- `CLAUDE.md` still describes two streams with named owners; the repo is now one operator plus agents.
- `DECISIONS.md` #8 (standing approval for external effects during the build) must expire at R2 exit as it says; it should not survive into daily use.
- `docs/known-limits.md` is stale (`mec slot probe` Claude-only; "OpenCode in progress" in the README layout table) relative to `STATUS.md`.
- CONTRACTS §9's promised artifacts (`conformance.spec.ts`, `providers/<provider>/` bodies, `slots/reserve-race.json`, `mec-devtools record`) were partly delivered under other names; the doc should say where each lives.

## What the public clone reveals about process

- 52 commits, almost all direct to `main` with no PR; CODEOWNERS names two reviewers but the cross-review rule in CONTRIBUTING was not exercised. For a public repo, branch protection on `main` with required CI and one review is the minimum (see `02_PUBLIC_REPO_REVIEW.md`).
- Commit messages are excellent as records and too long as messages (several exceed 600 characters on the subject line). Move the narrative to the PR body / `docs/log`.
- The fixture library and `docs/engines.md` are the most valuable artefacts in the repo for anyone else building on these engines; they deserve a prominent place in the README.

## Priority order for the next two weeks

1. The model-tier layer and the real planner (items 4 and 5 of your request, `03_MODEL_TIERS_AND_PLANNER.md`) — this is the product's core and the plan's §6/§7/§16 are not yet real.
2. The workbench redesign (item 6, `05_UI_DESIGN_SPEC.md`) — because the inbox and chat are where the attention rule lives, and today they cannot show a plan, a question or evidence.
3. Public-repo hygiene (item 2, `02_PUBLIC_REPO_REVIEW.md`) — a day of work, mostly files.
4. Linux §26 rows and the natural-capture fixtures, then R1.11 (the owner's week) on the real product.
