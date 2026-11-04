# Shared instructions across coding tools

Use AGENTS.md for repository guidance shared by the team. Keep root-wide
guidance at the root and area-specific guidance near the relevant code.
Local guidance should add detail without contradicting the shared rules.

| Tool | Adaptation |
| --- | --- |
| Codex | Use its documented AGENTS.md discovery and scoping. Keep workflow plans as explicit links. |
| Claude Code | Recent versions can read AGENTS.md directly. Check the installed version and project instruction setting. Existing CLAUDE.md or CLAUDE.local.md files on the project path can change what loads. |
| OpenCode | Use AGENTS.md. The V2 instruction guide says CLAUDE.md is not a fallback. Check the version in use before relying on older conventions. |

When a Claude session needs CLAUDE.md, place this import in a CLAUDE.md next
to the corresponding AGENTS.md:

```text
@AGENTS.md
```

If CLAUDE.md already exists, preserve its applicable instructions and merge
the import without duplicating shared content. Verify nested guidance too:
one root import is not proof that every nested AGENTS.md loads. Depending on
the supported version/configuration, use native AGENTS.md loading or matching
local CLAUDE.md imports. Put Claude-only details after the import when needed.

Plain Markdown links are references; do not assume every tool automatically
expands them. State when an agent should read a referenced guide. Keep the
essential requirements directly in the applicable AGENTS.md.

## Loading check

1. Start a fresh session in the actual repository.
2. Inspect the tool's instruction/context view when available.
3. Ask it to identify the loaded root guidance and exact verification command.
4. Open a representative nested area and verify its local guidance is loaded.
5. Repeat for each tool/version the team uses.

Treat self-reports as a diagnostic, not an enforcement mechanism. Tests,
permissions, and CI enforce the boundaries that need enforcement. No agent
account, credential, or personal memory is included in this kit.

## This repository

- `AGENTS.md` (root) is the shared guide; `CLAUDE.md` (root) keeps the compaction-survival rules for Claude sessions and imports the shared guide.
- No nested `AGENTS.md` files exist — package-level invariants live in `docs/agent-workflow/legacy-constraints.md` and the canonical docs the root file links. Add a nested file only when an area genuinely needs different guidance (none does today).
- Product note, because it confuses visitors: MEC's own *engines* treat repository-resident configuration as untrusted (§22) — loading repo instructions is for coding agents working ON this repo, never a behaviour of the agents MEC launches.
