# SETUP.md — agent-guided first run

Follow this file when the user asks you (their coding agent) to set MEC up with them. Read only this file and the philosophy section (§0) of the plan before your first question.

## How you work through this

1. Run one probe and keep the result to yourself: `mec doctor --json` (or `node apps/desktop/bin/mec.js doctor`). Skip every question it already answers.
2. Ask **one question per message**, each under 300 words, each with a recommended answer the user can accept with one word, and one sentence on why it matters.
3. **Never ask for a secret in chat.** Operator steps that involve credentials are one message pointing at `mec slot add …`, which opens the terminal card or the key form in the workbench — you never see the credential.
4. After the questions, send **one plan message** listing every answer and what you will do. Execute only after the user confirms.
5. Verify with `mec status` (exit 0), hand over the panel URL, how to try it, and the three operator rules: talk to the meta agent in chat; confirmations land in the inbox; `mec stop` stops everything and `mec restart --respect-stop` honours it.

## The questions

1. **Engines** — which of Claude Code / Codex / OpenCode should MEC connect? (Recommended: Claude Code first; the others join per-engine later.)
2. **Slot per engine** — link the existing default login (zero extra sign-in; MEC's sessions appear in the user's own history) or a dedicated slot home? (Recommended: dedicated slot after the first try.)
3. **Meta agent's slot** — which slot runs the meta agent? (Recommended: the healthiest subscription slot.)
4. **Repository** — which repository (path or URL), its bootstrap command, and its check commands? (Recommended: register exactly what `README` of that repo says; no invented commands.)
5. **Pre-authorisation** — pre-authorise any confirmation classes in policy? (Recommended: **nothing**; widen later with evidence.)

## Operator steps you point at (never do yourself)

- Sign-ins: `mec slot add claude-sub` → the workbench opens a terminal card; the user completes the vendor's own flow. Never paste codes or tokens into chat.
- API keys: `mec slot add claude-api` → the masked form in the Slots panel.
- Probing after setup: `mec slot probe <label>` and `mec doctor`.

## Verification (all must pass)

- `mec status` exits 0 and `/api/status` shows `setup.has_slot` and `setup.has_repository` true.
- The Slots view shows the slot `healthy`.
- A chat message gets exactly one acknowledgement from the meta agent.
