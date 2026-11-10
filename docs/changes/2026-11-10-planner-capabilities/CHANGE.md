# The planner knows what each connection can run

Branch `fix/planner-capabilities`, base ef1e309 (0.3.8 is installed).

## The problem

The owner's horse tinder test on installed 0.3.6 to 0.3.8, work `wi_mw9kvv161fy597y`. `~/.mec/mec.db` was read with `sqlite3` only.

- Task `task_mw9lz4w95kt6ydd` (`task_fix_top`) had this objective: "…Then actually load index.html in a real browser (e.g. headless Chromium via Playwright/Puppeteer) and verify with no console errors…". It had `modelRequest: {tier: 'balanced'}` and **no slot pin**.
- The scheduler put attempt `att_13` on `slot_glm-2`, an OpenCode connection. The attempt's placement reads "slot_glm-2: no claude slot fits; lowest utilisation of 2 candidates". The other candidate was `slot_codex-1`, which can run commands.
- The worker renamed `top` with its edit tool. It then asked for one shell command (`node --version && npm --version`). The ask was refused (`permission_result: deny`), and the worker reported `blocked`: "Browser check via Playwright/Puppeteer: NOT RUN — shell commands refused by MEC in this engine".

## The cause

Nothing that plans or places work knew what a connection's worker can do.

- **OpenCode.** `opencodeAttemptConfig` (`packages/runtime/src/opencode-client.ts`) sets `shell` to `ask`. The row's sandbox is `off` (`apps/desktop/src/engine-registry.ts`). The decider behind the ask, `judgeOperation` (`apps/desktop/src/specialist-tools.ts`), refuses any shell command without the required sandbox ("shell needs the required sandbox"). So an OpenCode worker can read and edit files and can never run a command. `docs/known-limits.md` already says so.
- **The planner's context** (`packages/meta/src/context.ts`, `slotsSection`) listed each slot's engine, provider, state, utilisation and tiers, and nothing about commands.
- **Placement** (`packages/meta/src/scheduler.ts` with `planDispatches`) narrows by pin, model and slot class, then by lowest utilisation. The OpenCode slot was the least used, so it won.

Ruled out: the pin. The task had none, so the planner did not choose the slot. The tier did not decide it either: both slots served `balanced`.

## The change

1. **A reach record per engine row.** `packages/domain/src/reach.ts` adds `WorkerReach = {commands, edits, network}`. `reachOf(row)` in `apps/desktop/src/engine-registry.ts` reads it from the config each row really writes:
   - OpenCode: the last matching rule in `opencodeAttemptConfig(...).agents.build.permissions` for `shell`, `edit` and `webfetch`. A `shell` ask counts as runnable only if `judgeOperation` allows a sample command under the row's sandbox, and it does not. The result is edits yes, commands no, network no.
   - Codex: `codexAttemptArgs(...)`. Commands run inside the required sandbox without an ask, because every ask is refused. Edits: the worktree is `write` in the profile. Network: the profile grants none and `web_search="disabled"`. The result is commands yes, edits yes, network no.
   - Claude: `buildAttemptSettings(...)` together with `judgeOperation`. The sandbox is enabled and a shell ask is allowed under it. The worktree is in `allowWrite`. The only allowed domains are the engine's own. The result is commands yes, edits yes, network no.
   `plannerPlacement` (`apps/desktop/src/planner-placement.ts`) supplies `reach()` per launchable slot. `composition.ts` already spreads the placement into `MetaAgentService`, so no change was needed there.
2. **The context line.** `SlotModelsView` and `PlannerSlotRow` get an optional `reach`. Each slot line ends with `edits files; cannot run commands` or `edits files; runs commands, no network`. A slot with no recorded reach says nothing about it. This happens in fake-engine mode and in tests without a supplier.
3. **The protocol.** `roles/meta_agent/protocol.md` gets one paragraph, and the standalone fallback in `brain.ts` gets the same sentence: a task that needs commands (running tests, a build, a script, a browser) goes on a connection that runs commands, and MEC runs acceptance checks itself.
4. **Plan admission** (`packages/meta/src/tools.ts`, `reachIssues`). This applies only to a task whose objective contains one of these whole words: `run`, `rerun`, `execute`, `npm`, `npx`, `pnpm`, `yarn`, `node`, `browser`, `playwright`, `puppeteer`, `headless`, `test command` (`commandNeed`). Such a task is refused with a plain `reach:` issue in three cases:
   - it is pinned to a slot that cannot run commands (the issue names the slots that can);
   - no connection here can run commands (the issue says to plan file edits only, because MEC runs the acceptance checks, and to say what a person must run);
   - its tier is served only by connections that cannot run commands.
   Acceptance checks alone are never a reason. A task without a pin is accepted, and placement handles it.
5. **Placement** (`packages/meta/src/scheduler.ts`, `reachFit`). For such a task, the candidate slots are narrowed to those that can run commands, combined with the model fit. A pin on a slot that cannot run commands is not launched. The task waits with "…pinned to X, and X cannot run commands", which the work view shows as "until a replan moves it to a connection that can run commands". With no capable slot it waits "until a connection that can run commands is set up". Fake-engine mode is not narrowed. A slot with no recorded reach is not ruled out.

Contracts are untouched. `WorkerReach` and the new optional fields live in `@mec/domain` and `@mec/meta`.

## Risks

- **The word list is deliberately simple.** A false positive ("do not run the tests") only steers placement to a slot that can run commands. It is refused only when no such slot exists, or when the task is pinned to one that cannot. The planner then gets a plain reason and can reword. A false negative ("check it in Chrome") behaves as before.
- **`node` also matches "a DOM node".** That is the same false positive as above, with the same cost.
- **An existing stored task already pinned to an OpenCode slot whose objective needs commands now waits rather than launching.** Before, it launched into a sure `blocked`. It waits until a replan moves it.
