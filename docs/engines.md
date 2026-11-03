
## Codex 0.148.0 canary learnings (real app-server, 3 Nov 2026)

Recorded against the logged-in `codex-1` slot (`CODEX_HOME=~/.mec/engines/codex/codex-1`, "Logged in using ChatGPT"); protocol cross-checked with `codex app-server generate-ts` (ships with the binary — the cheapest source of truth, zero quota). Fixtures: `smoke`, `permission_request`, `auth_expired` are real recordings; `rate_limit_rejected` stays synthetic.

- **Handshake**: `initialize {clientInfo:{name,title,version}, capabilities:{experimentalApi,requestAttestation}}` → `{userAgent, codexHome, platformFamily, platformOs}`; then the client NOTIFICATION `initialized` (no id) before anything else. `thread/start {cwd, sandbox, approvalPolicy}` → `{thread:{id,…}, model, …}`.
- **The plan's 0.166 description is wrong for turns on 0.148.0**: `turn/start` takes `{threadId, input:[{type:'text', text, text_elements:[]}]}` — not `{prompt}`; `turn/steer` needs `{threadId, input, expectedTurnId}` and `turn/interrupt` needs `{threadId, turnId}`. The turn id exists only in the `turn/started` notification (`params.turn.id`), so a steer/interrupt before events are drained is impossible — the adapter refuses with a clear error.
- **Approvals are server→client REQUESTS, not notifications**: the request id rides at the TOP level (`params.id` does not exist; the observed id was the number `0`). `item/commandExecution/requestApproval` params: `{threadId, turnId, itemId, startedAtMs, environmentId, reason, command, cwd, commandActions, proposedExecpolicyAmendment, availableDecisions}` — `command` is ONE shell-line string (`"/bin/zsh -lc 'touch approved.txt'"`), not argv. The answer is the JSON-RPC response `{"jsonrpc":"2.0","id":<same id and type>,"result":{"decision":"accept"}}`; `item/tool/requestUserInput` is answered `{"answers":{}}` — it has no decision vocabulary.
- **A read-only sandbox + `approvalPolicy: on-request` escalates writes** (the observed `touch`), while plain reads (`ls`) run in-sandbox without asking. `fileChange` approvals carry no paths — only `reason` and an optional `grantRoot`.
- **`turn/completed`** carries the whole turn: `params.turn.status` ∈ completed|interrupted|failed (+ `turn.error` when failed) — not a flat `status`.
- **`thread/tokenUsage/updated`** nests cumulative tokens under `params.tokenUsage.total` (`inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`); ChatGPT subscriptions report NO cost — `cost_usd` stays undefined, never 0.
- **`account/rateLimits/updated`** carries `params.rateLimits.{primary,secondary}` (300/10080 `windowDurationMins`; `resetsAt` unix seconds) — one event per window. Live slot readings at canary time: five_hour 0–1%, seven_day 16%, `planType: "team"`, credits enabled.
- **Auth expiry (empty CODEX_HOME) never ends the turn**: 401s arrive as `error` notifications `{error:{message:"Reconnecting… N/5", codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:401}}, additionalDetails:"unexpected status 401 Unauthorized …"}, willRetry:true}` — the message alone says nothing about auth, classification must read `codexErrorInfo`/`additionalDetails` (401/unauthorized → auth). No `turn/completed` ever comes; the server retries forever, so the runtime must kill it and the exit is the CONTRACTS §1 crash-rule synthesis.
- **`mcpServer/startupStatus/updated` carries `error: null` in flight** — parsers must not mistake a null error field for an error notification.
- **The app-server never exits on its own** after a turn; consumers must stop draining at the `exit` event (or kill the process). Model on the slot: `gpt-5.6-sol`; `thread.cliVersion` is a reliable per-thread engine version.

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

## Codex slot (R2.1)

- `~/.mec/engines/codex/codex-1` — logged in 3 Nov 21:06 via the vendor's browser flow ("Logged in using ChatGPT", `codex login status` exit 0). `auth.json` at 0600 in the home; MEC never reads it (compliance guard). The R2.1 agent is reconciling the adapter + recording real fixtures against this slot.
