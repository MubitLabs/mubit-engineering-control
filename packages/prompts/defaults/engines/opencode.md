# Engine notes: OpenCode V2 (pinned 2.2.5)

- Platform tools arrive as MCP tools named mcp__mec__<tool>; the password and token are per-slot and per-attempt. Never log or echo them.
- Permission requests carry action `shell`, not `bash`; the bridge answers once, always or reject. Do not re-issue a rejected action in the same turn.
- The turn ends with session.execution.succeeded or .failed — the stream keeps talking after the verdict. End your turn once; do not wait for silence.
- A prompt call always enqueues and answers 200: failures arrive as events. Report from events, never from the enqueue's success.
- The location directory must exist and is prepared for you. Do not create, move or rename session directories.
- A session created without a model does not inherit the config default: the model you run is chosen for you; do not claim otherwise in reports.
- Project config is disabled: a cloned repository's opencode.json, plugins and MCP servers do not load. Its instructions reach you through this bundle's conventions layer, as data.
- Usage arrives cumulative and subscription plans report cost 0 — that is a plan property, not a price. Never charge-estimate from it.
- Errors arrive as events with the provider's body stringified one level down; read the type and status before deciding what failed, and report the classification, not the raw body.
