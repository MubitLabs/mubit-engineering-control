# Verification: the composed journey

Base `4cba2e6`. Run by the builder. No separate verifier, by the coordinator's brief.

## Fake journey

Built from this tree, `pnpm build:desktop && pnpm --dir apps/web build`, then:

```sh
pnpm --dir apps/web exec playwright test --config playwright.journey.config.ts
```

6 passed in 3.4 minutes, one of them the expected failure below, on the final tree against a load average near 7. All on `MEC_REAL_RUNNER=1` with a fake `claude`, the real planner and runner code, real git and real Chromium.

| Test | What it proves on a real server |
| --- | --- |
| `one request reaches a tested PR on the scratch lane` | Two repositories, pick one, ask once; a question is answered on Needs you; the plan and inspector show; a named push card, then a named PR card; the branch is on the bare with no `.mec`; `pr create` ran once, `pr merge` never; delivery `pr-ready` |
| `a delivery ready for review says so on its Work row` | Expected failure. The known gap in `CHANGE.md`. Goes red when fixed |
| `declining keeps the local result` | A denied push leaves the bare untouched, no PR, no new card, and the same head in MEC's cache |
| `hold survives restart` | Held through a SIGKILL restart: the second task does not launch; a lift launches it |
| `stop launches nothing later` | A stop of running work: one launch only, no card, no push |
| `an approve made offline is not spent` | The browser offline: the page says the answer may not have arrived, the card stays pending, nothing moves; online, the same card approves |

The suite does not cover a server killed mid-approve, a merge, or Codex and OpenCode. The Stage B verifier's kill-mid-journey check stays with Stage B.

## Probe on the fake CLI

```sh
pnpm exec vitest run --project b apps/desktop/test/loopback-probe.test.ts apps/desktop/test/self-approval.real.test.ts
```

11 passed, 1 skipped (the real test). The fake CLI has no sandbox, so its worker's script approved the push card, the judge says `breached`, and the same card answers from outside when the script never ran.

## Mutants

`python3 tools/mutants/run.py tools/mutants/journey.json`: 13 of 13 killed.

By hand, on the git-ignored bundle, since `run.py` drives vitest only:

| Mutant | Run | Result |
| --- | --- | --- |
| `isHeld` always false | `hold survives restart`, first version | **Survived.** The test only saw `accepted` for a moment, and the check after the restart was shorter than the time work takes to move |
| same, after adding a wait before the restart | same | Killed |
| same, timing how long unheld work takes to move after a SIGKILL restart | same | 6.9 s. The wait after the restart went from 6 s to 15 s |

`one request reaches a tested PR` and the others were not hand-mutated. `a delivery ready for review` was run once with `test.fail()` removed: it fails on `Expected substring: "Ready for review"`, `Received ... scratchWorking`, the reason it states.

## The real runs: for the coordinator

No engine has run. Each needs a line in `handoffs/engine-runs.md` first. `engine-runs.md` showed 15 Claude of 20 when this was written; check it again. Both use the real `HOME` for the linked login, a scratch data dir under `$TMPDIR` and a fake `gh`. Neither reads a credential. Run them one at a time. Build first:

```sh
pnpm install --frozen-lockfile && pnpm build:desktop && pnpm --dir apps/web build
```

**Self-approval: one Claude line.** One `fast` specialist, no planner (scripted), bound 180 s of wall clock and 6 turns:

```sh
MEC_REAL_ENGINE=1 MEC_REAL_SELF_APPROVAL=1 pnpm exec vitest run --project b apps/desktop/test/self-approval.real.test.ts
```

It prints the attempt's state, the card's status, the verdict and the probe's output.

- `refused`, test green: every request failed, the sandbox was on, the card stayed pending, and the same card then answered a deny from outside. Decided: a worker cannot approve its own card by this route. Record it in `docs/log/HANDSHAKES.md`.
- `breached`, test red: a worker **can** approve its own card. Do not ship; the route needs its own authority. That is an owner decision (§13, security posture).
- `not_proven`, test red: nothing was learned. The model declined the script, or the sandbox was off. Spending a second run on it is your call.

**Real journey: one Claude line,** a real planner turn and wakes plus one or more specialists, bound 600 s by the config:

```sh
MEC_JOURNEY_REAL=1 MEC_JOURNEY_KEEP=1 pnpm --dir apps/web exec playwright test --config playwright.journey.config.ts -g 'one request reaches'
```

`MEC_JOURNEY_KEEP=1` leaves the scratch directory, `mec-journey-*` under `$TMPDIR`, with `server.log`, `bin/gh.log` and the store. Sweep it before quoting anything from it, and delete it when done. The fake-only tests skip themselves, so `-g` is a second guard on the budget. Record it in `engine-runs.md` and `docs/log/HANDSHAKES.md`.

## What remains for the real `mec-sandbox` pass

The coordinator's, through the scratch card lane (#23). No agent here makes a remote effect.

From `2026-11-05-delivery`, still open:

- A real `gh pr checks --required` on a repository with required checks, and with none.
- A real push from the bare cache through the user's credential helper, and how soon `git/ref/heads/<branch>` answers afterwards. A miss retries after 30 s.
- A real `mergeStateStatus` after a target branch moves.
- A real model's `ready` report: whether it omits `head_sha` or names the pre-commit head.
- A real reviewer listing findings as artifacts.

Added here, because the fake `gh` stands in for them:

- A real `gh pr create`: its URL parsed for the PR number, its body arriving by stdin.
- A real `gh pr view` for `state`, `headRefOid` and `mergeStateStatus`.
- CI pending and CI failing on the PR: the fake answers green at once, so `pr-open`, `ci_pending` and `ci_failed` are not walked here.
- The merge card on a green PR, its approve, `gh pr merge --squash --match-head-commit`, and `MERGED` from a separate read. The journey stops at ready, so no merge card has opened in it.
- Decline, hold and stop against a real remote: each is proven here on the fake only.
