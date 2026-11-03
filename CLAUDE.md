# MEC v4.1

Two streams work in this repo in parallel. Read docs/handoff/KICKOFF.md §3 before editing anything.

Stream A (core and workflow) owns: packages/domain, packages/effects, packages/mec-tools,
packages/policy, packages/prompts, the store, and the apps/web shell, chat, inbox and work views.
Its brief is docs/handoff/STREAM_A.md.

Stream B (engines, slots and runtime) owns: packages/runtime, packages/engines, packages/slots,
packages/git (except merge.ts, conflict.ts and impact.ts), apps/desktop, the apps/web Slots view,
terminal cards and wizard, and every file under packages/testkit/fixtures.
Its brief is docs/handoff/STREAM_B.md.

packages/contracts is shared: a change needs both reviewers and a fixture update (docs/handoff/CONTRACTS.md).

The spec is docs/plan/PLAN_v4.1_local_meta_agent.md. When a behaviour is unclear, cite the section and ask; never guess.
Never read a vendor OAuth store, never call an undocumented endpoint with a vendor token, never write a credential anywhere.
