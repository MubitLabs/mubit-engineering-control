# Codex runs by its real path, so its file edits apply

Branch `fix/codex-filechange` from `origin/main` ef1e309. No contract change (`packages/contracts` untouched), no fixture change, no migration, no web change.

## What went wrong

Real Codex 0.148.0 attempts had their file edits fail: a `fileChange` item with status `failed`.

- 0.3.5 att_7 (`gpt-5.6-luna`): three adds, all failed. Codex then wrote the files with python3.
- 0.3.6 att_10 (`gpt-5.6-terra`): two adds of three files each, both failed. Codex then wrote the files from code mode.
- 0.3.7 att_15 (`gpt-5.6-terra`): one update. It failed before any item was made, so the journal shows nothing. Codex then edited with perl.
- Codex run 9 (a canary on `fix/codex-sandbox`): one add, failed.
- Codex runs 10 and 11 (the same canary): the add completed.

Every native fileChange the installed server ever recorded failed: 5 of 5.

## Cause

**The app-server was started by a link into a directory the profile denies.**

- MEC finds the engine on PATH and launches that path (`resolveBinary`, `apps/desktop/src/attempt-launch.ts`). On this machine that is `~/.local/bin/codex`, a link to `~/.codex/packages/standalone/current/bin/codex`.
- The attempt profile denies `~/.codex` (`defaultDenyRead`, `packages/runtime/src/isolation.ts`). That deny is right: it holds the login.
- Codex applies a patch through a sandboxed fs helper. It starts the helper by re-execing its own path under the profile. Started by the link, that exec has to resolve a link inside the denied `~/.codex`, so the helper cannot start.
- Started by its real path, the helper starts and the patch applies, with the same deny in place. That was seen with the mock model. The profile Codex records already adds read entries of its own under `~/.codex/packages/standalone/releases/0.148.0-…`. Why those entries cover the real path and not the link is inferred, not read from Codex's source.

The evidence, all read only:
- att_7's and att_10's rollouts in the slot home (`sessions/…/rollout-*.jsonl`): every `patch_apply_end` says `success: false` with stderr `Failed to write file <worktree>/<file>`. The model got the same text.
- The slot home's `logs_2.sqlite`, for each failed patch: `codex_sandboxing::violation … backend=seatbelt reason=failed_to_write_file`.
- att_15, an update, in the same log: `apply_patch verification failed: Failed to read file to update …/app.js: fs sandbox helper failed with status exit status: 71: sandbox-exec: execvp() of '<home>/.local/bin/codex' failed: Operation not permitted`. That names the path.

**It was never intermittent.** Run 9 had no `MEC_CODEX_RAW_OUT`, so MEC launched the link, and it failed. Runs 10 and 11 set `MEC_CODEX_RAW_OUT`. That puts a tee wrapper on PATH that runs `realpathSync(codex)`, so they ran by the real path and passed. The earlier mock harness did the same (`realCodex()` realpathed), which is why it could not reproduce the failure.

What it is not:
- Not the patch: att_7's exact patch passes when Codex runs by its real path.
- Not the patch form: code mode `exec`, the bare `apply_patch` tool and shell `apply_patch <<'EOF'` all fail by the link and all pass by the real path.
- Not the paths: absolute and relative, and the data dir under `/var` or `/private/var`.
- Not an approval: no approval was asked.
- Not the sibling fence from #68.

## What changed

- **`apps/desktop/src/engine-registry.ts`**, the Codex row's `connect`: the app-server is started with `realpathSync(binary)`. Only the app-server changes. The probe, `mcp list` and `model/list` start no patch, so they still run by the path MEC found. No other engine changes.
- **`docs/engines.md`**: the note "a fileChange failed in a real run for a reason the stream does not say" is replaced. The new note gives the cause, where the error text can be read, and that gpt-5.6 models send patches in code mode.

## Tests

- **`apps/desktop/test/engine-registry.test.ts`, "the app-server runs by its real path, not by a link on PATH"**: the fake codex sits behind a link on PATH, and the test checks that the app-server was started by the real file.
- **`apps/desktop/test/codex-sandbox.mock.test.ts`** (`MEC_REAL_CODEX_MOCK=1`, real binary, mock model, zero tokens):
  - The wrapper now sits behind a link on PATH, as the real install does. It runs codex by the link when MEC launched the link, and by the real path otherwise. So the harness sees MEC's choice instead of hiding it.
  - The default patch form is code mode (`exec` with `tools.apply_patch`), the form every real patch in the store used. `MOCK_FORM=custom` and `MOCK_FORM=shell` keep the other two.
  - A second patch updates a file the first one added, as att_15's did.
  - The test asserts that both fileChanges are ok and that the model never heard "Failed to write file".
- **Mutants**: `tools/mutants/codex-filechange.json` (unit) and `tools/mutants/codex-filechange-mock.json` (run with `MEC_REAL_CODEX_MOCK=1`).

## Risks

- **Link-to-version pinning.** The real path names one release, `releases/0.148.0-…`. A self-update between the probe and the start would run the version the link pointed to at start. Both are resolved at the same launch, and the drift check still pins 0.148.0.
- **A machine with no link** sees no change: `realpathSync` of a plain file is that file.
- **A binary that disappears** between `resolveBinary` and the start makes `realpathSync` throw, and the launch fails as it would have at spawn.
- **Open, not changed here:** att_10's `python3 - <<'PY'` failed with `zsh: can't create temp file for here document: operation not permitted`. zsh puts here-documents under `TMPPREFIX` (default `/tmp/zsh`), not `TMPDIR`, and the profile does not let the attempt write `/tmp`. That is a separate fault, recorded for a later lane.
