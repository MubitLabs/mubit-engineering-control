# MEC workbench — design specification

> Superseded, 6 November 2026. This described the classic shell, removed in `docs/changes/2026-11-06-remove-classic-shell/CHANGE.md`. The design now lives in `docs/plan/spec.md` §18 and `apps/web/src/next/tokens.css`. Kept as history. Its rule that no runtime font or asset request leaves the machine still holds (§10 below).

Item 6 of the 4 November request. The clickable prototype in `prototype/` (open `index.html`) is the reference; `tokens.css` and `workbench.css` are drop-in stylesheets for `apps/web`; the screenshots in `screens/` show every screen in light and dark. This document says what the prototype is for, the rules behind it, and how to port it.

## 1. What the current UI gets wrong, in one paragraph

`apps/web` today is a 1,900-line scaffold: six colours, 13px type, 2px radii, dark only, uppercase mono labels everywhere, every chat message rendered identically, the inbox card showing an operation hash as "evidence", no work-item page, an empty Settings view, 3–5 s polling instead of the SSE feed the server already has, and browser-default focus. None of that is a bug; it is the absence of a design. The product's own philosophy — spend the user's attention only where a person must act — had no visual expression, so the screen that matters most (a confirmation) looked like every other screen.

## 2. Design principles (Apple's clarity, deference and depth, applied to this product)

1. **Colour is attention.** One caution colour (amber, the control-room convention for "needs the operator") appears only on things waiting for the person: the Needs-you tray, a slot that needs a sign-in, a state label that says "waiting on you". Green and red are status markers, never surfaces. A healthy screen has no colour in it. Primary actions are ink, not brand-coloured, so the amber is never competed with.
2. **Every card answers three questions**: what will happen, why it is being asked, and what happens if I click. The evidence is one gesture away in the context pane; the card itself stays legible at a glance.
3. **Deference.** The conversation and the diff are the interface; chrome is thin lines, spacing and type. No shadows except the one depth level (the context pane and sheets). No decorative motion; motion only answers the person's action and takes ≤160 ms.
4. **Clarity in words.** Sentence case, plain verbs, no all-caps labels, no middle-dot meta strings, no system vocabulary ("CAS", "effects", "mandate") on the surface — "Approve", "Needs your answer", "Waiting for quota (resets 18:40)". Numbers are tabular.
5. **Structure carries meaning.** Cards differ by kind: a decision card has a side column with the action; a question card has choices; a plan is a table; a status update is a quiet line; a notice is a tinted block. The same radius is not applied to everything: controls 6, cards 10, sheets 14.
6. **Honest states.** "No reading yet" rather than 0 %; "Expires in 23 min" counting down; a resolved card fades but stays; empty states are invitations with one action; errors say what happened and what to do.
7. **Forgiveness where the effect is irreversible.** Pushes, PRs and merges use a two-step approval: the first click arms the button and names the effect ("Confirm: push and open PR"); the second performs it; anything else disarms it within eight seconds. Deny is one step and never destructive.
8. **Keyboard is first-class.** `⌘K` commands; `J`/`K` move through decisions; `A`/`D` approve or deny the focused card; `/` focuses the composer; `G` then `N`/`W`/`S`/`C` jumps to a screen; `Esc` closes the context pane, a sheet or an armed approval. Focus is always visible (2 px ink ring, 2 px offset).

## 3. Tokens

See `prototype/tokens.css`. Summary: canvas `#EEF0F2`, surface `#FFFFFF`, ink `#15181E`, muted `#4B525C`/`#78808A`, line `#DADDE2`; amber `#F2B233` on `#FFF4D6` with `#5A3E00` text; green `#2E9E63`, red `#C8362E`, done-grey `#5B6470`. Dark theme mirrors every token (not a filter). Type: Instrument Sans (UI) and Spline Sans Mono (SHAs, commands, diffs only), both OFL and self-hosted under `apps/web/public/fonts` so the app makes no network request; scale 11.5 / 12.5 / 14 / 16 / 19 / 23 / 28 on a minor-third rhythm, body 14/1.5, titles 1.25; weights 400 / 500 / 600. Spacing on a 4 px grid; measure ≤ 68 ch; rail 188 px; context pane 400 px.

## 4. Information architecture

```
Rail: Chat (home) · Needs you (count, amber) · Work (count) · Slots (count if any needs you) · Setup · Settings
      slot health dots · runtime line · theme · ⌘K
Main: one pane per route; a page title that names the thing (the live work item on Chat), one sentence under it
Context pane (right): the evidence for whatever is selected — a decision, a question, a work item, a task, a slot
Sheets: sign-in terminal card, API-key form, command palette
```

Needs-you lives in two places on purpose: as the tray pinned above the conversation (so a decision is never out of sight while you talk), and as its own page (so it has a keyboard home and a full list). Both render the same cards from the same list.

## 5. Journeys

Each journey is what the person sees, in order. "Card" means a decision or question card; "pane" means the context pane.

**First run.** `mec` opens the browser on Setup. Step 1 shows the engines it found and whether each is signed in. Step 2 offers three ways to connect, each with its consequence stated; choosing "dedicated slot" opens the terminal sheet with the vendor's own sign-in and an *Open the sign-in page* button; success returns to the step with the slot shown healthy. Step 3 asks for a repository and proposes bootstrap/check commands it read from the repo for the person to confirm. Step 4 picks the meta agent's slot (default pre-selected). Step 5 is a card with a one-click first request. The rail counts appear as soon as there is something to count. Total: under two minutes, no terminal.

**A request.** The person types in the composer; the message appears with an ink bar; within seconds the acknowledgement appears as a larger sentence; the plan card follows with tasks, roles, tiers, slots and states, and an *Approve plan* in the tray if policy asks. Status lines arrive quietly; a parked slot arrives as a notice block with the reset time and a link to Slots. Nothing animates in; the list grows.

**A question from a specialist.** The tray gains a question card: who asks, the question, two or three choices, "Answer in chat…" as a dashed choice. Picking a choice resolves it in place; the card fades; the specialist continues. The chat gets a one-line record. Nothing waits that did not need to.

**Approval.** The decision card states the operation in words, why now, branch, head SHA, checks on that SHA, findings. *See the diff and checks* opens the pane with consequences of approve and deny, the checks list, each finding with its disposition, the diff summary, and a button to open the full diff in the editor. *Approve* arms; *Confirm: push and open PR* performs; a toast says what happened; the rail count drops. `A` does the same from the keyboard.

**Quota park and switch.** The slot card goes to "Near its window" with the meter; a notice in chat says what moved where under which pairing; Work shows the item under "Waiting" with the reset time and a *Switch slot* link; the switch opens a small sheet naming the target slot and that the same worktree continues.

**Login expired.** The rail's slot dot and the Slots count turn amber; the slot card says "Login expired" and how many attempts wait; *Sign in again* opens the terminal sheet; after the vendor's flow completes the probe runs, the card returns to healthy and the parked attempts resume — the chat gets one line.

**Editing a prompt.** Settings → Prompts lists parts by layer with *edited* and *Default updated* marks; selecting a part shows the editor with its provenance line; typing shows the save bar; *Save as revision n* records it; running attempts keep their revision (the toast says so). *Compare with new default* shows the three-way diff; *Use the new default* replaces the text and keeps the old as a revision.

**Setup changes in chat.** "Make reviewers always use a different provider" → the setup agent proposes a draft; the draft appears as a card in the tray with the diff of the prompt or policy part; *Apply* creates a revision; the chat records it.

## 6. Screens and states

| Screen | Content | States it must render |
| --- | --- | --- |
| Chat | title = live work item (or "Chat" when none), one-sentence status, tools (Details, Hold, Stop), tray, conversation, composer | empty (first message invitation with an example), working, held, stopped, parked, done (result line with PR link and a small scorecard line) |
| Needs you | the same cards, full page, keyboard hints | empty ("Nothing waits for you"), one or many, resolved-but-visible, expired (card greyed, "Expired — the agent was told it was not approved") |
| Work | groups: Needs you, Working, Waiting, Done today; rows with title, one-line reason, state, repo and start time; clicking opens the pane | empty; each stage; a stopped item under Done with "Stopped by you" |
| Work item (pane) | stage, origin, mandate, policy hash, bundle revision, tasks with state/slot/SHA, questions, handoffs, "so far" (attention, elapsed, repairs, credits, spend) | any stage; a held item shows who held it and the release action |
| Task / attempt (pane) | role, tier and resolved model, slot, head, state, report summary, checks, findings, transcript link | queued, running, checks failed, blocked with what remains, dropped with reason |
| Slots | one card per slot: name, state, engine and plan, identity, meter where a reading exists, one honest line where it does not, actions | healthy, near window, parked, login expired, key rejected, engine unsupported (with the version and the fix), retired |
| Setup | five steps in one column; current step expanded | fresh install; partially done; returning to change a step |
| Settings | Policy (editor with validation and the version hash), Prompts (parts, editor, provenance, history), Models (the tier table with vendor words and last probe), Repositories, Backups | each with an empty state that says what the section is for |
| Sheets | terminal sign-in (live output, open-page and paste-code buttons, timeout note), API key (provider, name, masked key, free-tier note), switch slot, command palette | busy, error with the server's reason, success |

## 7. Component inventory and the React port

The prototype's class names are the component API. Port in this order; each component is a file under `apps/web/src/components/` or `views/`.

| Component | Prototype classes | Props |
| --- | --- | --- |
| `Shell` | `.app .rail .main .context` | route, counts, slot health, runtime line |
| `RailItem`, `Count` | `.rail-item .count(.count-attention)` | label, count, attention |
| `PaneHead` | `.pane-head .pane-title .pane-sub .pane-tools` | title, subtitle, tools |
| `Tray`, `DecisionCard`, `QuestionCard` | `.tray .decision .decision-question .choices .choice` | item, onApprove (two-step inside), onDeny, onAnswer, onOpenEvidence |
| `Conversation`, `Message` (user/agent/status/notice), `PlanCard` | `.conversation .msg-* .plan .plan-table` | messages, plan |
| `Composer` | `.composer .chip` | draft, replyTo, onSend; Enter/Shift+Enter; `/` focus |
| `WorkGroup`, `WorkRow` | `.group .rows .row` | items by stage |
| `SlotCard`, `Meter` | `.slot(.slot-attn/.slot-warn) .meter` | slot, actions |
| `Steps`, `Step`, `Option` | `.steps .step .options .option` | steps, current, onContinue |
| `SettingsNav`, `PartList`, `PartEditor`, `SaveBar`, `TierTable` | `.settings-* .parts .part .editor .savebar .tiers` | parts, selected, draft, revisions |
| `ContextPane` | `.context .kv .checks .finding .diff` | selected ref → rendered detail |
| `Sheet`, `TerminalCard`, `KeyForm`, `Palette`, `Toast` | `.sheet .terminal .form .palette .toast` | open, onClose |
| `StateLabel`, `Tier` | `.state(.state-ok/.state-warn/.state-attn/.state-bad/.state-done) .tier` | label, kind |

Behaviour to port from `workbench.js`: routing by hash with counts; the tray collapse; two-step approval with the eight-second disarm; `J`/`K`/`A`/`D`/`/`/`G`-chords/`Esc`; the context pane with focus management; sheets with a scrim and Esc; the palette; theme (auto/light/dark via `data-theme`); toasts. Replace polling with the existing `/api/events` SSE feed (`subscribeEvents`) for chat, inbox, work and slots; keep `/api/status` on a 10 s interval for the runtime line only.

API additions the UI needs (from `03_MODEL_TIERS_AND_PLANNER.md` and the gaps in `01_ALIGNMENT_REVIEW.md`): decision cards with `what`, `why`, `facts`, `consequences`, bound SHA, checks and findings (today the inbox returns `cls`, `operationHash`, `expiresAt`); questions as a card type with options; work-item and task detail endpoints; slot usage readings with `unknown`; prompts and models endpoints; the setup agent's drafts as cards.

## 8. Accessibility and quality floor

Contrast: ink on canvas 15:1, muted ink 6.6:1, amber text on amber surface 7.4:1; amber is never used for text on white. Every interactive element is a button or a link with a visible focus ring; cards that open the pane are focusable and open on Enter. `aria-live="polite"` on the toast and the terminal card; `role="meter"` on usage meters; sheets are `role="dialog"` with `aria-modal` and return focus on close. `prefers-reduced-motion` sets every duration to 0. `prefers-color-scheme` is honoured and can be overridden. Narrow screens: the rail becomes a top bar, the context pane becomes a sheet, keyboard hints hide, decision facts stack. No text is set below 11.5 px.

## 9. What is deliberately absent

No avatars, no icons as the only carrier of meaning, no confetti or success animations, no gradients, no card shadows, no all-caps, no "AI" sparkles, no colour-coded roles, no dashboard tiles with big numbers. The only number set large is the page title's count in the tray, and it is text.

## 10. Acceptance for the port

- The §23 worked example renders as in `screens/chat-light.png` with real data: acknowledgement, plan card with tiers and slots, a question card, a parked-slot notice, a decision card with a two-step approve, the context pane with checks and findings.
- Every §6 state has a story in the Vitest/RTL suite rendering from fixture data, and a screenshot in both themes in CI (Playwright, `apps/web/test/screens.spec.ts`).
- Keyboard-only walkthrough: approve a card, answer a question, open and close the pane, send a message, change theme — no mouse.
- Lighthouse accessibility ≥ 95 on each route; axe reports no violations.
- No runtime font or asset request leaves the machine (`apps/web/public/fonts` self-hosted; CSP `default-src 'self'`).
- Resolved cards stay visible for the session; expired cards say the agent was told it was not approved.
