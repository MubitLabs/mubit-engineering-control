# M2.2 verification

Builder's evidence only. Behaviour verification and the blockers-only review of the widened `confirm` decider and the card path belong to other agents.

## Gate

| Command | Outcome |
| --- | --- |
| `pnpm typecheck`, `biome check` | clean of errors |
| `pnpm test` | 2454 passed, 15 skipped, 1 failed: `login-cards.test.ts` "drives a real interactive shell through the seam", the pre-existing `posix_spawnp` failure |
| `pnpm --dir apps/web test:screens` under `/tmp/mec-screens.lock` | exit 0 |
| `python3 tools/mutants/run.py tools/mutants/m2.2.json` | 59 of 59 killed |

The base run also timed out once on `packages/runtime/test/shims.test.ts` under load. A process start can take 20 s in a full run here, which is why the input tests gate on stdin and the EOF test stands alone.

## Failing first

- Seen failing, then passing, on the fix: `shiftWaiting` (`expected [] to deeply equal ['answer', 'later']`), the planner-write redaction test, the field-name redaction test, and the `attach`, `attempt-launch` and runner tests the change moved.
- **Written beside the code, not ahead of it:** `scheduler`, `replan`, `followups`, `wakes-composed`, `claude-input`, `coordination` and `specialist-cards`. The suites and their source landed in one step. The mutants are the evidence that they see the behaviour, and two survived at first: the note handler and the timer's pass each got a test. `stdin never closes` read INVALID until the EOF test was split out.

## The verifier's four defects

Each test was run failing first, for its own reason, then passing: the receipt never left `read` and the composed follow-up run timed out, a wall-clock stop left the task `active`, a `failed` report launched the dependent, and the card named the planner. `test:screens` was not rerun for these: nothing in `apps/web` changed. No engine run was spent, so the two-block stdin line has been read only by the fake.

## The second verifier's two defects

Tests came first for both.

- **No-checks follow-ups.** Before the fix, five tests failed: both composed runs in `coordination.test.ts` timed out on `settled` and on the `message released` wake, and three unit tests in `followups.test.ts` failed. The sixth, checks still running keeps the message, passed before and after, and guards the other direction.
- **Wall clock.** Before the fix, the stored-plan launch test and the composed planner-budget test both timed out at 15 s. The seeded `wall_clock_ms` case passed before and after: the fallback was already right, and `seeded wall clock ignored` proves the test sees it.

New mutants, all killed: `no-checks attempt keeps its follow-ups`, `checks still running count as ended`, `plan wall clock ignored`, `seeded wall clock ignored`. No engine run was spent, and nothing in `apps/web` changed, so `test:screens` was not rerun.

Full runs on these commits, with other worktrees running mutants on the same machine: 2463 passed in `vitest run` once, with only the `login-cards` baseline failing, and twice `coordination.test.ts` "two-task contract chain" also failed on its 40 s wait, once alongside the `shims.test.ts` timeout already noted above. Alone, both suites pass. That chain takes 33.2 s here and 32.9 s on `eb46fd8`, so it has about 7 s of margin in a full run, and it passed both base runs. Neither fix is on its path, which has registered checks and no budget. Its wait was not changed.

## Assertions changed on purpose

- `service.test.ts` "attach": a follow-up with no attempt now queues one `relay`.
- `attempt-launch.test.ts`: the objective is read from the fake CLI's stdin, not argv.
- `attempt-runner.test.ts`: `deliver` no longer throws `NotWiredError`; `replay` still does.
- `composition.test.ts` "no handler": `deliver` and `note` have handlers, so they left the list.
- `specialist-tools.test.ts`: with no card path the tools still answer an error, with a different message.
- `server.test.ts`, `release-cards.test.ts`: approved cards now carry evidence, because an empty one answers 422.
- `apps/web/test/release-cards.test.ts`, `screens.playwright.ts`: the agent wording needs `continues: true`.
- `coordination.test.ts` "owned follow-up": `content` is now blocks, and the first is the text, unchanged.

## Real engine

No vendor run was spent. The stream-input facts in `CHANGE.md` come from `claude` 2.1.318 against a loopback stub of the API with a dummy key. The fixture from the verifier's run is still to come, and only that run can show a real model acting on a mid-run message.

The chain is proven with `contract` dependents only. `integration` dependents are proven with injected `integrated` state in unit tests and wait for M2.3.
