# MEC v4.1 — Hand-off kit

Four files, meant to be given to a person or a coding agent together with the plan:

| File | Who reads it | What it is |
| --- | --- | --- |
| `PLAN_v4.1_local_meta_agent.md` | both | the spec; every behaviour question is answered from it |
| `KICKOFF.md` (this file) | both | how to start, the rules, the handshakes, the prompts to paste |
| `CONTRACTS.md` | both | the `packages/contracts` v0 spec; written once in the first three days, then frozen |
| `STREAM_A.md` | the person on Stream A | self-contained brief: core and workflow |
| `STREAM_B.md` | the person on Stream B | self-contained brief: engines, slots and runtime |

`PLAN_v4.1_parallel_split.md` is the rationale for the split; it is not needed to work.

## 1. Before anyone starts

1. **Pick streams.** A = core and workflow (domain modelling, state machines, chat UI). B = engines, slots and runtime (process supervision, OAuth and CLI quirks, sandboxes, wire protocols). Decide once; the contracts PR comes from A and is reviewed by B.
2. **Repository.** A creates the monorepo on day 1 morning (pnpm, Biome, Vitest, TypeScript strict, CI running both test suites, `CODEOWNERS` from §2 of the split). B clones at noon. Trunk-based; branches live less than two days.
3. **v1 access.** Both agents need read access to `mubit-engineering-control@version-1`: the domain rules, journal protocol, Claude adapter and testkit are ports, not rewrites.
4. **Machines.** One macOS and one Linux machine between you (the Claude Code sandbox differs: Seatbelt vs bubblewrap + socat). Node 22 LTS or 24, pnpm, git ≥ 2.32, `gh` signed in as yourself.
5. **For B's machine:** Claude Code 2.1.31x, Codex CLI 0.166.x and OpenCode V2 2.2.x installed; one Claude subscription login available to create slots with; a second Claude login, a GLM Coding Plan key and a Gemini key available by week 4 (H2) and week 8 (H5).
6. **A GitHub test repository** with CI, for H3 (week 6–7).

## 2. The first three days (together)

Day 1: A pushes the skeleton; both read the plan's §5, §6, §8, §9, §10, §17 and `CONTRACTS.md`. A opens the contracts PR from `CONTRACTS.md` §1–§3 (events, briefs, reports, bridge).
Day 2: A adds §4–§6 (adapter, runtime, slots, core facts); B reviews against the installed engines and the v1 adapter; B records the first fixture (`claude/<version>/smoke.jsonl`) so the fixture format is proven with real data.
Day 3: A adds §7–§9 (store, effects, health, errors, fixtures); both run the empty conformance suite; tag `contracts-v0`; the streams diverge.

A contract change after the tag is a PR with both reviewers, a fixture update and a line in `CONTRACTS.md` §10.

## 3. Rules of engagement

1. Work only in your stream's packages (ownership map in `STREAM_A.md` §2 / `STREAM_B.md` §2). What you need from the other stream is a stub behind the contract, never an implementation.
2. The plan is the spec. When a behaviour is unclear, cite the plan section and ask; do not guess. A change to the plan is a PR from A with B's review, and the §26 table changes in the same PR.
3. One fixture library (`packages/testkit/fixtures`). B records redacted real-engine streams; A replays them. A scenario that breaks one suite breaks both.
4. Owner review across the seam within one working day. No cross-stream edits without it.
5. Feature flags only tests set: `MEC_FAKE_ENGINE`, `MEC_FAKE_SLOTS`, `MEC_SKIP_SANDBOX`.
6. Secrets never enter the repo: the fixture recorder redacts before writing; the compliance guard runs in CI from week 3.
7. One line a day in `docs/log/<week>.md` on what changed at the seam. Thirty minutes at each handshake, with the demo, not a status meeting.
8. Rebalance only at a handshake, by moving one whole movable item (scorecards, retention, `SETUP.md`, the agent-graph view, docs).

## 4. Handshakes

| Handshake | Week | Demo | Driver |
| --- | --- | --- | --- |
| **H0 contracts frozen** | end of day 3 | `pnpm check` green with both empty suites; tag `contracts-v0`; first real fixture recorded | both |
| **H1 one attempt end to end** | 2 (mid-3 at worst) | `MEC_FAKE_CLI=1`: a scripted brief → A's effects queue → B's runtime + Claude adapter on the fake CLI → journal → store → checks on a pinned base; a `permission_request` reaches A's bridge and returns; a `rate_limit` fixture parks the attempt | B |
| **H2 real request via chat** | 4–5 | two real Claude slots created through the login card; a message in chat → acknowledgement → plan card → specialists → reports and a question back in chat; a `claude-api` slot added by pasting a key | A |
| **H3 §23 on a real GitHub repo** | 6–7 | integration queue, PR via `gh`, confirmation cards, isolation profiles proven on macOS and Linux | A |
| **H4 fault suite + Codex** | 8 | the plan's §26 table green on fake CLIs; Codex slot signs in; mixed-engine delivery; backup and restore drill | both |
| **H5 full acceptance** | 9 | OpenCode slots on GLM and Gemini; four configurations; one `npx` install; first run without docs; `SETUP.md` driven by a coding agent | B |

Record each handshake in `docs/log/HANDSHAKES.md`: what ran, what was stubbed, what moved.

## 5. Prompts to paste into a coding agent

Attach `PLAN_v4.1_local_meta_agent.md`, `CONTRACTS.md`, `KICKOFF.md` and the stream file. Replace the bracketed values.

**Stream A**

> You are implementing Stream A (core and workflow) of MEC v4.1. Read PLAN_v4.1_local_meta_agent.md (the spec), CONTRACTS.md (the shared interfaces) and STREAM_A.md (your brief), then KICKOFF.md §3 for the rules. The repository is at [path]; the v1 codebase to port from is at [path]. Start with the contracts PR exactly as CONTRACTS.md specifies and stop for review before going further. Then follow STREAM_A.md §4 in order: for each item, implement it inside the packages STREAM_A.md §2 assigns to this stream, stub anything from Stream B behind the contract, make the item's definition-of-done tests pass, and report what landed and what is stubbed. When a behaviour is unclear, cite the plan section and ask instead of guessing. Never touch packages/runtime, packages/engines, packages/slots or apps/desktop.

**Stream B**

> You are implementing Stream B (engines, slots and runtime) of MEC v4.1. Read PLAN_v4.1_local_meta_agent.md (the spec, especially §5, §8, §9, §20, §21, §22), CONTRACTS.md (the shared interfaces) and STREAM_B.md (your brief), then KICKOFF.md §3 for the rules. The repository is at [path]; the v1 codebase to port from is at [path]. Claude Code, Codex and OpenCode are installed on this machine. Start with STREAM_B.md §3 (machine pre-flight and the first fixture) while Stream A's contracts PR is in review; review that PR against the real engines. Then follow STREAM_B.md §4 in order: implement each item inside the packages STREAM_B.md §2 assigns to this stream, stub anything from Stream A behind the contract, make the item's definition-of-done tests pass, and report what landed and what is stubbed. Record every real-engine stream as a redacted fixture before relying on it. Never read a vendor OAuth store, never log a credential, and never touch packages/domain, packages/effects, packages/mec-tools, packages/policy or packages/prompts.
