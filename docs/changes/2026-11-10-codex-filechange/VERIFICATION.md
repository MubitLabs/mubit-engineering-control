# Verification

Branch `fix/codex-filechange` on base ef1e309. The builder ran all of this on 10 November 2026.

- Nothing wrote to `~/.mec`, and nothing touched the server on 61610.
- No credential was read. Nothing under `~/.codex` was opened. Under the slot home only `sessions/` rollouts and `logs_2.sqlite` were read, never `auth.json` or `keys/`, and from them only the apply_patch calls, their results and the turn's sandbox fields.
- The mock provider carried a dummy key.
- No real Codex turn was spent, so Codex runs 16, 17 and 18 are unused.
- Nothing was pushed.

## The failure, from the store and the slot home (read only)

`sqlite3 -readonly ~/.mec/mec.db`, every `tool_call fileChange`:

| Attempt | Version | Items | Status |
| --- | --- | --- | --- |
| att_7 | 0.3.5 | 3 | `input: null, ok: false` (before #68 kept status) |
| att_10 | 0.3.6 | 2, three adds each | `failed` |
| att_15 | 0.3.7 | none | its one update failed before an item |
| att_9, att_14 | | none | |

No completed fileChange exists in the store.

Rollouts in `~/.mec/engines/codex/codex-1/sessions/2026/11/09/` (att_7 `01a1c0e6-…`, att_10 `01a1c182-…`):
- Every patch was sent in code mode: `exec` with `text(await tools.apply_patch(patch))`. att_7's third try was `tools.exec_command({cmd: "apply_patch <<'PATCH' …"})`.
- Every `patch_apply_end` had `success: false` and stderr `Failed to write file <worktree>/<first file>`, with absolute and with relative paths alike.
- att_10's `turn_context` holds the full profile: `write` on the worktree and temp dir, `deny` on `<home>/.codex`, and Codex's own `read` entries under `~/.codex/packages/standalone/releases/0.148.0-…/codex-resources/zsh` and the slot's `tmp/arg0`.

`logs_2.sqlite` in the same home:
- each failed add: `codex_sandboxing::violation … backend=seatbelt reason=failed_to_write_file`;
- att_15's update: `apply_patch verification failed: Failed to read file to update …/app.js: fs sandbox helper failed with status exit status: 71: sandbox-exec: execvp() of '<home>/.local/bin/codex' failed: Operation not permitted`.

`ls -la ~/.local/bin`: `codex -> <home>/.codex/packages/standalone/current/bin/codex`.

Why runs 10 and 11 passed and run 9 failed: `codex-sandbox.real.test.ts` puts a tee wrapper ahead on PATH only when `MEC_CODEX_RAW_OUT` is set, and that wrapper runs `realpathSync(codex)`. Run 9 did not set it. Runs 10 and 11 did.

## Reproduced at zero tokens (mock model, real binary, real launch path)

`MEC_REAL_CODEX_MOCK=1 pnpm exec vitest run apps/desktop/test/codex-sandbox.mock.test.ts`. The patch is two absolute adds, plus a second patch that updates one of them where the row says so.

| Codex started by | Patch form | Result |
| --- | --- | --- |
| real path (old harness) | bare `apply_patch` | completed |
| real path (old harness) | code mode `exec` | completed |
| real path (old harness) | att_7's exact patch text, code mode | completed |
| `~/.local/bin/codex` link | code mode `exec` | **failed**: "Failed to write file …/gallop.js" |
| `~/.local/bin/codex` link | bare `apply_patch` | **failed**, same text |
| `~/.local/bin/codex` link | shell `apply_patch <<'EOF'` | **failed**, same text |
| link on PATH, new harness, before the fix | code mode | **red**: `expected '[{"type":"custom_tool_call_output"…' not to contain 'Failed to write file'` |
| link on PATH, new harness, after the fix | code mode, add then update | green |
| link on PATH, new harness, after the fix | bare `apply_patch`, then update | green |
| link on PATH, new harness, after the fix | shell, then update | green |
| link on PATH, new harness, after the fix | code mode, data dir under `/var` (`MOCK_NO_REALPATH=1`) | green |

## Failing first

| Test | Red | Green |
| --- | --- | --- |
| `engine-registry.test.ts` "the app-server runs by its real path, not by a link on PATH" | `Expected: "…/store/codex"`, `Received: "…/bin/codex"` | yes |
| `codex-sandbox.mock.test.ts` (gated) | "Failed to write file", as in att_7 | yes |

## Mutants

| Spec | Result |
| --- | --- |
| `python3 tools/mutants/run.py tools/mutants/codex-filechange.json` | **2 of 2 killed** |
| `MEC_REAL_CODEX_MOCK=1 python3 tools/mutants/run.py tools/mutants/codex-filechange-mock.json` | **2 of 2 killed** |
| `--self-check` | SURVIVED for the no-op and INVALID for the syntax error, as expected |

The two mutants are: start by the link again, and `path.resolve` in place of `realpathSync` (absolute, but the link is kept).

## Suites

- `pnpm typecheck`: clean.
- `biome check .`: no errors. 146 warnings, the 3 new ones `noTemplateCurlyInString` on patch text in the mock, the same kind as the line already there.
- Affected files together: `engine-registry`, `attempt-launch`, `engines/codex`, `runtime/codex-client`: 4 files, 174 passed.
- `pnpm test` (full, default parallelism): 3772 passed and 35 failed, in 12 files. Every failure was a spawn, PTY or worker timeout: `Test timed out`, `Timeout waiting for worker to respond`, `condition never held`, `pid file never appeared`. They were in supervisor, live-park, attempt-runner, codex-client's fake-CLI client, and the desktop launch, coordination, recovery and composition files. This is the same set the 9 November lane saw on this loaded machine.
- Re-run alone at `--maxWorkers=4`:
  - the 4 runtime files passed, 92 tests;
  - the 8 desktop files passed, 263 tests, the new test included.

  The failures came from load, not from this change.
