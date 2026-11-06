# MEC overhaul handoffs: start here

Every agent taking a handoff reads this file first, then its own handoff, plus any section of another handoff that its text names. These rules apply to all of them.

## The goal

Implement the approved MEC product, orchestration, observability and complete UI/UX overhaul. One meta-agent conversation and work history per repository. The meta agent coordinates specialists; users never manage worker chats. Local work is autonomous under policy. The product asks before each push, PR creation and merge. Default delivery is a tested PR ready for review; merge is separate. Observability is truthful for tasks, attempts, dependencies, models, activity, checks, diffs, decisions and delivery.

## Sources

All paths are relative to `/Users/shankhadutta/code/mubit-engineering-control`. The planning records are uncommitted until the bootstrap PR lands, so read them in that checkout.

| Need | Where |
| --- | --- |
| Plan and PR table | `docs/changes/2026-11-05-meta-agent-journeys/CHANGE.md` |
| UI design and acceptance | `docs/changes/2026-11-05-meta-agent-journeys/UI-OVERHAUL.md` |
| Regression cases and mutants | `docs/changes/2026-11-05-meta-agent-journeys/VERIFICATION.md` |
| Source evidence | `docs/changes/2026-11-05-meta-agent-journeys/research-*.md` |
| Scout reports | `wave0-baseline.md`, `wave0-release.md`, `wave0-design.md`, `wave0-m1.md` in this directory |
| Owner decisions | `docs/DECISIONS.md`, #10-23 |
| Behaviour | `docs/plan/spec.md`: cite the section; if it's silent, ask, never guess |

Scout reports and line numbers describe base `a102313`. Treat them as leads and check them against the source you actually have.

## Do not start early

Each handoff has a **Start when** line naming the branches that must already be on `origin/main`. Check it with `git fetch origin && git log origin/main --oneline`. Not merged means not started. A handoff run against a missing dependency produces work that must be redone.

## Already running: do not pick up

The coordinator session has these in flight. Never rebuild them or edit their branches.

| Branch | Scope |
| --- | --- |
| `fix/release-cards` | Card path repair, squash merge, mutant runner. Merges first. |
| `fix/http-recovery` | M1.1 |
| `feat/visual-foundation` | VF0, default off |
| `feat/repo-identity` | M1.2 |
| `fix/effects-double-run` | Effects queue double-run fix |

## Working rules

1. **Isolate.** Work in your own worktree on the branch your handoff names: `git worktree add ../mec-<branch-slug> -b <branch> origin/main`. Don't switch branches, stash or edit in the main checkout. Leave `/Users/shankhadutta/code/mec` untouched.
2. **Stay in scope.** Edit only what your handoff owns. If you need a file another handoff owns, stop and report. Touch shared hot files (`packages/meta/src/service.ts`, `apps/desktop/src/server.ts`) only in the blocks your handoff names.
3. **Prove it.** Write the failing test first and see it fail for the right reason. Then implement. Then run the mutants with `tools/mutants/run.py`. Finish with `pnpm check`.
4. **Baseline.** There is no permitted failure now. `apps/desktop/test/login-cards.test.ts` "drives a real interactive shell through the seam" used to fail because the node-pty helper loses its execute bit in fresh installs; #44 (`b57d1da`, on `origin/main`) removed it from the permitted list. If it fails for you, that is yours to report, not a known baseline. Anything failing is yours.
5. **Keep tests honest.** Never weaken a test. A changed assertion must be an intended behaviour change, and you must say so.
6. **Verify separately.** A builder never verifies its own change. Use a second agent or session for behaviour verification.
7. **Blockers-only review.** Only where your handoff says so, by a different agent. Its fixes need no re-review.

## Hard limits

- No `git push`, `gh pr`, merge, tag, release or install. Install means putting MEC on this machine or over the owner's install; `pnpm install` in your worktree and a tarball extracted into a scratch directory for a smoke run are not that. **You finish with a local branch.** The coordinator lands everything, one at a time, through the scratch release lane.
- Never read a credential, a vendor OAuth store, or anything under a slot home's `keys/`.
- Never start anything against `~/.mec`, and never touch the running install's server. A local server needs a scratch `MEC_DATA_DIR`; add a scratch `HOME` unless it truly needs your real `gh`, which no handoff does. One exception: a real-engine run through an existing slot (#18) keeps the real `HOME`, because a subscription slot's login is in the macOS Keychain. It still uses a scratch `MEC_DATA_DIR` and a fake `gh` first on `PATH`, and you read nothing under the slot home.
- Stop or signal only a process you started, by its PID. No `pkill`. Never run `mec stop` or `mec restart` with the real `HOME`.
- No SQL migration and no stored-data deletion. If you think one is needed, stop and report it. That needs the owner's separate approval.
- `packages/contracts` changes only if your handoff allows it: additive, with the matching fixture and a line in `docs/handoff/CONTRACTS.md` §10.
- Keep the `.mec/` exclusion in `commitAll`, and redaction before every write.
- No new dependencies unless your handoff names one. No framework migrations or upgrades.
- Fixtures stay honest: `recorded_by: 'real'` only for a real binary that ran.
- Synthetic prototype data never reaches production code.

## Real engines

Budget is **20 bounded runs for Claude and 10 each for Codex and OpenCode, in total across all agents** (decisions #18, #24 and #37). Only handoffs that say so may spend it. Before each run, append a line to `/Users/shankhadutta/code/mubit-engineering-control/docs/changes/2026-11-05-meta-agent-journeys/handoffs/engine-runs.md`, creating it if missing: date, engine, handoff, purpose, outcome. Use that path, not a copy in your worktree; it is the one file you may edit in the main checkout. One bounded request is one line per engine involved, until the owner rules otherwise (`20-m2.1-real-specialist-slice.md` open question 3). If the file already shows 10 for an engine, stop and report. Real runs only touch scratch repositories or `mec-sandbox`.

## Scratch server

From a built tree, with no real data:

```sh
pnpm install --frozen-lockfile && pnpm build:desktop && pnpm --dir apps/web build
S=$(mktemp -d)
MEC_DATA_DIR=$S/home/.mec HOME=$S/home MEC_FAKE_ENGINE=1 MEC_NO_OPEN=1 node apps/desktop/bin/mec.js
```

Without `dist` the launcher's source fallback fails. The port is ephemeral: read it from the "mec server listening on" line. The data dir sits at `$HOME/.mec` on purpose: since #45 (`730dd5b`) every `mec` command follows `MEC_DATA_DIR` the way the server does (`cliMain` in `apps/desktop/src/mec.ts` reads `MEC_DATA_DIR ?? ~/.mec`). Setting both to the same place, as the recipe does, still works on any build, so keep the scratch `HOME` too: run `HOME=$S/home MEC_DATA_DIR=$S/home/.mec node apps/desktop/bin/mec.js status`. A tree from before #45 reads `$HOME/.mec` only. The store file is `$S/home/.mec/mec.db`.

## Shared machine

`pnpm test:screens` uses fixed port 4173. Wrap each run in a lock:

```sh
LOCK=/tmp/mec-screens.lock
until mkdir "$LOCK" 2>/dev/null; do sleep 5; done
pnpm test:screens; rc=$?
rmdir "$LOCK"; exit $rc
```

## Commits

End every commit message with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SkhX4L2HPWS5GuCexMyvRx
```

## Records

Add `docs/changes/2026-11-05-<slug>/CHANGE.md` and `VERIFICATION.md` on your branch. Don't edit `agent-checkpoint.md`, `agent-progress.html` or `docs/DECISIONS.md`: the coordinator owns those. Only `engine-runs.md` is shared.

## Finish by reporting

Give the coordinator this, and nothing that you didn't observe:

```text
Handoff:
Branch and final SHA:
Worktree path:
What changed:
Failing-first: command, output before, output after
Mutants: name and killed/survived/invalid
pnpm check: compared with baseline
Verifier: who, what was run, outcome
Review (if required): blockers and resolution
Engine runs spent:
Unverified or open:
Owner questions: spec section and recommendation
```
