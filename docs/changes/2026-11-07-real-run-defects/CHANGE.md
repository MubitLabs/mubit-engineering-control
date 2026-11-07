# Real-run defects before 0.3.1

Branch `fix/real-run-defects` from `origin/main` 3b40f25. What MEC's real Claude runs of 6 and 7 November found (the coordinator's evidence in `real/`, `real2/`, `real3/`), fixed one item per commit. No contract change, no SQL migration, no real engine run.

## D1: no report on an unchanged head is no work

Real Run 3, `att_1`: the specialist ended its turn with "**Blocked:** the harness refuses `sleep 80` ... I did not run ..." and sent no report. MEC committed nothing new, the base's checks were green on the base, and `acceptance()` accepted the task. The planner then said it was done.

- `packages/domain/src/acceptance.ts`: with `base` given, a head equal to it with no `ready` report goes to a `no_change` repair (§10, §15: an agent ending its turn is not success). A `ready` report on that head says nothing needed changing, and is accepted. A plan task with `no_change_ok` (new, optional, on `propose_plan`, stored per revision as `noChangeOk`) is accepted too.
- `packages/meta/src/scheduler.ts`: with no report, a turn whose last assistant message opens with `Blocked:` (markdown allowed) blocks the task with its words, as a `blocked` report would. Only the last message counts.
- `packages/meta/src/repair.ts`: the repair brief says what is missing.

Spec tension, for the owner: §10 says "Waiting-for-a-person is never inferred from free text." The brief asked for this reading. It is narrow (the turn's last message, its first word), and it only ever makes MEC stop, never go on.

## D2: specialists ignore the owner's personal instructions, and owned paths hold

- `apps/desktop/src/engine-registry.ts`: the Claude row's hygiene sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` for specialist launches. The planner is unchanged.
- `--setting-sources user` stays. Read from the 2.1.319 binary's text, not run: the user source gates the user `CLAUDE.md`, the user skills dir and `~/.claude/settings.json`, and that settings file carries the auth pins (`apiKeyHelper`, `forceLoginMethod`, `forceLoginOrgUUID`, `env`). MEC reads nothing under `~/.claude`, so it cannot know whether a linked slot's sign-in needs them. Dropping the source could break sign-in, so per the brief this stops at the env switch, which the binary checks only in its `CLAUDE.md` loaders. See the open items.
- Owned paths: `packages/git/src/repos.ts` `changedPaths()` (`git diff --name-only -z --no-renames base..head`), recorded by the runner as `changed_paths` on the attempt (`apps/desktop/src/core-facts.ts`). `acceptance()` sends a commit that changes files outside the task's `ownedPaths` to an `owned_paths` repair naming them. A task with no owned paths owns everything. Reviewer attempts are not judged by either rule.

## D3: Try again

Owner ruling. Blocked work whose task used up its repairs, reported `blocked`, or ended `Blocked:` with no report, offers **Try again**: one fresh repair attempt in that task's worktree.

- `packages/meta/src/scheduler.ts` `ownerRepairOffer()` and `ownerRetryRepair()`. One transaction: the task goes `blocked → ready` with one `repair` continuation (`origin: 'owner'`, evidence = where it stopped), its `prerequisite …` dependents go back to ready, the work goes `blocked → executing`, and `retry_requested {kind: 'repair', origin: 'owner'}` is written. A second press finds nothing. Held, stopped and ended work offers nothing, and a repository with no host-run agreement is refused with `host_run_unagreed`. The next pass places the attempt through the usual caps and launch gate. The repair counter keeps counting, so a failure blocks again with what remains.
- `apps/desktop/src/delivery.ts`: `retryOffer`/`retry` take `kind: 'repair'`. `INTEGRATION_BLOCK` still decides the integration retry.
- `apps/desktop/src/server.ts`: `/api/work/:id/retry` needs the approval key, like `/resolve` and `/host-run/agree`, so a repository's check cannot start an attempt over loopback. The web client already sends the key on every mutating call.
- `apps/web`: the existing `WorkAction` retry slot, labelled "Try again". The decoder accepts `repair`.
- Planner protocol (`protocol.md` and the fallback in `brain.ts`): MEC never re-runs blocked work by itself, and Try again plus the integration and delivery retries are the only re-runs it may name.

## D4: the owner's go-ahead lifts the block for the new plan

Owner ruling. Real Run 3: after the owner's "go ahead", the planner planned `task_2` on blocked work, and it never started, because the launch gate (`authority.ts:152`) and the pass both defer everything on blocked work.

- `packages/meta/src/service.ts` `#commitPlan`: a plan revision on blocked work lifts the block (`blocked → executing`, `block_lifted {by: 'owner'}`) when the turn is the owner's own, or a wake the owner caused after the work blocked: their follow-up (`message:`, `released:`, `handback:`) or their answer to a question (`question/…`). A wake from a report, a parked task or a timer lifts nothing. Tasks still blocked stay blocked, and the work blocks again if nothing else is open.

## D5: the live line and a spent repair

- `apps/desktop/src/inspection.ts` `#metaOf`: work that is still `integrating` but past integration reads by delivery's stage, with state `delivering` ("Pull request #7 is ready for review: …").
- `#deliveryFailure`: a failed integration whose repair task is blocked says "Its repairs are used up." or "Its repair is blocked.", not "A repair is open."

## D6: integration repairs keep the model request

`openRepairTask` copies the root task's `modelRequest`. Real Run 3's integration repairs ran opus after the owner asked for the cheapest tier.

## D7: words a person reads

- "Noted on …" names the work by a short title cut at a word (`cutAtWord` in `packages/meta/src/words.ts`), not by its id, which the page swapped for the whole request.
- A task's wait, from the server, is words: `until <what releases it>`, the agreement in plain words, a never-started blocked task's own reason, or the work's block. The web says "Blocked: …" for a blocked task and "No reason recorded" only when nothing is stored.
- Blocked lines are cut between words, with an ellipsis.
- A failed integration bootstrap posts one chat line (a `note` effect keyed per block).
