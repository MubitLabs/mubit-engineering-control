# Verification: M2.4 Part A, blockers-only review fixes

Base 9ecc226. All commands ran in the worktree; observed, not read. Machine load stayed between 7 and 17 throughout, with another worktree's suites running.

## Failing first

Each row was red on the code before its fix, then green. `slot-switch.test.ts` and `recovery.test.ts` in `apps/desktop/test`, with `-t` on the new cases.

| Item | New tests | Red before | Green after |
| --- | --- | --- | --- |
| 1. Resume and switch | `a resuming attempt cannot also switch`, `a late resume row for an attempt that switched is dropped` | 202 for 409; `{ verdict: 'run' }` for a drop | 14 of 14 in the file |
| 2. Concurrent switches | `two switches at once make one new attempt`, `an attempt that parks while the pack is built refuses the switch` | 3 attempts for 2; `undefined` for `'stale'` | 16 of 16 |
| 3. Card states its set | `an approval moves only the attempts its card stated (§13)`, `the card states the parked attempts, and its hash binds them` | no `slot_switch_refused` ever appeared; payload had no `parkedAttempts` | 18 of 18 |
| 4. Ended work | five `work … refuses a switch` cases, `work stopped after the card moves nothing when it is approved` | 202 for 409 in all five; no refusal event | 24 of 24 |
| 5. Group that would not go | `a resume row waits for proof` on `interrupted` and `quota_wait`, `a launch row waits for proof too` | engine started beside the group in all three | 3 of 3 |
| Redaction | `a pre-authorised reason is cleaned before any write` | the reason was written uncleaned | 25 of 25 |
| Planner mark | `a group that stays unprovable/refused keeps its mark and dirs, and says so` | `refused` undefined: mark wiped | 7 of 7 in the planner block |

Item 5's whole file first ran with 4 of 38 failing, all timing under load. Three passed on the first rerun alone, and `a live park tells chat` passed on the next two. Alone with one worker: 42 of 42.

Added after the fixes, without a red step, because a mutant needed them: `work stopped while the pack is built`, `a card that names no attempts`, `a mark a boot refused survives a new engine`, `a mark a boot refused survives the server closing`. The last is proven by the `close wipes the refused mark` mutant.

## slots.get(undefined)

It does not throw. better-sqlite3 returned `undefined` for `.get(undefined)` on a one-placeholder statement, run alone, and the real server does the same. So the premise for a new refusal does not hold, and no code was added. `a card a worker forged names no target` pins it with probing off: refused `target_unhealthy`, card marked applied, nothing moved.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m2.4.json`, 44 mutants: 25 existing and 19 new.

- First complete run, at b470566: 40 killed, 4 survived, 0 invalid. No `find` was actually stale: all 25 resolved once, before and after the fixes.
- The four survivors were real test gaps: `dispatch before reconcile`, `resume with no probe`, `switched attempt applies twice`, `stopped checks run again`. Each test was strengthened, with no assertion weakened.
- Rerun of those four at cb9ddaa with `--only`: 4 of 4 killed. cb9ddaa changed tests and the spec only, so the other 40 verdicts stand on unchanged source.
- `--self-check` at cb9ddaa, on `switch keeps session`: the no-op reported SURVIVED and the syntax error INVALID, as expected.
- The spec was never completing most likely because `recovery.test.ts` takes minutes here and one timing failure in it fails the baseline. That is inferred, not observed. The recovery mutants now name their tests with `-t`, which also keeps a timing failure from reading as a kill.

New mutants, all killed: resuming attempt also switches · switched attempt still resumes · atomic block trusts its first read · no late refusal · a changed set is not seen · approval ignores the card's set · hash leaves out the attempts · a bare card applies · switch ignores ended work · switch ignores a changed policy · parked resume not reconciled · launch gate ignores a refused group · resume gate ignores a refused group · a refusal never clears · pre-authorised reason written raw · attempt cleaner not used · planner mark wiped · refused mark forgotten · close wipes the refused mark.

## Suite

`pnpm check` ran twice. The first stopped at lint, on the spec's formatting, before any test. The second, at b470566: typecheck and lint clean, 2579 passed, 24 failed, 14 skipped, and 8 files whose workers failed to start.

Everything but the baseline failure was rerun alone, with 2 workers or fewer:

- `a11y-gate`, `attempt-runner`, `live-park`: 54 of 54.
- `attempt-launch`, `composition`, `coordination`, `delivery-flow`: 89 of 89.
- The 8 files that never started: 77 passed, 3 skipped.
- `recovery.test.ts`: 42 of 42.

The one remaining failure is the baseline `login-cards.test.ts` "drives a real interactive shell through the seam" (`posix_spawnp failed`). It was not rerun. No suite ran whole and green under this load, and `pnpm check` was not repeated at cb9ddaa, which changed tests and the spec only. Those tests passed in the mutant runner's baselines, and `pnpm lint` and the desktop typecheck are clean there.

## Unproven

- A real engine: all of this ran on the fake CLI and real SQLite.
- A builder's own evidence only. No separate behaviour verifier has run.
- A mandate that expires between a switch and its launch still leaves a queued attempt holding capacity (`CHANGE.md`, Risks).
