# Verification record — planning only

Date: 5 November 2026. Base checkout: `a102313`. Status: no implementation or release; acceptance pending.

## Evidence obtained

- Coordinator inspected installed workbench through computer/browser use at loopback port 60432. Observed Work titles as internal IDs, persisting work-detail loading, Chat planning with zero tasks, add-slot direct API-key path, Setup navigation/step-count mismatch, Settings full-app crash and console error. These are runtime observations, not reproduced source diagnoses.
- Needs you empty state appeared normal. No planner send, setup Finish, destructive action or credential read was performed. Observed light Chat, dark Work/Slots, slash composer focus, Escape → G/W navigation, Work pane Escape with originating-row focus return, Cmd+K open/Escape close, and restoration of Auto theme. Full theme/keyboard matrix, approvals/questions, quota/auth recovery, real model launch and completion remain unverified. Clear removed the reply chip immediately; it returned after reload, with intended persistence not yet established from the spec. Settings hash navigation alone remained blank; a full reload on Chat restored the shell.
- Tool screenshots were viewed. No image files were saved; this record does not claim screenshot artifacts.
- Read-only `gh api repos/MubitLabs/mubit-engineering-control/branches/main/protection` returned nine strict required checks, no required reviews, required linear history, no force pushes/deletes, and admin enforcement off. `/rulesets` returned an empty list. Repository metadata returned `allow_auto_merge:false`.
- PR #23 read returned merged at `a102313`; its review list contained Copilot COMMENTED. No enforced review bot or merge queue was established.
- Inspected CI/release definitions, Playwright config, package scripts, release-card gates, installer and owner decisions. See CHANGE.md guardrails for exact source locations.

## Not run

No code tests, mutants, builds, screenshots suite, axe, Lighthouse, real-engine canaries, PR checks, release/install, or postdeployment verification were run by this records agent. Historical baseline results do not verify this candidate.

## Execution evidence required

For each approved slice, record candidate SHA, builder/verifier identities, exact commands and outcomes, pre-existing versus new failures, failing-then-passing regression and mutant results, real-store versus mocked evidence, screenshot paths in both themes, keyboard/accessible behavior, flag state, PR/merge and installed version. Verify affected behavior after deployment before dependent work. Keep raw personal traces and credentials out of records.

Planned commands, not results: `pnpm check`; `(cd apps/web && pnpm exec tsc --noEmit)`; `pnpm exec vitest run apps/web apps/desktop`; `(cd apps/web && pnpm test:screens)`; relevant touched-file lint. Accessibility tooling and meaningful mutants need a concrete builder plan; do not invent passing commands for absent tooling. Real-engine tests require the agreed quota/environment and remain separately labelled.
