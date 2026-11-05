# M3.3 Stage A verification

5 November 2026, darwin, base `5be0ef8`. Run by the builder in an isolated worktree with synthetic values only. No real engine ran, nothing was pushed, and no credential was read or entered. Behaviour verification and the blockers-only review by other agents are still to do.

## Failing first

| Test | Red | Green |
| --- | --- | --- |
| Seven new `apps/desktop/test` files, `--project b` | 49 failed, 5 passed | All pass |
| `apps/web/test/config.screens.playwright.ts`, first run | 2 of 21 failed: a real bug (the Unsaved mark never updated) and one URL pattern in the test | 21 passed |
| `apps/web/test/config-contract.test.ts`, first runs | 1 of 4 failed twice: a wrong role name in the binding, and a preview `revision` that is a string, both real | 4 passed |

The red evidence is thin in one place. `config-model.test.ts` and `config-api.test.ts` were written in the same step as their modules and were never seen red for their own reason, so the web mutants below are what prove they see the behaviour. The five that passed in the first desktop run were the plain positives, such as a healthy Claude slot being accepted.

## After the change

| Command | Result |
| --- | --- |
| `pnpm check` | 1 failed, 2280 passed, 15 skipped. The failure is the permitted `login-cards.test.ts` node-pty case, `posix_spawnp failed` |
| `pnpm --dir apps/web test:screens`, under the lock | 229 passed, classic and next baselines unchanged |

New baselines: six files, Setup, Connections and Settings at 1440 in both themes, all synthetic. Three were read by eye, and the first reading found list markers, indented `dd` and a proportional font in the policy editor, all fixed.

## Mutants

`python3 tools/mutants/run.py tools/mutants/m3.3-config.json`: 18 mutants. The first run killed 17. `allow a non-Claude meta slot` survived because the `claude-sub` kind check refuses the same slot and the test's `/Claude/` also matched that message. The assertion now names the engine refusal.

Thirteen are the handoff's, five are added: `allow an unhealthy meta slot`, `a stale failure loses the draft`, `a read moves a draft onto the newer version`, `an unread capability reads as available`, `retire opens on a near match`.

## Playwright gates, by hand

Each mutation was applied, its test run, and the file restored.

| Gate | Mutation | Test | Result |
| --- | --- | --- | --- |
| `one-click retire` | Retire calls `commands.retire` | `retire arms, names the loss and disarms` | Failed, as it should |
| `saved shown before the server confirms` | `saveStarted` becomes `saveSucceeded` | `saved is not shown before the server confirms` | Failed, as it should |
| `draft lost on 409` | `saveFailed` clears the draft | `a stale save keeps the draft and says so` | Failed, as it should |

## Scratch server

Built tree, scratch `HOME` and `MEC_DATA_DIR`, `MEC_FAKE_ENGINE=1`.

| Step | Observed |
| --- | --- |
| Clean first run | `capabilities`: backups and pause true, the rest false. Engines `done`, the other four `missing`, Finish off with the reason |
| Register a repository with a check | 200 |
| `propose policy {...}` through setup chat | A pending `policy_change` draft. Policy stayed `default`, revision 0 |
| Apply with the base | Policy `saved`, revision 1, `restartRequired: true` |
| `POST /api/backups` | `done`. The archive lists `db.sqlite` and no key, credential or `auth.json` entry |
| Pause, then restart | `paused: true` with its `pausedAt` after restart. Policy revision 1, `restartRequired: false`. Resume ran |

The UI was driven only against the in-page sample server, not this server. Driving it at `?ui=next` on a scratch server is the verifier's.

## Unverified

- A real sign-in, a real key, Replace key and Validate on a real provider. These are the owner's steps.
- A real `claude auth status` or `codex login status` through the probe route: only fake runners here.
- The sign-in card end to end. The pty seam is covered by existing tests. Playwright covers the card opening and the failed start against the sample server, which has no login stream, so output, the URL link and the end of a sign-in are not shown there.
- A failed sign-in start on a scratch server after the fix. The harness answers the 500; `posix_spawnp failed` on this checkout was seen before the fix only.

## Verifier fixes

Behaviour verification on a scratch server found three defects. Each was fixed test first.

| Defect | Red | Green |
| --- | --- | --- |
| A failed sign-in start left the card waiting with no error, in Setup and on Sign in again | `a sign-in that fails to start…`, `Sign in again that fails to start…` failed | Pass |
| The server's validation reason never reached the screen, on policy save, models save and proposal Apply | 3 of 18 in `config-api` and `config-contract` failed, and `a refused save…`, `a refused proposal…` failed | Pass |
| Open Repositories landed on Policy | `Open Repositories lands on Repositories` failed | Pass |

The first fix differs from the two the verifier suggested. Clearing the card on failure remounted the form, so it lost the chosen path and name, and the first green run failed on that. The card now opens only after `POST /api/slots/login` answers.

The contract tests read `failureText` against the real routes, so the always-confirm, proposal and bad YAML wordings are the server's own. The sample server copies those words for the screens.

| Command | Result |
| --- | --- |
| `python3 tools/mutants/run.py tools/mutants/m3.3-config.json` | 22 of 22 killed, four of them new: `the error reader drops detail`, `an empty detail counts as a reason`, `the screen shows only the error code`, `detail replaces the error text` |
| `pnpm check` | 1 failed, 2285 passed, 15 skipped. The failure is the permitted `login-cards.test.ts` node-pty case |
| `pnpm --dir apps/web test:screens`, under the lock | 235 passed, classic and next baselines unchanged |

Playwright gates, by hand. Each mutation was applied, its test run, and the file restored.

| Gate | Mutation | Tests | Result |
| --- | --- | --- | --- |
| `card before the start` | The card opens before `startLogin` | Both failed-start tests | Failed, as they should |
| `failure swallowed` | The catch sets no error | Both failed-start tests | Failed, as they should |
| `section not set` | Setup leaves `store.section` alone | `Open Repositories lands on Repositories` | Failed, as it should |
| `detail not shown` | `failureText` returns the error text alone | `a refused save…`, `a refused proposal…` | Failed, as they should |

## Proposal comparison

Verification found that a proposal showed its patch and not a comparison. Fixed test first.

| Test | Red | Green |
| --- | --- | --- |
| `policy-routes`: six of the seven first written in `GET /api/setup/drafts compares each proposal…`. `has nothing to compare…` guards against a preview and passed throughout. `a stored text that no longer loads…` came after the first green, so its red is the `a bad stored text fails the list` mutant | `preview` undefined; `a stale comparison cannot apply` answered 400, not 409 | Pass |
| `config-model`: `applies against the version its comparison was drawn from…` | `proposalBase is not a function` | Pass |
| `config-contract`: `reads a proposal's comparison…` | `preview` undefined | Pass |

| Command | Result |
| --- | --- |
| `python3 tools/mutants/run.py tools/mutants/m3.3-config.json` | 33 of 33 killed, 11 new |
| `pnpm check` | 1 failed, 2295 passed, 15 skipped. The failure is the permitted `login-cards.test.ts` node-pty case |
| `pnpm --dir apps/web test:screens`, under the lock | 239 passed, baselines unchanged. The four new screen tests were written after the code, so their red is the gates below |

Playwright gates, by hand, each restored after its run.

| Gate | Mutation | Tests | Result |
| --- | --- | --- | --- |
| `plain patch` | `Proposals` always prints `draft.diff` | `a proposal marks what it replaces…` and the three that read the comparison | 4 failed, as they should |
| `no redraw on save` | The base change refreshes nothing | `saving an edit redraws a proposal…` | Failed, as it should |
| `apply with newest read` | `proposalBase` prefers the newest read | `Apply answers for the comparison on screen…` | Failed, as it should |
| `no redraw on stale` | The stale branch does not refresh | `a stale proposal says so…` | Failed, as it should |

Real routes, on a rebuilt scratch server with `MEC_FAKE_ENGINE=1`: saved a policy with `install: repo_a`, then sent `propose policy` with `repo_prop` through `POST /api/chat/messages` with `setup: true`. The draft's `preview` showed `repo_a` before and only `repo_prop` after. That run read the route, not the screen. Apply itself is covered by the route and contract tests.

Not observed: a proposal on the real route in a browser, a models or prompts proposal on a scratch server, and a prompts part with a long text on screen.

## Proposal trust and folded comparisons

Fixed test first.

| Test | Red | Green |
| --- | --- | --- |
| `repository-edit`: `a proposal cannot trust a repository` | `expected true to be false` | Pass |
| `repository-edit`: `says so on the card…` | `trustIgnored` undefined | Pass |
| `repository-edit`: `the setup agent's own tool…`, `the owner's own form…` | Guards on behaviour that must not move, so they passed throughout | Pass |
| `config-contract`: `reads that a proposal carried a trust setting…` | `trustIgnored` undefined | Pass |
| `config-model`: five `compare` tests of `foldDiff` | `foldDiff is not a function` | Pass, after correcting one expected length of ours: a leading run of five does fold |
| `config.screens`: `a one-line change in a long table…` | First change past the block's height | Pass |
| `config.screens`: `a folded comparison opens and closes…` | No fold control | Pass |
| `config.screens`: `a repository proposal that carried trust…` | No note on the card | Pass |
| `config.screens`: `a prompts comparison folds the same way` | Passed at first, because its sample changed the first line. Rewritten on a long default; its red is the `view does not fold` gate | Pass |

| Command | Result |
| --- | --- |
| `python3 tools/mutants/run.py tools/mutants/m3.3-config.json` | 43 of 43 killed, 10 new |
| `pnpm check` | 1 failed, 2305 passed, 15 skipped. The failure is the permitted `login-cards.test.ts` node-pty case |
| `pnpm --dir apps/web test:screens`, under the lock | 243 passed, baselines unchanged |

Playwright gates, by hand, each restored after its run.

| Gate | Mutation | Tests | Result |
| --- | --- | --- | --- |
| `view does not fold` | `DiffView` maps `lines` directly | `a one-line change…`, `a folded comparison…`, `a prompts comparison…` | 3 failed, as they should |
| `card omits the note` | The `trustIgnored` branch never renders | `a repository proposal that carried trust…` | Failed, as it should |
| `a fold never opens` | The open lines never render | `a folded comparison…` | Failed, as it should |

Not observed: either change in a browser on a scratch server. The screen tests use the sample server, and the route and contract tests use the real routes.

## A check and a retire

Fixed test first, in `slot-sensitive.test.ts`, with the check held open at a gate while the other request lands.

| Test | Red | Green |
| --- | --- | --- |
| `a local probe that finishes afterwards…` | 200, not 409 | Pass |
| `a local probe keeps what was saved while it ran` | The label saved meanwhile was lost | Pass |
| `a local probe answers 409 when the slot is gone` | 200, not 409 | Pass |
| `a provider answer of 200` and `of 401…does not bring the slot back` | 200, not 409 | Pass |
| `a key replacement says the slot was retired…` | `probe` was `{ ok: true }` | Pass |
| `a provider answer of 200…keeps a key replaced while it ran` | `abcd`, not `wxyz` | Pass |
| `a provider answer of 401…keeps a key…` | Added after the first green, so its red is the `a rejected check builds on the captured doc` mutant | Pass |

| Command | Result |
| --- | --- |
| `python3 tools/mutants/run.py tools/mutants/m3.3-config.json` | 52 of 52 killed, 9 new |
| `pnpm check` | 1 failed, 2313 passed, 15 skipped. The failure is the permitted `login-cards.test.ts` node-pty case |

Not run: `test:screens`, because no web file changed, and any engine, because the routes are tested with a fake probe and a fake provider.
