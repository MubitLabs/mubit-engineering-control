# MEC v4.1

One operator ships this repo now (the two-stream era ended 3 Nov; see docs/log/week1.md). The
ownership map below survives as the file-organization convention.

Stream A (core and workflow) areas: packages/domain, the effects queue (packages/store),
packages/mec-tools, packages/policy, packages/prompts, the store (packages/store),
apps/web shell/chat/inbox/work views.
Stream B (engines, slots, runtime) areas: packages/runtime, packages/engines, packages/slots,
packages/git, apps/desktop, the apps/web Slots view, terminal cards, wizard, and every file under
packages/testkit/fixtures.
New packages added during single-operator mode: packages/meta, packages/integration,
packages/scorecards, packages/failover.

packages/contracts is the frozen seam (tag contracts-v0): a change needs a fixture update and a
line in docs/handoff/CONTRACTS.md §10.

The spec is docs/plan/PLAN_v4.1_local_meta_agent.md. When a behaviour is unclear, cite the section
and ask; never guess. The §26 evidence matrix lives in docs/fault-suite.md.
Never read a vendor OAuth store, never call an undocumented endpoint with a vendor token, never
write a credential anywhere.
