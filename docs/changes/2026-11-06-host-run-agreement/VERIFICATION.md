# Host-run agreement: verification

On macOS, with fake engines only. No real engine ran and none of the budget was spent. The machine stayed loaded throughout: load average 15 to 22, with other agents' suites running. CI is the gate, as the owner ordered. The builder ran this, so the separate verifier the handoff asks for has not run, and the blockers-only review is still to come.

## Failing first

Each ran before its change.

```text
Item 6. apps/desktop/test/real-runner.test.ts
{ MEC_REAL_RUNNER: 'false' } reads as on: false, AssertionError: expected true to be false

Item 4. real-runner.test.ts, then delivery.test.ts
AssertionError: expected '/tmp/agent.sock' to be undefined
a combined check gets no SSH agent socket: expected { …(3) } to match object { passed: false }

Items 1 and 2. apps/desktop/test/host-run-agreement.test.ts: 12 failed, 2 passed
a ready task with no attempt: expected [ { id: 'att_1', …(8) } ] to have a length of +0 but got 1
a queued attempt with its launch row: expected undefined to be 'waiting'
an attempt a shutdown interrupted: expected undefined to be 'waiting'
a work item an agreement finds parked: expected 2 to be 1
a head whose checks were cut short: expected undefined to be 'waiting'

Item 5. apps/desktop/test/approval-key.test.ts: 10 failed, 5 passed
/api/inbox/…/resolve refuses a caller with no key: expected 422 to be 403
/api/release/push/…/resolve, pr, merge: expected 400 to be 403
a deny needs the key too: expected 200 to be 403
agreeing needs the key: expected 200 to be 403
```

The capacity tests and the item 3 screen were written with their code, so they did not fail first. Their mutants below are what shows they see the change.

## After

Run one worker at a time, because under the load a fake CLI's first start took over 20 s and the existing 20 s bounds failed:

| Suite | Result |
| --- | --- |
| `recovery`, `coordination`, `attempt-launch`, `engine-registry`, `loopback-probe`, `approval-key`, `host-run-agreement`, and `supervisor`, `live-park` and `attempt-runner` in runtime | 287 of 288. The one failure is below. |
| `composition`, after its seed got a repository | 28 of 28 |
| `pause-attempts` | 5 of 5 |
| `packages/meta` | 308 passed, 1 skipped |
| `apps/web`, `packages/domain` (project a) | 642 of 642 |
| `apps/web/test/config.screens.playwright.ts`, with the new agreement screen | 39 of 39 |
| `pnpm typecheck`, `biome check .` at error level | clean |

- The one failure: `engine-registry` "a slot of its own runs under its home" could not find the fake CLI's `seen.json`. Alone, it passed. It is load-shaped, not proven so.
- `pnpm check` as a whole was not run to a clean result here. All-at-once runs at load 15 to 22 failed with timeouts, 20 s bounds and `Failed to start forks worker`. Each failing test passed when run alone or in the table above. CI has to confirm the whole.
- **Tests changed on purpose.** Repository fixtures gained `hostRunAgreedAt` because an unagreed repository now runs nothing, and owner-side resolve calls gained the key. `stages.test.ts` gained the new stage row. `inspection-contract` expects the `agreement` need, and one `inspection.test.ts` count agrees first.
- `loopback-probe.test.ts` changed meaning: the fake CLI, with no sandbox, used to approve its own card. Now the route answers `403 approval_required`, `http=403` is in the worker's output, and the card stays `pending`. That is the retest the owner asked for, on a real child process.

## The key, from outside

A built server, scratch `HOME` and data dir, `--approval-key-fd=3`, a key handed in over a pipe:

```text
{"noKey":403,"withKey":404,"files":5,"onDisk":0,"printed":false}
```

`withKey` is a 404 for a card that does not exist, so the route ran. `approval-key.test.ts` also spawns a real child that reads every file in the data dir and calls loopback with and without browser headers, and finds neither the key nor the code.

## Mutants

`python3 tools/mutants/run.py tools/mutants/host-run-agreement.json`: all 46 killed. The first full run gave 43: two hit the runner's 300 s bound, and "agreeing leaves rows asleep" survived because the test bounds had grown past the 30 s look. That one got its own test, and all three now run on a narrowed `-t` and were killed in a second run. The full spec was not rerun after that change.

`tools/mutants/real-runner-default.json`: 9 of 9 killed, with its `find` updated for the new line.

The second run found a real bug on the way: a withdrawal during a recheck re-enqueued the row it was running on, and the queue drains a same-payload enqueue, so the row was lost. The recheck now throws `Later`, and a mutant covers it.

## Not proven

- The real `osascript` link was never run, so no real browser has taken a key from a link. The `Link this browser` flow is proven up to the seam: the page logic in a stand-in window, and the server with a fake opener. The sandbox refused a compile-only check of the script.
- `mec restart` itself: the test closes one `startServer` and opens another, and shows a new key is needed.
- Real engines, and the sandboxed real-Claude probe in `self-approval.real.test.ts`.
- `journey.real.playwright.ts`, including its fake mode: the rig was changed to use the deliberate path and was not run.
- Checks and setup on a real repository's own commands, beyond these scratch ones.
- The classic shell.
