# Verification

Branch `fix/codex-sandbox` on base 29f1588. The builder ran all of this on 9 November 2026. Nothing touched `~/.mec` beyond reading att_7's events and journal, and nothing touched the server on 61610. No credential was read: nothing under `~/.codex` or any `keys/` was opened, and the mock provider carried a dummy key, checked equal by the mock without printing any header. Nothing was pushed.

## The faults, from the store (read only)

`sqlite3 ~/.mec/mec.db` on `attempt:att_7`:
- three `tool_call fileChange` with `input: null, ok: false`, and no `permission_request` anywhere in the stream;
- `node --test` output: `Error: EPERM: operation not permitted, lstat '<home>/.mec/work'` at `realpathSync`;
- report `blocked`.

## The sandbox, zero tokens (`codex sandbox -P mec`, the profile `codexAttemptArgs` builds, scratch data dir)

| Probe | Old profile | New profile |
| --- | --- | --- |
| `node --test` in the worktree (`"type": "module"`) | fails, `uv_cwd`/EPERM | passes, rc 0 |
| `ls -ld <data>/work` | Operation not permitted | allowed |
| fs helper `fs/canonicalize` of a worktree file | `Operation not permitted (os error 1)` | ok |
| `cat <data>/mec.db`, `cat <data>/engines/…/keys/k.key`, `ls <data>/engines` | refused | refused |
| `touch` in own worktree / own temp dir | ok | ok |
| `touch` in own `.mec` | refused | refused |
| `cat` / `ls` of a sibling, for 15 names in each of `work` and `tmp` (att_2, att_10, att_, att, a, btt_1, att-1, att_1x, .mec, .hidden, integration-1, x, A, aTT_2, Att_1x) | refused | refused (all 30) |
| a sibling made 2 s after the sandbox started | refused | refused |
| `ls <data>/work` | refused | lists names (see Risks in CHANGE.md) |

Glob rules came from the same tool:
- `work/*` refused `att_2` but not `att_2/.mec/mcp.json`;
- `work/**` refused writes inside `work/att_1="write"`;
- `[!a]` worked and `{a,b}` did not.

An early probe made `work/ATT_1` on a case-insensitive volume. That is the own worktree, so it reads as allowed; the probe was rebuilt without it.

## Through the real app-server and the real launch path, mock model (zero tokens)

- First a scratch harness driving `codex app-server` directly, then `apps/desktop/test/codex-sandbox.mock.test.ts` (`MEC_REAL_CODEX_MOCK=1`), which runs the real launch path. It uses the linked default login only for `login status`.
- The mock Responses API plays an `apply_patch` (two absolute-path adds), then `exec_command node --test`.

Results:
- **Red with the old fence** (`dirname(worktree)` denied, applied by hand to the source and then restored): the fileChange `completed`, and `node --test` exited 1 with `EPERM ... lstat '<data>/work'`, att_7's error. Like att_7, the failed command left no item.
- **Green now**, in both patch forms (custom tool, and shell `apply_patch <<'EOF'`): fileChange `ok: true`, and `node --test` 1 of 1 passing.
- A scratch harness covered profile {old, new} × path {relative, absolute} × data dir {plain, under the `/var` symlink}, with `TMPDIR` as MEC sets it, and with the linked home's config: **every fileChange completed**. The parent deny does not fail a fileChange.

## Real runs (logged before each in `docs/changes/2026-11-05-meta-agent-journeys/handoffs/engine-runs.md`)

Both runs used `MEC_REAL_CODEX=1 apps/desktop/test/codex-sandbox.real.test.ts`, the linked default login and `gpt-5.6-luna`.

1. **Codex run 9**, new profile, 23 s. The one fileChange (two adds) came back `ok: false`, and the turn stopped as told. No canary appeared in any event or data-dir file. Cause unknown: the report said only "apply_patch operation failed".
2. **Codex run 10**, new profile, raw stream teed, 43 s:
   - The fileChange (shell `apply_patch`, item `exec-…`) came back `completed`, `ok: true`.
   - `node --test` in the worker's shell passed 2 of 2, `ok: true`.
   - The sibling `.mec/mcp.json` read answered `Operation not permitted`, exit 1.
   - The model declined to run the slot-key read; that fence is shown by the sandbox probes above.
   - No canary appeared in any event or data-dir file.
   - The test failed only on its own wait. It took `work_complete` (agent done, checks pending) as settled and asserted `succeeded`. Fixed to wait past it, and not re-run: no runs left.

## Failing first

| Test | Red |
| --- | --- |
| `packages/runtime/test/codex-client.test.ts` "refuses reading sibling…", "leaves the parents… readable", "refuses an attempt name it cannot spell" | 3 red: own tree covered by the parent deny, `"/data/work"="deny"` present, no throw |
| `packages/engines/test/codex.test.ts` "a fileChange item in the journal" (3) | 3 red: no event for an applied change, `input: null` for a failed one; then red again when `status` was added |
| `codex.test.ts` escalation_declined conformance | red until the fixture's expected line named path, kind and status |
| `apps/desktop/test/engine-registry.test.ts` "the profile refuses sibling attempts…" | changed from asserting the parent deny to asserting no parent deny plus the sibling globs |
| `codex-sandbox.mock.test.ts` | red with the old fence (EPERM), green now |

## Mutants

`python3 tools/mutants/run.py tools/mutants/codex-sandbox.json`: **14 of 14 killed**. The self-check reported SURVIVED for the no-op and INVALID for the syntax error, as expected.

## Suites

- `pnpm typecheck` clean. `biome check .`: no errors.
- `pnpm test` (full, default parallelism): 3782 passed and 34 failed, in 12 files. The failures were all spawn and PTY timeouts at 25–120 s: supervisor, live-park, attempt-runner, codex-client's fake-CLI client, and the desktop launch and recovery files.
- Re-run alone, the 4 runtime files passed (92 tests), and the 8 desktop files at `--maxWorkers=4` passed (261 tests). Load, not this change.
