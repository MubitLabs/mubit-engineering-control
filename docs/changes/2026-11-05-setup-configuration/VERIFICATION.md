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
- The sign-in card end to end. The pty seam is covered by existing tests, and the new card has no Playwright test because the harness has no login stream.
