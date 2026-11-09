# Codex sandbox: a worktree's parent stays stattable, and a fileChange says what it was

Branch `fix/codex-sandbox` from `origin/main` 29f1588. No contract change (`packages/contracts` untouched), no migration, no web change.

## What went wrong

Installed 0.3.5, att_7: a Codex specialist (codex-cli 0.148.0, ChatGPT sign-in, `gpt-5.6-luna`) in `~/.mec/work/att_7`, on MubitLabs/mec-sandbox (`"type": "module"`, `node --test`). Two faults showed in the store:

1. **`node --test` died `EPERM: operation not permitted, lstat '<home>/.mec/work'`.** The attempt reported `blocked`. No Codex specialist could run a Node check in an MEC worktree.
2. **All three fileChange (apply_patch) items came back `{"tool":"fileChange","input":null,"ok":false}`.** Codex then wrote the files with python3.

## Causes

**Fault 1: the profile denied the worktree's parent.** `codexAttemptArgs` (`packages/runtime/src/codex-client.ts`) fenced sibling attempts by denying `<data>/work` and `<data>/tmp` whole, with this attempt's own worktree and temp dir set to `write`. On 0.148.0 a `deny` refuses `file-read*` on the path itself, lstat included. Node's module resolution realpaths every ancestor, so it failed on `<data>/work`. Seen in `codex sandbox -P mec` with the profile `codexAttemptArgs` builds, on a scratch data dir:
- `node --test` failed and `ls -ld <data>/work` was refused under the old profile;
- the sandboxed fs helper's `fs/canonicalize` of a worktree file answered `Operation not permitted`.

The fence was deliberate, and still needed: `:root` reads, and a sibling's `.mec/mcp.json` holds a live bearer token. The slot homes, keys and store database are fenced by the deny list (`defaultDenyRead`), not by this entry, and that list is unchanged.

**Fault 2: the journal dropped the item, and the cause is not established.**
- The mapping (`packages/engines/src/codex/protocol.ts`) wrote any declined or failed fileChange as `input: null`. It wrote nothing at all for an applied one. So the store could not say which files were meant, or whether the item was declined or failed.
- No approval was asked in att_7, so the bridge did not refuse it.
- The parent deny is not the cause either. The same patches completed under the old profile and under the new one, through the real app-server and through MEC's real launch path with a mock Responses API (zero tokens). Both the custom-tool and the shell `apply_patch` forms were tried, with absolute and relative paths.
- In the real runs: Codex run 9 (new profile) failed its one fileChange, and run 10 (new profile, same task) completed it.
- The item carries no error text. `item/fileChange/outputDelta` is deprecated and no longer emitted, and the model quoted no error in either run.

## What changed

**The profile** (`packages/runtime/src/codex-client.ts`):
- New `siblingDenyGlobs(path)`. It denies every entry of the path's parent except the path itself, and leaves the parent readable.
- The rules it has to work under, all seen in `codex sandbox`: Codex globs only deny, `*` and `?` stop at `/`, `[!c]` is the one negation, braces do not expand, and a glob beats any path entry.
- So the complement is spelled out, each name both as an entry and with `/**` for its tree:
  - a name that leaves this one at character *i*: `att_[!1]*`;
  - a name that stops short of it: `att[_]`;
  - a name that runs past it: `att_1?*`.
- A name containing anything outside `[A-Za-z0-9._-]` refuses the launch (`cannot fence`), so nothing is fenced loosely.
- `codexAttemptArgs` uses these globs for the worktree and the temp dir in place of the two whole-parent denies. Everything else in the profile is unchanged.
- A glob is a seatbelt regex, so it also refuses a sibling made after the launch (probed).

**The journal** (`packages/engines/src/codex/protocol.ts`): every completed fileChange item becomes `tool_call fileChange` with `input: {changes: [{path, kind}], status}`, `ok` only when the status is `completed`. The diff stays out, because the head shows it.

**Fixture**: `codex/0.148.0/escalation_declined/events.jsonl`, the one fileChange line: its expected event now names the path, the kind and `declined`. `raw.jsonl` is unchanged, and `meta.json` notes the change.

**Tests**:
- Runtime unit tests on the profile. Each sibling name, and its `.mec/mcp.json`, is refused, using a matcher written to the glob rules observed above; this attempt's own tree and both parents are not refused; a name that cannot be spelled is refused.
- An engine-registry launch test.
- Engine parser tests for applied, failed and declined fileChange items.
- `apps/desktop/test/codex-sandbox.mock.test.ts` (`MEC_REAL_CODEX_MOCK=1`, zero tokens): the real launch path and the real binary, with a mock model doing a fileChange and then `node --test`. It is red with the old fence (att_7's EPERM) and green now.
- `apps/desktop/test/codex-sandbox.real.test.ts` (`MEC_REAL_CODEX=1`, spends one turn): the att_7 shape on a scratch data dir, plus two canaries for the fence. `MEC_CODEX_RAW_OUT` can keep the raw stream.

**Docs**: `docs/engines.md` gets three notes under Codex 0.148.0: a deny refuses its own lstat, the glob rules, and the fileChange failure the stream does not explain.

## Risks

- **Sibling names stay listable.** `ls <data>/work` lists the names under it, attempt ids such as `att_9`. Their contents, metadata included, stay refused. A profile cannot grant metadata without the listing.
- **The profile grows** by 4×len(name) entries for each of the two directories: 40 for `att_1`. That is still well within seatbelt's limits, and the probes ran with it.
- **The glob rules come from probing 0.148.0, not from documentation.** A Codex that changes glob semantics would change the fence. The version pin (drift check) holds Codex at 0.148.0, and the real canary and `codex sandbox` probes are how to re-check it on a bump.
