<!-- Wave 0 scout report, 5 November 2026, base a102313. Leads, not facts: check against source. -->

# M1 scoping briefs: M1.1, M1.2, M1.4 (base a102313)

**Verdict:** none of the three needs a SQL migration or a `packages/contracts` change. M1.4 must first fix a double-execution bug in the effects queue, which the plan doesn't list.

**What I ran:** six throwaway probes (vitest, config and test in the scratchpad) on in-memory stores with `MEC_FAKE_ENGINE=1`, no engine. Command: `pnpm exec vitest run --config <scratch>/vitest.config.ts --root <scratch>`, exit 0, 6/6. The probes have no assertions, so read the printed values, not the pass count. Everything else is source reading; no repo suite, `pnpm check` or mutant ran.

**Slip:** a stray `cat >` of mine hung and created an empty `/Users/shankhadutta/code/.probe-noop`, outside the repo. I stopped the task and deleted the file. `git status` shows the same 4 entries as at the start.

| Probe | Observed |
| --- | --- |
| A: two overlapping `effects.run()` | relay ran 2x, launch ran 2x |
| B: same task key, second plan after first work stopped | task moved to the second work; first work has 0 tasks |
| B2: second unrelated request while work is live | 1 work item, routing `conversation` |
| C: `tasks.save` on an existing attempt id | row keeps `kind: attempt`, json replaced by the task |
| D: answer an open question on stopped work | state becomes `executing`, 1 launch enqueued |
| E: planner `release` on a timer wake | hold gets `liftedAt` |

## Plan citations
All cited lines I checked still say what the plan says (composition, service, migrations, store, server, api.ts, SettingsView:76, workbench:494). I did not re-check citations outside these three PRs. Corrections and gaps:
1. **Overwrite reachability:** it needs the earlier work stopped or done, because any live work routes everything else to `conversation` (B2). `brain.ts:478` tells the planner to use `task_1, task_2`, so every plan collides. Nothing moves work to done in production, so one live item blocks new work globally.
2. **Stop and hold have no HTTP route:** `api.ts:581-595` calls `/api/work/:id/hold`, `/stop` and `/api/processing/pause`, none served. `/api/work/:id`, `/api/tasks/:id`, `/api/inbox/:id/detail` and `/api/backups` are also absent. M1.4's "stop during planning" acceptance needs new routes.
3. **Not in the plan: double execution (P0):** `effects-queue.ts` `pickDue` resets every `running` row to pending on each pass, and `composition.ts` starts a pass every 2s with no in-flight guard. Any handler over 2s can run twice (A). `effects.test.ts` has no match for `running` or `resumeRunning`, so crash-resume also looks untested.
4. **Not in the plan: JSON 404 turns on fixtures:** `withDemo` falls back on `NotServedError`, so the JSON 404 fix would serve `demoBackups` and demo details live. It must land with `withDemo` removal.
5. **Crash replay can't be reached over HTTP:** `server.ts:547` mints a new `messageId` per request and saves the idempotency key only after the await (`:554-558`). A retry during planning admits twice. Nothing resumes receipt-less messages at boot.
6. **Mandates and holds are unwired:** `createMandate`, `withdraw`, `revalidate` and `HoldStore` have no production caller. `service.ts:451` stores only `{originMessageId}`.
7. **Further P0 gaps:**
   - A planner `release` lifts a hold (E; `service.ts:861`, `tools.ts:282`), against §10 and §13.4.
   - `#failTurn` and plan rejection stop any work regardless of state, so a failed wake can stop executing work.
   - `onWake` without a work id creates work with no repo (`service.ts:314`).
8. **Conditional:** the GET-to-HTML fallback (`server.ts:1885`) applies only when `WEB_DIST` exists.
9. **Extra mismatch:** `answerQuestion` sends `{option}`, the server needs `{answer}` (`api.ts:577`, `server.ts:1448`). The UI `Question` shape (`eyebrow/what/why`) also differs from what GET serves.

## M1.1 HTTP recovery
- **Files:** `apps/web/src/api.ts`; new pure `apps/web/src/api-decode.ts`; new `components/PaneBoundary.tsx`, mounted in `App.tsx`; `views/SettingsView.tsx` and `components/Settings.tsx` for finite error states (their `.catch(() => {})` leaves Loading forever); `server.ts:1885` gets an `/api/` guard returning JSON 404. `workbench.tsx:366` needs only its demo branch removed.
- **Seam:** decoders map server JSON to the existing view types, so components barely change. The model table's shape still needs reading in `@mec/prompts`.
- **Removing fixtures:** drop `withDemo` and the `mocks.ts` import from the production bundle. `screens.playwright.ts:64` relies on that fallback, so those mocks must answer explicitly. Baselines change.
- **Migration, contracts:** none. Web doesn't import `@mec/*`.
- **Failing-first tests:**
  - `apps/desktop/test/web-contract.test.ts`: `real /api/prompts decodes to a part array`, `real /api/models decodes to providers and rows`, `real questions decode and the answer body is accepted`, `unknown /api GET is JSON 404 with dist present`. These use real `buildServer` and need a check that desktop's tsconfig allows the relative import.
  - `apps/web/test/api.test.ts`: `a 404 read never returns demo data`, `malformed payload rejects`.
- **Gap:** there's no jsdom and no new dependencies allowed, so boundary containment can only be proven in Playwright, which is outside CI. It stays a verifier step.
- **Mutants:** return the raw envelope from `prompts()`; restore `withDemo`; remove the `/api/` guard; send `{option}`.
- **Spec:** §18, §12.6. No open question.
- **Blockers review:** not needed.

## M1.2 Repo and canonical identity
**No schema change is needed.** Docs are free-form JSON (`store.ts:135`, `StoreDoc = Record<string, Json>`), and `migrations.ts` has only migration 1. New fields go in existing `json` rows, and old binaries ignore them.
- `work_item`: `repoId`, `pin {repoId, url, profileHash, policyHash, promptRevision}`
- `task`: `localKey`, `planRevision`
- `message`: `repoId`
- plan snapshots: `plan/<wi>/<n>` docs in `store.engines`, the same catch-all that holds questions and repos
- the conversation id is simply the `repoId`, so no table

Task ids become `task_<fresh>`, which also satisfies `TaskId`; today's `adhoc_*` ids fail it. No backfill, and legacy rows stay Unassigned and read-only. Reads use full scans for now. If M3.1 wants indexes, that is an additive numbered migration needing separate approval; the no-migration alternative is unindexed `json_extract` with keyset paging.

- **Files:** new `packages/meta/src/admission.ts` (repo resolve, key rewrite); `service.ts` at `:208`, `:242`, `:258`, `:311`, `:439`, `:560`, `:623-670`, `:696-712`, `:801`; `tools.ts` (reject route, spawn, stop or cancel across repos); `context.ts:216` (show `localKey`); `store.ts:122`; `server.ts:458-565`, `:369`, `:666`, `:612`.
- **Store guard:** `ON CONFLICT ... WHERE docs.kind = excluded.kind`, throwing on zero changes (probe C). The builder must confirm nothing saves one id through two repositories.
- **Compatibility:** in this PR `repoId` is optional, an unknown or mismatched id is a 400, and absent means Unassigned and not launchable. M1.3 flips absent to 400, so live chat survives between the PRs. Routing liveWork is filtered by repo.
- **Existing tests must change:** `service.test.ts:95-129` asserts ids equal planner keys. Look up by `{workItemId, localKey}` and keep every assertion. This is an intended behaviour change, not a weakening.
- **Contracts:** none. `repo_` is not a contract id and `AttemptBrief` has no repo field, which is M2.1's concern.
- **Failing-first tests:**
  - `packages/meta/test/admission.test.ts`: `two repos reuse task_1 without overwrite`, `dependsOn rewrites to canonical ids atomically`, `cross-plan dependency refused`, `spawn gets a task_ id and inherits repo`, `wake never creates repo-less work`, `repo pin is immutable after registry edit`.
  - `packages/store/test/store.test.ts`: `save refuses a cross-kind id collision`.
  - `apps/desktop/test/server.test.ts`: `unknown repoId is refused before any write`, `repo A live work does not route repo B to conversation`.
- **Mutants:** remove the repo filter in routing; use the local key as the id; skip dependency rewrite; drop the kind guard; let the planner cancel across repos.
- **Spec open questions (cite, not guessed):**
  - §10 says plans are versioned but not whether a replan's same key is the same task. Safe default: reuse the id, never reset status.
  - §14 says "pinned base" but not when, and repo docs have no default branch. Suggest pinning the SHA at first dispatch (M2.1).
  - §12.1 assumes one conversation, while #10 makes it per repo; the spec needs a line.
- **Blockers review:** not needed, since it's additive with no migration. A migration would trigger the review and owner approval.

## M1.4 Authority and durable commands
I recommend two PRs.

**M1.4a, fence:**
- `effects-queue.ts`: in-flight guard; `resumeRunning` once at boot.
- `service.ts`: re-read work inside the commit `atomic`. Terminal or withdrawn discards the plan; held commits zero launches.
- Use `createMandate`, `withdraw` and `revalidate`. Legacy mandates have no `status`, so derive it from work state.
- Route state changes through the machines. `#failTurn` and rejection stop only `planning` work.
- Remove planner `release`.
- New `server.ts` block: `POST /api/work/:id/hold|lift|stop`, `/api/processing/pause|resume`; pass `pauseControl` at `composition.ts:147`.
- Launch handler rechecks authority and repo.

**M1.4b, durable commands:**
- Message and idempotency key are stored before the brain call; `messageId` is stable per key; `onUserMessage` checks a receipt-less `prior` before routing; boot resume.
- Wakes use the existing `relay` kind (§17 defines it, currently a no-op), key `wake:<causationId>`, enqueued in the answer's transaction. No new effect kind.
- `POST .../answer` no longer waits for the planner turn.
- Non-fake launch: block the work idempotently with a reason, then throw. The row ends `failed` with `last_error`. Do not use `Later`, because a future runner would launch stale work.
- Own the brain's lifetime in `close` (`composition.ts:232`). Grep shows production enqueues only `launch`.

**Other notes:**
- **Migration, contracts:** none.
- **Failing-first tests:**
  - `effects.test.ts`: `a running job is not re-picked by an overlapping pass`, `boot resumes a crashed running row`.
  - new `packages/meta/test/authority.test.ts`: `stop during awaited planning launches nothing`, `late answer cannot revive stopped work`, `hold survives restart and blocks launch`, `timer wake cannot lift a hold`, `failed wake does not stop executing work`, `crash after work created resumes the same message`, `wake deduped by causation`.
  - `server.test.ts`: `retry during planning admits once`, `stop withdraws the mandate`.
  - `composition.test.ts`: `unsupported launch never settles as success`.
- **Mutants:** remove commit fence; remove in-flight guard; allow planner release; skip `withdraw`; launch while held; return success on unsupported launch; dedupe key without causation.
- **Spec:** §6, §10, §12.5, §13.4, §17, §20. §26 is not read yet.
- **Spec open questions:**
  - Must a user-message planner turn be able to lift a hold, or only the explicit command? Recommend command only.
  - Does a held in-flight plan keep its tasks? §12.5 is silent.
  - Does pause persist across restart? `paused` is in memory and §20 is silent.
  - §17 "fails the attempt", but `ATTEMPT_STATES` has no failed state.
- **Blockers review:** recommend one, covering M1.4a. It adds stop/hold/lift routes and changes who holds authority, which is close to the permissions case. This is a judgement call for you. Stop today changes docs only; process kill arrives with M2.1.

## Mutant runner (no new dependency)
Add `tools/mutants/run.py` (stdlib, like repo-kit) and `tools/mutants/<pr>.json`, with entries `{name, file, find, replace, tests[]}`.
1. Refuse a dirty target file, and fail unless `find` occurs exactly once.
2. Run the baseline tests; they must be green.
3. Apply the patch, then run `pnpm exec vitest run <tests> --reporter=json --outputFile <tmp>`.
4. KILLED only if `numFailedTests > 0`. A run with no failed tests but a failed suite is INVALID, not killed.
5. Restore in `finally`, and exit non-zero on any survivor or invalid mutant.

Self-check: a no-op mutant must report SURVIVED and a syntax error INVALID, which also checks the JSON fields on failure. I've only seen them on a passing run. Run it in the builder's worktree, with no CI wiring needed.

## Conflicts and order
- **Hot files:** `service.ts` (M1.2, M1.4), `server.ts` (all three, in different blocks), `api.ts` (M1.1 only).
- **VF0:** new files only. It must not touch `api.ts`, `workbench.tsx` or `App.tsx`, and no Playwright baselines until M1.1 merges. M1.1's only mount is `PaneBoundary` in `App.tsx`; VF0's flag mount comes after.
- **Order:**
  1. Squash bootstrap PR, already first per checkpoint.
  2. M1.1, M1.2 and VF0 in parallel.
  3. M1.4a after M1.2 merges, then M1.4b.
  4. M1.3 live wiring after M1.2. Its required-`repoId` flip needs VF0's selector.
- **Independent:** the M1.4a queue fix could ship alone, even before M1.2, since it doesn't touch `service.ts`.

**Open for the owner:** the four M1.4 spec questions, the three M1.2 ones, and the M1.4a review call.

Scratch probe, not committed: `/private/tmp/claude-501/-Users-shankhadutta-code-mubit-engineering-control/2df31a5d-d987-49c0-b14f-93aa17eec939/scratchpad/probe/probe.test.ts`
