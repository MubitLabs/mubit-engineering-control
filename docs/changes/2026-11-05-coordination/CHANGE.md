# M2.2: Continuing coordination

Handoff: `docs/changes/2026-11-05-meta-agent-journeys/handoffs/21-m2.2-continuing-coordination.md`. Base: `feat/m2.1-specialist-slice`, a local branch, by coordinator waiver.

## What it does

A multi-task plan runs to its end with no second message. Each next wave dispatches when its dependencies and capacity allow, on a slot and model that satisfy the request. A failed prerequisite blocks its dependents with a reason. A follow-up on running work reaches the owning specialist unchanged, with a receipt that says only what happened. A report wakes the meta agent only when §6 says so.

## Design

- **`schedulePass` (`packages/meta/src/scheduler.ts`)** is the one function plan commit, lift and the 2 s timer use. It runs inside `atomic`, reads persisted state, and stops at once while paused. For each open work item it settles finished attempts, then places what is ready through `planDispatches`.
- **Capacity.** `queued` occupies, so a second pass sees the claim. A queued attempt whose launch row gave up holds nothing, and neither does a `work_complete` attempt with a `checks_note`: no verdict is coming, and M2.1 leaves it there on a repo with no checks.
- **Placement.** A pin (`slotHint.slotId`) is a hard match. A model request must pass `resolveModel` on the slot and not be marked `unavailable`. Nothing unavailable becomes a default; the task defers with `model_unavailable`. The attempt carries `placement`, `resolved_model`, `effort` and `tier_degraded` before its launch row runs.
- **`acceptRoutine`** is the interim rule M2.3 replaces (#32): an attempt that `succeeded` accepts its task. `attemptsLeft` is 0 until M2.3's bounded repair, because §11 offers a retry to a person, never as a loop.
- **`FollowUps` (`packages/meta/src/followups.ts`)** owns ownership, receipts, wakes from reports, notes, questions and specialist cards. Everything is store state, so a restarted instance knows what the last one knew.
- **Receipts** live on the message doc. `ReceiptLadder` is hydrated per message and written through.
- **Cards.** `decideOperation` in `specialist-tools.ts` is the one rule behind `confirm` and the in-process bridge. A dependency install or migration generation opens a card, or passes on policy's pre-authorisation, and waits. An always-confirm class stays denied. Expiry goes through the same compare-and-set as an answer. No specialist tool settles anything.

- **Settling.** A pass also reads what an attempt said. An attempt that ran out of its wall clock is a failure. `stop_requested` and `server_closing` are not: stopped work is fenced, and restart is M2.4. On an attempt that finished, a last report of `failed` or `blocked` blocks the task with the report's summary, and `dropped` cancels it with `cancelledReason` (`TASK_MACHINE` has no `dropped` state). This reads #32 as covering work that says it is done, and it runs on a no-checks attempt too, or a `failed` report there would never reach anyone.

## Stream input on Claude (decision #30)

The objective goes on stdin as the first user message, as §9 writes the argv: `claude -p --verbose --output-format stream-json --input-format stream-json --replay-user-messages`. The attempt launcher asks for this; a planner turn stays one-shot with its prompt on argv.

Probed on `claude` 2.1.318 (the installed binary; `docs/engines.md` pins 2.1.317) against a local HTTP stub of the API, with a scratch `HOME` and `CLAUDE_CONFIG_DIR` and a dummy key, so no request reached a vendor and no run was spent:

- `system/init` comes only after the first stdin line, and again at every turn. The parser now emits `session_started` once.
- Every stdin line gets `command_lifecycle` lines keyed by the line's own `uuid`: `queued` at once, `started` when its turn begins, `completed` after its `result`.
- A message written mid-turn waits for the next turn, with its own `result`. The stub had no tool calls, so whether a message can join a turn between tool calls is unobserved.
- `isReplay` user lines carry the same `uuid`, but only arrive with the turn's response.
- The process stays up after a `result` until stdin closes, then exits 0. A message queued before the close is still processed.

A follow-up's line has two text blocks. The first is the person's words, unchanged. The second names its input id and message id, the only way an engine learns them, so `handled_inputs` and `handback` can be reached at all. An input with no message (an answer, a card note) stays plain text, because it has nothing to hand back.

So `send` resolves on `queued`, or the replay on a version without lifecycle lines, and fails by name after 10 s. That is `delivered`. `read` is the turn that carried the input ending, or a report naming it in `handled_inputs`. A plain report in the same turn is not evidence: the message may still be waiting for its turn. Stdin closes when every line has `completed`, or at once after a result that did not complete.

## Decisions taken inside the handoff

- **A reference-less message stays conversation.** Requirement 12 names `#noteConversation`, but it has no reference to find an owner by, and §12.1 says similarity never binds. It stays context for the next turn, which the planner's conversation section already carries. `intent: 'follow_up'` needs a reference (400 otherwise).
- **A follow-up with nothing running gets a planner turn.** §6 says a user message wakes. `packages/meta/test/service.test.ts` "attach" changed for this: one `relay` row where there was none.
- **Ownership is enforced on wake turns.** A follow-up never reaches the planner while owned, so the guard covers what another wake might do: a route on the message, a replan or a spawn on that work. A stop passes the guard and is refused on a wake turn as before, because a stop is the user's.
- **A released message on ended work becomes a note.** A wake never creates work, and a stop is final.
- **`/api/work` gained `blockedReason`.** The handoff lists `server.ts` as untouched, but its verifier step 2 reads the reason from there, and the extra scope already edits that file. The resolve route answers `continues: true` when a running specialist gets the answer.
- **The real planner now carries `model_request` and `slot_hint`.** `planFromToolArgs` kept four fields, so placement rules would never have seen a real planner's request. Beyond the handoff's `basePolicy` line, and needed for requirement 6 to mean anything.
- **`note` rows and `notesSeenAt`.** A note is stored by the `note` handler and read by `plannerContextFromStore` until the next committed turn. `notesSeenAt` is one field on the work doc.
- **`deliver` before `launch`.** `EFFECT_KINDS` order is the order a pass starts kinds. `planDispatches` holds the last free unit while a delivery can go.
- **Cards reuse.** The same operation on the same attempt reuses a pending or settled card. A denied ask stays denied for that attempt (§12.6).

## Extra scope

1. `shiftWaiting` moves only deadlines still ahead. A row written during a pause, or due during it, is due at resume, so a backoff that fell due in the pause no longer waits out its remainder. §20's "deadlines move later" holds for what is still ahead.
2. Approving a non-release card with no evidence answers `422 no_evidence`. `cardDetail` now reads the same way: empty evidence serves no detail, even with operation fields, so the route and the workbench cannot disagree.
3. `#persistExtras` redacts questions, cards, routes and reports, field names included, before any write. `cardDetail` redacts labels and the class for rows stored before this.
4. The toast says what the server says. `continues: true` gives "the agent was told to continue"; otherwise "Approved. Your approval is on record; nothing runs from this click."

## Found by the verifier, fixed here

1. A follow-up the specialist acted on was released as unhandled, and a real planner planned the work again: nothing told the engine the ids. The second content block, the role prompts and the `report` description now do. A report can beat the delivery commit, so `#handled` keeps it as `handled_early` until `#delivered` lands.
2. A wall-clock stop left its task `active` and its dependents waiting with no reason.
3. A specialist reporting `failed` or `blocked`, then exiting 0, was accepted and its dependent ran.
4. A specialist's question card said "asked by the planner this turn" and dropped its evidence. `GET /api/questions` now names the attempt and serves `evidence.evidenceRef`.

## Found by the second verifier, fixed here

1. On a repository with no checks, a follow-up stayed owned by a stopped attempt and `guardTurn` stripped every later plan on that work. `FollowUps.sweep` now reads `noVerdict`, shared from `authority.ts`, the same test the scheduler uses: handled messages settle and unhandled ones release.
2. A planner-set wall clock was ignored. Plans store `wallClockMs` and `attempt-launch.ts` read `wall_clock_ms`, so every plan got the 30-minute default. It reads `wallClockMs` first, with `wall_clock_ms` as the fallback for seeded rows. This is its own commit, because the file came with M2.1 and the bug is not M2.2's.

## Found by the third verifier and the M2.1 review, fixed here

- **A wall clock during a repo check left the task in `awaiting_review` with no reason.** The timer stays armed through the checks, and a stop there takes `checksSkipped`, not `attemptInterrupted`, so `failure()` found nothing and the dependent waited for ever. The stop reason is now `checks_stopped` on the attempt. `failure()` reads that field, never the note, and only `wall_clock` is a failure: a stop or a close stays fenced.
- **`confirm` allowed a hard link to `.git`.** A leaf with the inode of `.git` or of anything under `.mec` is denied as MEC's, and any other leaf with a second name is denied, because the write lands on a name the rule cannot see. A `node_modules` file hard-linked from pnpm's store is denied by this, and writing through one would have changed the store.
- **The planner on a linked slot had no explicit mode.** `permission_mode: 'none'` passed no `--permission-mode`, so a user's `defaultMode` applied, and `--setting-sources user` keeps their allow rules. The spec line is §6, "What the meta agent does not do", not §4. A prompt-free run now passes `--permission-mode default` and denies the shell, the writers, the network tools and subagents with `--disallowedTools`, because a deny beats an allow. It is a deny list, so a tool a later engine version adds is not on it; `--tools` would be an allow list, and no real run has tried it.
- **A retired meta slot launched again after a restart.** `metaSlotFromStore` now refuses one and reports on the `slot:<id>` health entry, which `/api/status` and `mec status` show. Only `retired` is refused: this runs once per start, and a degraded slot can recover. `MEC_META_SLOT` is still honoured when the stored choice is refused, since it names another home.
- **MEC's commit trusted the worktree's `.git`.** It runs outside the sandbox, and git follows that file, config and hooks included. Before the fix a swapped `.git` took the commit: `commit_failed: git log failed`, after the commit had landed in the worker's repository. The launch derives `<clone>/worktrees/<attempt>`, and `#settle` compares it with where the pointer resolves before any git call. A mismatch fails the attempt with `git_pointer_moved`.

## Found while building

- **A `_` before a key defeats the secret patterns.** `frontier_sk-ant-…` stays unredacted, because `\bsk-ant-` needs a boundary. `SECRET_PATTERNS` is contracts, out of scope here. Open.
- **`store.effects.snapshot` differs between stores.** `EffectsQueue.snapshot(kind, key)` and the memory one take different shapes, so `launchRowState` is an injected seam.
- **Process start can take seconds in a full `pnpm test`.** The input tests gate on a `waitInput` step in the fake CLI instead of a sleep.

## Risks

- **A pass picks up any ready task with no attempt**, including one on work planned before this change that never launched. With the runner flag on, an old `executing` item starts engines on boot. The flag stays off for real repositories (#25), but check before turning it on against an existing store.
- **Content blocks on stdin are the stub-probed path's untested neighbour.** `content` as an array is the Messages API shape, but only the fake has read it on stdin. If a real binary refuses it, every follow-up delivery fails by name and the message is released: the safe direction. The next real run sees it.
- **A dependent of a `dropped` task blocks.** That was already the rule for a cancelled prerequisite, and it holds even when the drop means "already done". The block says why.
- **The card serves `evidenceRef`, but the workbench does not show it yet.** `apps/web/src/api-decode.ts` reads `why` only.
- **`command_lifecycle` is undocumented.** If it goes, the replay still works, later. If both go, every delivery fails by name and the message is released: the safe direction. `REQUIRED_FLAGS` now includes `--replay-user-messages`, so the probe sees it go.
- **The real run is the verifier's.** Everything above is the stub's behaviour on 2.1.318, not a real model.
- **`confirm` holds its HTTP call up to 120 s for a card.** Claude's own timeout on a permission tool at that length is unobserved. A timeout reads as a denial.
- **Shell text is a heuristic.** `CONFIRM_BY_DEFAULT_SHELL` will miss spellings, and the sandbox stays the boundary.
- **A turn can still be fenced for up to one pass.** `guardTurn` reads `owned`, and only the sweep clears it, so a turn in the gap of up to 2 s after an attempt ends is refused. The release wake that follows gives the planner its turn. This holds for every ended attempt, not only no-checks ones.
- **A check stopped by a close also reads as no verdict.** `checksSkipped` writes `checks_note` on a stop as well, so an attempt stopped mid-check releases its messages. Crash and restart recovery is M2.4's.
- **Every pass scans docs.** `list` loads a kind whole; `known-limits` has the numbers for reads, and passes add to them every 2 s.

## Found by the fourth review, fixed here

- **A worker's card or handback could store its own bearer token.** `request_confirmation` and `handback` redacted with `redact(text, [], [])`, the pattern layer alone, and the attempt token matches no pattern, so `evidence: { auth: <token> }` went into the confirmations row and a handback reason into the message and the planner wake (§22, the Redaction row of §26). `CardDeps` now requires `clean`, the attempt cleaner the facts already use, and every card and handback write goes through it. Fields are cleaned one by one, names included: the old `redact` over the serialised object would have read the whole object as one long token, and the last-four sweep would never have seen a key inside it.
