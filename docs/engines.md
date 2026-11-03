
## H1 canary learnings (Claude Code 2.1.317, 3 Nov 2026)

- `--session-id` requires a UUID (attempt ids like `att_1` are rejected with "Invalid session ID").
- `-p` with `--input-format stream-json` waits on a stdin user message; one-shot launches must not pass it.
- `--settings /dev/null` errors — always point at a real file.
- MCP: the client performs the full handshake; a server that cannot answer `initialize` is dropped ("Available MCP tools: none"). The `mcpServers.<name>` entry `{type:'http', url, headers:{Authorization}}` works on 2.1.317; the server URL includes the `/mcp` path.
- Sandboxed writes INSIDE `sandbox.filesystem.allowWrite` do not trigger `--permission-prompt-tool`; Bash commands do. The permission-prompt tool response shape is `{behavior:'allow', updatedInput}`.
- Slot utilisation at canary time: five_hour 4%, seven_day 10% (live readings in the stream).

## H3 sandbox learnings (GitHub, 3 Nov 2026)

- `gh repo view` takes the repository as a POSITIONAL argument; `-R` is only for pr/issue commands.
- `gh pr checks --json` reports states UPPERCASE (SUCCESS/PENDING/FAILURE).
- `gh pr create --body-file -` reads the body from stdin — a runner that does not close stdin hangs until timeout.
- Branch protection: the required context must equal the check-run name EXACTLY (this workflow reports `check`; requiring `ci / check` silently blocks every merge with "base branch policy prohibits the merge"). `gh pr view --json mergeStateStatus` is the ground truth (CLEAN vs BLOCKED).
