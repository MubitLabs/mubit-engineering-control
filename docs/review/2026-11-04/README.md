# MEC review package — 4 November 2026

Review of `MubitLabs/mubit-engineering-control` at `e5ae484` against the v4.1 plan, with the designs for the three things the request asked for: model tiers and a real planner, modular editable prompts with a setup agent, and the workbench redesign.

| File | What it is | Answers request item |
| --- | --- | --- |
| `01_ALIGNMENT_REVIEW.md` | Code and direction against the plan: what is aligned, what is thin, process findings, priority order | 1 |
| `02_PUBLIC_REPO_REVIEW.md` | Public-repository findings (must / should / nice) and the one-command install with the code changes it needs | 2, 3 |
| `03_MODEL_TIERS_AND_PLANNER.md` | The tier ladder, the capability table (`models.yaml`), how a tier becomes engine flags per engine, the specialist subagent policy, the real planner's context and tools, prompts on disk, the setup agent, an implementation plan | 4, 5 |
| `04_UI_DESIGN_SPEC.md` | Principles, tokens, information architecture, journeys, screens and states, component inventory, port plan, acceptance | 6 |
| `prototype/` | The clickable workbench prototype: `index.html`, `tokens.css`, `workbench.css`, `workbench.js` | 6 |
| `screens/` | Screenshots of every screen, light and dark, desktop and phone | 6 |
| `PROMPT_FOR_CLAUDE_CODE.md` | What to paste into the repo's Claude Code instance to carry this out | — |

Suggested place in the repository: `docs/review/2026-11-04/` for the four documents, `docs/design/` for the prototype and screens (the prototype's two stylesheets move to `apps/web/src/` when the port starts).
