# Full UI and UX overhaul — proposed design amendment

5 November 2026. Design only; no production UI has changed. The owner rejected the modest earlier preview and requested Apple-like finesse. This replaces the earlier plan's preserve-the-prototype aesthetic constraint with a full visual system and journey redesign. It does not amend the shipped product spec before approval.

## Direction

A calm engineering workspace with the craft of a good Mac application: carefully aligned hierarchy, generous but useful whitespace, fine separators, excellent text, restrained controls and coherent interaction. The work is the focus. No imitation traffic-light window controls or claims that this browser UI is native. No marketing hero, metrics dashboard, gradients, sparkles, avatars or repeated card grid.

The four confirmed product choices remain: per-repository meta conversations/history; autonomous local planning/run but ask before push/PR/merge; tested PR ready for review with merge separate; builder failing/passing checks and mutants with one blockers-only sensitive review and preserved required human reviews.

## Token system and layout

- **Light:** canvas `#f7f8fa`, rail `#f0f2f5`, surface `#ffffff`, ink `#20252d`, secondary `#626b78`, hairline `#e1e5eb`, selection `#e2e7ed`. Amber `#80520b` on `#fff4dc` only where owner attention is needed.
- **Dark parity:** canvas `#171a20`, rail `#1d2128`, surface `#20252d`, ink `#edf0f5`, secondary `#a4adba`, line `#333a45`, selection `#343d49`; amber text `#edc677` on `#3a3020`. Explicit tokens, never a filter.
- **Type:** system stack `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`; 12/13/14/15/18/22px, body 14/1.55, semibold 600; title tracking -0.025em. Mono only commands, file content and SHA. This deliberately proposes replacing Instrument Sans for native-feeling text; no font/network request.
- **Rhythm:** 8px structure, 4px optical adjustments; 216px rail; 64px toolbar; content 680px conversation measure; 336px inspector. Controls radius 8, document groups 12, sheets 16. Borders carry grouping; depth only inspector/overlays. No shadow on routine cards.
- **Alignment:** common left edge for header, message text, plan and composer. State/action belongs opposite its subject, never scattered across chips. Secondary text stays readable; no tiny uppercase labels.

```text
Repository sidebar | Context toolbar                         | Inspector
Repository switch  | Conversation / Work / Needs you          | Task / evidence
Primary navigation | User request                           | Overview / checks
Recent work        | Meta acknowledgement and delivery plan | Activity / diff
                   | Quiet progress + next step             | Provenance
Connections/setup  | Scoped composer anchored to conversation| Return to conversation
```

## Information architecture and journeys

1. **Conversation:** repository name is always visible. A short user request, outcome acknowledgement, readable task plan and restrained progress. The current request title leads; Conversation remains the route label. Routine validation uses builder/repository checks, not an implied mandatory second reviewer. Composer names New request or follow-up intent. Inspect work opens evidence; it never routes the user into specialist chat. Persist per-repo drafts and explicit Clear intent as proposed.
2. **Work:** delivery list with recognizable goal, actual stage, current reason and next step; selected delivery expands task dependencies and real agent assignments. Inspector provides task/attempt evidence. Separate local complete, waiting for push/PR, PR ready and merged.
3. **Needs you:** exact action/evidence/cost of approve or deny, with repo/branch/head/checks and expiration. First click arms the exact effect, second confirms; any unrelated action/Escape or 8s disarms. Retain resolved and expired states; a question has actual answer choices/free-text target. Amber appears here, not on normal navigation.
4. **Connections (Slots):** one orderly row per configured capacity, readable health and honest usage. Add connection offers existing login/dedicated/API path appropriate to engine. Owner enters credentials. Replace/retire explain affected work and irreversible consequence; unavailable capability is explicit.
5. **Setup:** five-stage readiness, actual prerequisites and resume behavior. Engine detection → connection → repo/check profile → meta slot → first request. A skipped step is not done. Reuse Connection/Repository forms.
6. **Settings:** Policy, Prompts, Models, Repositories, Backups. Editor list/detail layout with durable revision/provenance, actual compare and one contextual save bar. Unsaved/stale/error keeps draft; global navigation remains usable. Proposed policy changes require explicit apply.

**Inspector:** title and role first; meaningful current step, requested tier versus actual model/engine/connection and last activity; source-linked evidence tabs Overview, Checks, Activity, Diff. Hidden identifiers in technical detail only. Close restores opener focus. Settings, Setup and Connections automatically hide the work inspector and its irrelevant toolbar action; returning to Conversation/Work restores the task selection and prior open/closed preference. Needs you enters without a stale task inspector: Inspect checks opens approval-bound evidence for the card’s exact tested commit, with its own title/context. Switching task/approval scope resets to Overview; an in-progress task shows checks not run yet and never inherits the approval card’s passed-check evidence. On narrow screens a modal sheet traps focus, Escape closes, and the originating row remains selected.

**Global controls:** repository switch, command palette, search, theme and navigation have a predictable scope. Cmd/Ctrl+K opens routes/actions; Escape closes topmost surface; slash focuses composer. Work/question/approval keyboard commands remain in final implementation. Sidebar becomes a drawer at mobile width.

## States and wording

Every action has target/preconditions, pending feedback, actual completion, recoverable error, cancel/return and reload/reconnect behavior. No perpetual loading. Empty invites one useful action; blocked names what is needed; failure keeps content with retry; completed names the delivered artifact and pending external authority. Unknown usage says No reading yet. Do not equate healthy server with progress or clean process exit with tested work.

The standalone `ui-overhaul-preview.html` is a design artifact with synthetic sample data and simulated local-only interaction. It has six selectable surfaces; repository switch; theme; inspector tabs/focus return; global commands; state examples; simulated two-step approval with disarm. It never fetches, sends coding requests or accesses live state. Typing/submitting only demonstrates a local sample acknowledgement, never implies real work.

## Approval and implementation sequence

Review the full screen preview before production implementation. After design approval, record the amendment to the design system/component API: new tokens, typography, sidebar, toolbar, message/task/approval groups, inspector, sheets and responsive rules. Preserve behavior constraints, privacy and authority. Prior prototype screenshots cease to be acceptance targets only after approval.

Build the new shell/tokens/components and all honest states behind a default-disabled local UI flag in parallel with M1 identity/transport work. No unfinished live backend path is advertised. Connect repo conversation/intent after M1; real plan/task/evidence after M2/M3; migrate all six surfaces and remove old presentation only after separate verification. Runtime correctness is still prerequisite to real delivery claims. No generic framework migration or unrelated dependency upgrades.

## Measurable acceptance

- At 1440px: balanced 216px rail, readable central conversation, 336px inspector without cramped task rows. At 1024px: conversation remains readable, inspector can overlay; no clipped action. At 390px: navigation drawer and inspector sheet, no horizontal page scroll, composer/actions remain reachable.
- Light/dark screenshots for all six surfaces plus inspector/sheets and empty/working/blocked/error/completed/resolved/expired examples; compare typography, rhythm and hierarchy with approved preview, not the superseded scaffold.
- Text contrast ≥4.5:1; large text ≥3:1; control/focus contrast ≥3:1; body ≥14px, secondary ≥12px; primary controls ≥40px high and target areas ≥44px mobile; secondary desktop targets ≥32px; visible 2px focus ring. No screenshot-only accessibility claim.
- Axe no violations and Lighthouse accessibility ≥95 per route; semantic headings/lists/tabs/dialogs and announced errors; complete keyboard journey and return focus; reduced motion has no nonessential animation. User-triggered motion ≤160ms.
- Actual server-contract, repo scoping, draft/retry, task/evidence and approval safety tests pass independently of visuals; separate verifier exercises packaged app. Fake data stays confined to prototype/tests, never live fallback.

No implementation or release is authorized by this design record. Source analysis, prototype construction and later measured product behavior remain distinct.
