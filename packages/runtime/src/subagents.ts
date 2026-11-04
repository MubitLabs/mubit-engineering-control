/**
 * The specialists' own subagents (review 2026-11-04 §4, right-hand column): the
 * runtime, not the adapters' callers, writes each engine's subagent configuration
 * from one `SubagentPolicy` — what tier the specialist's own subagents may run at,
 * and how deep they may nest.
 *
 *   Claude Code — a per-attempt `--agents <file>` (one entry per allowed role with
 *   `model`/`effort` from the policy), `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` from
 *   the policy, `CLAUDE_CODE_SUBAGENT_MODEL` + `_FORCE=1` when the policy pins one
 *   tier, and `Agent(<role>)` in `--disallowedTools` for every role the policy
 *   forbids (depth 0 forbids them all).
 *
 *   Codex — subagents are on by default, so the slot's `config.toml` gains the
 *   `[agents]` overrides per launch (`enabled`, `default_subagent_model`,
 *   `default_subagent_reasoning_effort`; `enabled = false` at depth 0) with every
 *   other section preserved verbatim, plus one `$CODEX_HOME/agents/<role>.toml` per
 *   allowed role.
 *
 *   OpenCode — `agents.<name>` entries with `mode: subagent` and a pinned
 *   `model: "provider/model#variant"` in the slot's `opencode.json` (a subagent
 *   without a model inherits the parent, so every allowed role is pinned); stale
 *   catalogue entries are removed at depth 0.
 *
 * Everything lands inside the paths the caller hands in — the attempt directory for
 * Claude's per-attempt file, the SLOT HOME for Codex and OpenCode (tests prove
 * nothing escapes those roots). The role catalogue mirrors §5.4/§6.1's
 * `roles/subagents/{lookup,test_runner,reviewer}.md`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TierName } from '@mec/contracts'
import type { CapabilityTable } from '@mec/prompts'
import { ModelResolutionError, pickModelForTier, providerKeyOf } from './model'

/** What the planner hands a specialist: the ceiling its own subagents may use, and how deep they may nest. */
export type SubagentPolicy = {
  max_tier: TierName
  /** 0 disables subagents entirely (every engine's writer enforces it). */
  depth: number
  /** "Only this tier": Claude pins CLAUDE_CODE_SUBAGENT_MODEL(_FORCE) to the max_tier model. */
  pinned?: boolean
}

/** The built-in subagent catalogue (§5.4, §6.1) — the only roles these writers manage. */
export type SubagentRole = {
  role: string
  tier: TierName
  description: string
  instructions: string
  tools: string[]
}

export const SUBAGENT_CATALOGUE: readonly SubagentRole[] = [
  {
    role: 'lookup',
    tier: 'fast',
    description: 'Fast read-only lookups: symbols, definitions, where a thing is used.',
    instructions: 'Find and report. Read-only: no edits, no commands beyond searches. Cite file paths.',
    tools: ['Grep', 'Glob', 'Read'],
  },
  {
    role: 'test_runner',
    tier: 'fast',
    description: 'Runs the acceptance checks and reports pass/fail per check.',
    instructions:
      'Run exactly the named checks; report each check pass or fail with the failing output tail.',
    tools: ['Bash', 'Read'],
  },
  {
    role: 'reviewer',
    tier: 'balanced',
    description: 'Reviews a diff against the acceptance checks and the owned paths.',
    instructions: 'Review only what the diff touches; findings first, severity named, no rewrites.',
    tools: ['Read', 'Grep', 'Glob'],
  },
]

const tierIndex = (tier: TierName): number => ['fast', 'balanced', 'strong', 'frontier'].indexOf(tier)

/** Depth 0 allows nothing; above it, the catalogue roles at or under the policy's tier ceiling. */
const allowedRoles = (policy: SubagentPolicy): SubagentRole[] =>
  policy.depth === 0
    ? []
    : SUBAGENT_CATALOGUE.filter((role) => tierIndex(role.tier) <= tierIndex(policy.max_tier))

// ─── Claude Code ───────────────────────────────────────────────────────────────

export type ClaudeSubagentSetup = {
  agentsPath: string
  argv_additions: string[]
  env_additions: Record<string, string>
}

/**
 * Writes the per-attempt `--agents` JSON file into `dir` and returns the argv/env
 * additions the Claude launch consumes (§4). Depth 0 denies every `Agent(<role>)`.
 */
export function claudeSubagentSetup(
  dir: string,
  policy: SubagentPolicy,
  table: CapabilityTable,
): ClaudeSubagentSetup {
  const claude = table.engines.claude
  const spec = claude.subagents
  const allowed = allowedRoles(policy)
  const entries = allowed.map((role) => {
    const picked = pickModelForTier(table, { engine: 'claude' }, role.tier)
    if (picked === undefined) {
      throw new ModelResolutionError(
        `claude subagents: the table offers no model at or below tier '${role.tier}' for role '${role.role}'`,
      )
    }
    return {
      name: role.role,
      description: role.description,
      tools: role.tools,
      model: picked.id,
      ...(picked.entry.effort !== undefined && { effort: picked.entry.effort }),
    }
  })

  mkdirSync(dir, { recursive: true })
  const agentsPath = join(dir, 'mec-subagents.json')
  writeFileSync(agentsPath, `${JSON.stringify(entries, null, 2)}\n`)

  const env_additions: Record<string, string> = {
    [spec.depth_var ?? 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH']: String(policy.depth),
  }
  if (policy.pinned === true) {
    const pinned = pickModelForTier(table, { engine: 'claude' }, policy.max_tier)
    if (pinned === undefined) {
      throw new ModelResolutionError(
        `claude subagents: pinned policy names tier '${policy.max_tier}' which the table cannot serve`,
      )
    }
    const fallbackVars = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'] as const
    const vars = spec.force_vars ?? [...fallbackVars]
    const modelVar = vars[0] ?? fallbackVars[0]
    const forceVar = vars[1] ?? fallbackVars[1]
    env_additions[modelVar] = pinned.id
    env_additions[forceVar] = '1'
  }

  // Roles over the ceiling — and, at depth 0, every role — are denied by name.
  const denied = SUBAGENT_CATALOGUE.filter((role) => !allowed.includes(role)).map((role) => role.role)
  const argv_additions = ['--agents', agentsPath]
  for (const role of denied) argv_additions.push('--disallowedTools', `Agent(${role})`)

  return { agentsPath, argv_additions, env_additions }
}

// ─── Codex ─────────────────────────────────────────────────────────────────────

/** TOML basic-string escaping: the value stays one quoted, single-line string. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Replaces (or appends) the `[agents]` table in a config.toml, preserving every
 * other section's lines verbatim and in order. `[agents.<sub>]` tables are left
 * alone — only the exact `[agents]` header is MEC's to write.
 */
function mergeAgentsSection(existing: string, agentsLines: string[]): string {
  const lines = existing.split(/\r?\n/)
  const out: string[] = []
  let inAgents = false
  let wrote = false
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (inAgents) {
        inAgents = false
        if (!wrote) {
          out.push(...agentsLines)
          wrote = true
        }
      }
      if (/^\s*\[agents\]\s*$/.test(line)) {
        inAgents = true
        out.push('[agents]')
        continue
      }
    } else if (inAgents) {
      continue // drop the old [agents] body
    }
    out.push(line)
  }
  if (inAgents && !wrote) {
    out.push(...agentsLines)
    wrote = true
  }
  if (!wrote) {
    if (out.length > 0 && out.at(-1)?.trim() !== '') out.push('')
    out.push('[agents]', ...agentsLines)
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}$/g, '\n\n')
    .trimEnd()}\n`
}

export type CodexSubagentSetup = { configPath: string; agentFiles: string[] }

/**
 * Writes the slot-home Codex subagent configuration: the `config.toml` `[agents]`
 * overrides (`enabled = false` at depth 0) with other sections preserved, and one
 * `agents/<role>.toml` per allowed role. Stale catalogue role files are removed.
 */
export function codexSubagentSetup(
  codexHome: string,
  policy: SubagentPolicy,
  table: CapabilityTable,
): CodexSubagentSetup {
  const enabled = policy.depth > 0
  const allowed = allowedRoles(policy)
  const agentsDir = join(codexHome, 'agents')
  mkdirSync(agentsDir, { recursive: true })

  const agentFiles: string[] = []
  if (enabled) {
    for (const role of allowed) {
      const picked = pickModelForTier(table, { engine: 'codex' }, role.tier)
      if (picked === undefined) {
        throw new ModelResolutionError(
          `codex subagents: the table offers no model at or below tier '${role.tier}' for role '${role.role}'`,
        )
      }
      const file = join(agentsDir, `${role.role}.toml`)
      const effort = picked.entry.effort
      writeFileSync(
        file,
        [
          `name = ${tomlString(role.role)}`,
          `description = ${tomlString(role.description)}`,
          `developer_instructions = ${tomlString(role.instructions)}`,
          `model = ${tomlString(picked.id)}`,
          ...(effort !== undefined ? [`model_reasoning_effort = ${tomlString(effort)}`] : []),
          '',
        ].join('\n'),
      )
      agentFiles.push(file)
    }
  }
  // Stale catalogue files (a role the policy no longer allows, or depth 0) never linger.
  for (const name of readdirSync(agentsDir)) {
    if (!name.endsWith('.toml')) continue
    const stem = name.slice(0, -'.toml'.length)
    if (
      SUBAGENT_CATALOGUE.some((role) => role.role === stem) &&
      !agentFiles.includes(join(agentsDir, name))
    ) {
      rmSync(join(agentsDir, name))
    }
  }

  const defaultModel = enabled ? pickModelForTier(table, { engine: 'codex' }, policy.max_tier) : undefined
  const agentsLines = [
    `enabled = ${enabled ? 'true' : 'false'}`,
    ...(defaultModel !== undefined
      ? [
          `default_subagent_model = ${tomlString(defaultModel.id)}`,
          ...(defaultModel.entry.effort !== undefined
            ? [`default_subagent_reasoning_effort = ${tomlString(defaultModel.entry.effort)}`]
            : []),
        ]
      : []),
  ]
  const configPath = join(codexHome, 'config.toml')
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  writeFileSync(configPath, mergeAgentsSection(existing, agentsLines))
  return { configPath, agentFiles }
}

// ─── OpenCode ──────────────────────────────────────────────────────────────────

export type OpenCodeSubagentSetup = { configPath: string }

/**
 * Merges `agents.<name>` entries (`mode: subagent`, a pinned
 * `provider/model#variant` — a subagent without a model inherits the parent) into
 * the slot's `opencode.json`, preserving every other key. Stale catalogue entries
 * are removed: at depth 0 all of them, above it the roles over the ceiling.
 */
export function opencodeSubagentSetup(
  configPath: string,
  policy: SubagentPolicy,
  table: CapabilityTable,
  provider: string,
): OpenCodeSubagentSetup {
  const providerKey = providerKeyOf(provider)
  const opencode = table.engines.opencode
  const providerBlock = providerKey !== undefined ? opencode.providers?.[providerKey] : undefined
  if (providerBlock === undefined) {
    throw new ModelResolutionError(
      `opencode subagents: slot provider '${provider}' has no block in the table (providers: ${Object.keys(opencode.providers ?? {}).join(', ')})`,
    )
  }
  const allowed = allowedRoles(policy)
  const config: Record<string, unknown> = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
    : {}
  const agents: Record<string, unknown> =
    typeof config.agents === 'object' && config.agents !== null ? { ...config.agents } : {}
  for (const name of Object.keys(agents)) {
    const managed = SUBAGENT_CATALOGUE.some((role) => role.role === name)
    if (managed && !allowed.some((role) => role.role === name)) delete agents[name]
  }
  for (const role of allowed) {
    const picked = pickModelForTier(table, { engine: 'opencode', provider }, role.tier)
    if (picked === undefined) {
      throw new ModelResolutionError(
        `opencode subagents: provider '${providerKey}' offers no model at or below tier '${role.tier}' for role '${role.role}'`,
      )
    }
    const model = `${providerKey}/${picked.id}${picked.entry.variant !== undefined ? `#${picked.entry.variant}` : ''}`
    agents[role.role] = { mode: 'subagent', model, description: role.description }
  }
  if (Object.keys(agents).length > 0) config.agents = agents
  else delete config.agents
  mkdirSync(join(configPath, '..'), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return { configPath }
}
