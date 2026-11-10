# Verification

Branch `fix/owner-answers`, base ef1e309. The builder ran these checks on 10 November 2026. No real engine was used. Nothing touched `~/.mec`, the installed server on port 61610 or MubitLabs/mec-sandbox, and nothing was pushed.

## Failing first

Run: `npx vitest run packages/domain/test/stages.test.ts apps/desktop/test/delivery-surfaces.test.ts apps/desktop/test/delivery.test.ts`, with the new tests and the source unchanged. 8 tests failed:

- `stages.test.ts`: "a branch someone else pushed to says so in its stage". No `branchForeign`, and the old label.
- `delivery-surfaces.test.ts`: "a branch someone else pushed to says so, offers nothing, and points at GitHub". The old words, *Bring up to date* still offered, and the old live line.
- `delivery.test.ts`: 6 tests, using real git with a local bare repository standing in for GitHub and a fake `gh`.
  - The 4 refused-adoption tests: no `foreign: true` on `headMoved`, and an offer was still made.
  - "a commit someone added is said in words, Bring up to date is not offered, and a retry is refused".
  - "behind its target as well, a branch with their commits still offers nothing".

The guard test "a branch reset to the target carries nobody’s commits: Bring up to date stays" passed before the change, as intended. It and "a branch put back on the head MEC pushed, under an adopted update, carries nobody’s commits" were written to kill the mutants that drop `^target` or `^speaksFor` from the count.

One existing assertion changed, because the owner's answer #68 (b) changes this behaviour. "a commit someone added is not adopted" no longer expects an `update` offer with the old words. The new (b) tests assert the new words and that nothing is offered.

## Green

- The three files together: 167 passed, after one fix during the work (`github` was out of scope in `#adoptMoved`).
- One run of the three files together had a single failure: "records when the wait began and whether anything started, and forgets it once they pass". Its file has no change on this branch, and the test is timing-based. It passed twice when run alone. Attributed to machine load, and not hidden.
- `tsc --noEmit` for `apps/desktop`, `apps/web`, `packages/domain` and `packages/meta`: clean.
- `biome check` on the changed files: clean after `biome format`.

## Mutants

`python3 tools/mutants/run.py tools/mutants/owner-answers.json` has 12 mutants: the offer guard, the foreign flag forced off and forced on, each refusal reason dropped, each side of the commit count dropped, the words, the event, the domain fact, the view and the live line. **Result: 12 of 12 killed** (`python3 tools/mutants/run.py tools/mutants/owner-answers.json`).

## Not run

The full `pnpm check` / `pnpm test:a` / `pnpm test:b` did not run on this branch: the machine was loaded. Neither did the web screens. The web side reads the server's words, and its code is unchanged.
