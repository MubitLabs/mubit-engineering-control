# The composed journey, and whether a worker can approve its own card

Handoff 33, Part B6. Base `4cba2e6`. Test tooling and records only: no product file changed.

## What changed

- `apps/web/test/journey.real.playwright.ts`, with `apps/web/playwright.journey.config.ts`, `apps/web/test/journey-rig.ts` and `apps/web/test/journey-gate.ts`: the journey on a server built from this tree, with no mocked routes. Scratch repository, `file://` bare behind a github.com `origin`, fake `gh`. Each test starts its own server on its own port, so the suite needs no screens lock.
- `apps/desktop/test/self-approval.real.test.ts`, with `apps/desktop/test/loopback-probe.ts`: a gated real test. A worker runs a script that POSTs an approve to a pending push card and reads the inbox.
- `apps/desktop/test/loopback-probe.test.ts` and `apps/web/test/journey-gate.test.ts`: the same probe on the fake CLI, and both gates. These run in `pnpm check`, and spend nothing.
- `tools/mutants/journey.json`.

## The handoff's premise that changed

The handoff says to run the journey on the fake engine, with `MEC_FAKE_ENGINE=1` in the scratch server recipe. That flag cannot run this journey. With it `launcher` is undefined (`apps/desktop/src/composition.ts:344`), so `delivery` is undefined too, and no card ever opens. It also pins the scripted brain, which never asks a question.

So fake mode here is `MEC_REAL_RUNNER=1` with a fake `claude` first on PATH: the real planner and runner over `packages/testkit/fake-cli/claude`, a copy each for the planner and the worker, the planner's scenario chosen by turn. The server is `apps/desktop/bin/mec.js`, unmodified.

## Gates

| Run | Gate | In CI |
| --- | --- | --- |
| Journey, fake | its own config, build first | no: `playwright.config.ts` does not match the file, and no workflow names it |
| Journey, real | `MEC_JOURNEY_REAL=1`; `journeyMode` throws when `CI` is set | no |
| Self-approval, real | `MEC_REAL_ENGINE=1` and `MEC_REAL_SELF_APPROVAL=1`, in `describe.skipIf` | skipped |

`serverEnv` refuses `~/.mec` and anything inside it in both modes, and carries in no `MEC_` or `GIT_` variable from the shell. Fake mode has a scratch `HOME`. Real mode keeps the real one, for the Keychain login (`00-README.md`), with a scratch data dir and a fake `gh`.

## Found

1. **The resolve route's only authority is loopback.** `POST /api/inbox/:id/resolve` takes no token. A plain `curl` with no browser headers passes the `onRequest` hook (`server.ts:573`). On the fake CLI, which has no sandbox, a worker's script approved a push card on the first request. So the sandbox alone stands between a worker and its own card, and only `self-approval.real.test.ts` can say whether it holds.
2. **A delivery ready for review reads "Working" on Work.** Spec §10's stage table says "Ready for review" for `person / review`. `stageOf` matches `latestReport === 'ready'`, a worker's report, and nothing reads the delivery's `ready` stage, so the row and the plan header stay Working once the PR is ready. The footer does say "Pull request ready for review, pull request #7". Pinned as an expected failure in `a delivery ready for review says so on its Work row`, which goes red when fixed. Not fixed here: a domain and server change, out of this handoff's scope. Fixed afterwards on `fix/work-row-ready`: `WorkFacts.deliveryReady` (set from the delivery stage in `apps/desktop/src/inspection.ts`) now matches the `person/review` row in `packages/domain/src/stages.ts`, the `test.fail()` marker is gone, and `tools/mutants/work-row-ready.json` holds the mutant.
3. **Chat gets no sentence when the PR is ready.** §23 step 8 has "Audit-log viewing is ready for review: PR #412." Nothing in `apps/desktop/src`, `packages/meta/src` or `packages/domain/src` writes one; delivery records a `pr_ready` event only. Not pinned by a test, since §23 is a worked example.

## Left open

- The real runs have not happened. No agent here spent one.
- `apps/web/package.json` has no `test:journey` script: this handoff's shared-file table does not list it.
- The Stage B records (`docs/STATUS.md`, `docs/log/HANDSHAKES.md` and friends) wait for the real pass.
