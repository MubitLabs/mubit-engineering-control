# Overhaul handoff index

Give an agent one row. Every row assumes `00-README.md`. Base gates: **R** `fix/release-cards`, **H** `fix/http-recovery`, **V** `feat/visual-foundation`, **I** `feat/repo-identity`, **E** `fix/effects-double-run`. These five are the coordinator's and are not handoffs. M1.1 is H, M1.2 is I, VF0 is V.

| File | Branch | Start when on `origin/main` | Can run alongside | Size | Review | Engine runs |
| --- | --- | --- | --- | --- | --- | --- |
| `10-m1.4a-authority-fence.md` | `feat/authority-fence` | R H E I | 12, 30 S1, 31 A, 33 A | L | Required | None |
| `11-m1.4b-durable-commands.md` | `feat/durable-commands` | R H E I + 10 | 12, 30 S1, 31 A, 33 A | M | No | Claude 1 |
| `12-m1.3-repo-workspace.md` | `feat/repo-workspace` | R H V I | 10, 11, 20, 30 S1, 31 A, 33 A | L | No | None |
| `20-m2.1-real-specialist-slice.md` | `feat/m2.1-specialist-slice` | R H E I + 10, 11 | 12, 30 S1, 31 A/B, 32, 33 A | L | Required | Claude 3 |
| `21-m2.2-continuing-coordination.md` | `feat/m2.2-coordination` | 20 | 23 B, 30 S1, 31 A/B, 32, 33 A | L | Required (`confirm`, card bridge) | Claude 1 |
| `22-m2.3-acceptance-integration-delivery.md` | `feat/m2.3-delivery` | 21 | 23 B, 30 S1, 31 A/B, 32, 33 A | L | Required (`pushTarget`, card hook) | Claude 1 |
| `23-...` Part A | `feat/m2.4-recovery` | 22 | 30, 31, 32, 33 A | L | Required | Claude 1 |
| `23-...` Part B | `feat/m2.4b-engines` | 20 | 21, 22, 30, 31, 32, 33 A | L | Required | Codex 4, OpenCode 4 |
| `30-m3.1-canonical-inspection.md` S1 | `feat/inspection-queries` | R I | 10, 11, 12, M2, 31 A, 32, 33 A | M | No | None |
| `30-...` S2 | `feat/inspection-live` | 30 S1, 20, 21, 22 | 23, 31, 32, 33 A | L | Required | None |
| `31-m3.2-observable-work-ui.md` A | `feat/work-surfaces` | R H V | Everything but 33 B/C/D | M | No | None |
| `31-...` B | `feat/work-live` | 31 A, 30 S1, 12, 10, 11 | M2, 30 S2, 32, 33 A | M | No | None |
| `31-...` C | `feat/work-evidence` | 31 B, 30 S2 | M2, 32, 33 A | S | No | None |
| `32-m3.3-setup-configuration.md` | `feat/setup-config` | R H V I + 12, 10, 11 | M2, 30, 31, 33 A | L | Required | None |
| `32-...` Stage B | `feat/recovery-controls` | 32, 31 B, 23 A | 30, 31 C, 33 A | S | No | None |
| `33-m3.4-accessibility-local-release.md` A | `feat/a11y-runner` | V R | Everything but 33 B/C/D | S | No | None |
| `33-...` B | `feat/next-default` | All of the above enabled for the release; exact list in the file | Nothing | L | No | Claude 3, Codex 1, OpenCode 1 |
| `33-...` C | `chore/remove-classic-shell` | 33 B released and verified installed | Nothing | M | No | None |
| `33-...` D | `chore/version-<version>` | Coordinator asks, before each tag | Nothing | S | No | None |

**Budget (#18, cap 10 per engine):** Claude 1+3+1+1+1+3 = **10, none spare**. Codex 5. OpenCode 5. This counts one bounded request as one run per engine involved. If the owner counts processes, Claude doesn't fit (`20`, open question 3).

## What can start now

**Nothing, today.** `origin/main` is `a102313`, and none of the five base branches is on it. All five are unpushed. R merges first.

Once all five land, five handoffs can start at once, on nearly disjoint files: **10, 12, 30 S1, 31 A, 33 A**. Partial landings open these earlier:

| On `origin/main` | Opens |
| --- | --- |
| R, V | 33 A |
| R, I | 30 S1 |
| R, H, V | 31 A |
| R, H, V, I | 12 |
| R, H, E, I | 10 |

## After M1 merges

M1 is 10, 11 and 12. Then **20, 32 and 31 B** (31 B also needs 30 S1 and 31 A) can start together, beside anything still running from the first group. 31 B and 32 share `live/workspace.tsx` by route entry, and `shell.css` by append.

After 20 merges, **21 and 23 Part B** run together. 23 Part B is the only real break in the M2 chain.

## Strict sequences

- **Core, the critical path:** 10 → 11 → 20 → 21 → 22 → 23 Part A. Six PRs, one at a time, five of them L. Each edits the same blocks of `packages/meta/src/service.ts`, `apps/desktop/src/composition.ts` or `packages/runtime/src/attempt-runner.ts`. More agents won't shorten this.
- **Inspection:** 30 S1 → 22 → 30 S2.
- **Work UI:** 31 A → 31 B → 31 C, with 31 C also behind 30 S2. If 30 S2 is merged before 31 B starts, 31 C folds into 31 B.
- **Setup:** 12, 10, 11 → 32 → 32 Stage B, which also needs 23 Part A and 31 B.
- **Release:** everything enabled → 33 B → release → installed verification → 33 C. 33 D before each tag.

**How parallel this really is.** Peak is about five agents, during the first group and again while 20 runs beside 12, 32, 31 B and 30 S1. The core chain sets the finish date, and everything else is either a side lane or waits for it at 33 B. Parallel branches still land one at a time through the coordinator. `apps/desktop/src/server.ts` is edited by 10, 11, 12, 22, 23 A, 30, 32, and `docs/reference.md` by most of them, so expect rebases. 11 and 12 both edit the chat route, and 10 and 12 both edit the `GET /api/work` row: whichever lands second rebases by hand.

## Starter prompt

Replace `<file>` with the file, and name the part for a multi-stage file.

```text
Read docs/changes/2026-11-05-meta-agent-journeys/handoffs/00-README.md, then <file>, in /Users/shankhadutta/code/mubit-engineering-control. Do exactly that handoff and report in the format the README gives.
```
