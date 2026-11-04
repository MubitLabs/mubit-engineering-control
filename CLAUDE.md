# MEC v4.1

Five rules for any contributor or agent working in this repository. `AGENTS.md` is the full
guide (commands, navigation, non-negotiables); these are the five that survive context
compaction.

1. **Areas.** `packages/contracts` — the frozen seam (rule 2). Core and workflow:
   `packages/domain`, `packages/store`, `packages/mec-tools`, `packages/policy`,
   `packages/prompts`, `packages/meta`, `packages/integration`, the `apps/web` chat/inbox/work
   views. Engines, slots and runtime: `packages/engines`, `packages/slots`, `packages/runtime`,
   `packages/git`, `apps/desktop`, the `apps/web` slots and wizard views, and every file under
   `packages/testkit/fixtures`. Cross-cutting: `packages/scorecards`, `packages/failover`.
2. **Contracts are frozen** (tag `contracts-v0`). A change in `packages/contracts` needs the
   matching fixture update and a line in `docs/handoff/CONTRACTS.md` §10. Additive changes (a
   new optional field, a new pattern) are the safe direction.
3. **The spec decides behaviour.** `docs/plan/PLAN_v4.1_local_meta_agent.md`. When behaviour is
   unclear, cite the section number and ask — never guess, never invent a standard to fill a
   template. The §26 evidence matrix lives in `docs/fault-suite.md`.
4. **Never touch a credential.** Never read a vendor OAuth store or a key file
   (`~/.claude/.credentials.json`, `~/.codex/auth.json`, anything under a slot home's `keys/`),
   and never write a credential anywhere. Keys enter only through the workbench Slots form /
   the keystore API, and code reads them only via `SlotKeystore.read()` at launch.
5. **Fixtures stay honest.** `recorded_by: 'real'` only for a real binary that actually ran;
   synthetic stays synthetic, with the reason noted in its `meta.json`.

@AGENTS.md
