/**
 * The capability table (review 2026-11-04 §3): the user-editable `~/.mec/models.yaml`
 * that maps the tier ladder (`fast`/`balanced`/`strong`/`frontier`) to concrete
 * `(engine, provider, model, effort)` choices, with the facts that matter for choosing
 * (relative speed and cost, context size, the vendor's own words) and the subagent
 * mechanism each engine offers. Nothing in the table is a secret or a credential; the
 * meta agent never writes it — `GET/PUT /api/models` is the one write path, with the
 * same provenance flow as prompt parts (§16.3).
 *
 * The parser is a deliberately strict YAML subset (comments, block maps by indentation,
 * flow sequences/maps, quoted and bare scalars, multi-line flow collections) — no `yaml`
 * dependency; anything outside the subset fails loudly with a line number, and the
 * parsed shape must satisfy the Zod `CapabilityTable` before anyone plans against it.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EffortLevel, TierName } from '@mec/contracts'
import { z } from 'zod'

/** A model row: which tier it serves, what it costs relative to its provider, and the vendor's words verbatim. */
export const ModelEntry = z
  .strictObject({
    tier: TierName,
    /** Claude/Codex: the effort default this model ships with. */
    effort: EffortLevel.optional(),
    /** OpenCode: effort IS the `#variant`. Every model names exactly one of effort/variant. */
    variant: EffortLevel.optional(),
    /** Relative speed and cost indexes within the provider (§3 rule 3: cost is visible, not a promise). */
    speed: z.number().int().min(1).max(5),
    cost: z.number().min(0),
    context: z.string().min(1).optional(),
    output: z.string().min(1).optional(),
    /** API pricing [input, output] USD per million tokens, when the provider publishes one. */
    api_usd_per_mtok: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
    bills: z.string().min(1).optional(),
    requires_cli: z.string().min(1).optional(),
    free_tier: z.boolean().optional(),
    /** The vendor's positioning, quoted verbatim and shown verbatim — MEC never claims cross-provider equivalence. */
    vendor_says: z.string().min(1),
  })
  .superRefine((entry, ctx) => {
    const named = [entry.effort, entry.variant].filter((value) => value !== undefined).length
    if (named !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'a model names exactly one of effort (claude/codex) or variant (opencode)',
      })
    }
  })

/** How the engine selects a model on its command line / API (§3 `engines.<engine>.select`). */
export const SelectSpec = z.strictObject({
  flag: z.string().min(1),
  effort_flag: z.string().min(1).optional(),
  /** Codex: the effort override template; `<level>` is substituted, values are TOML-quoted strings. */
  effort_override: z.string().min(1).optional(),
  /** OpenCode: the model syntax (`provider/model#variant`). */
  syntax: z.string().min(1).optional(),
})

/** The subagent mechanism facts (§3 `engines.<engine>.subagents`) the runtime's writers consume. */
export const SubagentsSpec = z.strictObject({
  mechanism: z.enum(['agents_file', 'config', 'agents_config']),
  depth_var: z.string().min(1).optional(),
  force_vars: z.array(z.string().min(1)).optional(),
  keys: z.array(z.string().min(1)).optional(),
  catalogue: z.string().min(1).optional(),
  ultra: z.string().min(1).optional(),
})

const ModelsMap = z.record(z.string().min(1), ModelEntry)

/** One engine's table: claude/codex carry `models`, opencode carries `providers` — exactly one of the two. */
export const EngineTable = z
  .strictObject({
    select: SelectSpec,
    effort_levels: z.array(EffortLevel).min(1).optional(),
    models: ModelsMap.optional(),
    providers: z.record(z.string().min(1), z.strictObject({ models: ModelsMap })).optional(),
    subagents: SubagentsSpec,
  })
  .superRefine((engine, ctx) => {
    const hasModels = engine.models !== undefined && Object.keys(engine.models).length > 0
    const hasProviders = engine.providers !== undefined && Object.keys(engine.providers).length > 0
    if (hasModels === hasProviders) {
      ctx.addIssue({
        code: 'custom',
        message: "an engine carries exactly one of 'models' (claude/codex) or 'providers' (opencode)",
      })
    }
  })

/** Which tier each built-in role asks for by default (§3 `routing.roles`). */
export const RoleRouting = z.strictObject({
  tier: TierName,
  effort: EffortLevel.optional(),
  prefer: z.string().min(1).optional(),
})

/** The specialists' own subagent ceiling (§3 `routing.subagents`). */
export const SubagentRouting = z.strictObject({
  max_tier: TierName,
  depth: z.int().min(0),
})

/** The whole table (§3). `version` pins the shape; the loader refuses anything the schema does not know. */
export const CapabilityTable = z
  .strictObject({
    version: z.literal(1),
    tiers: z.array(TierName).min(1),
    engines: z.strictObject({
      claude: EngineTable,
      codex: EngineTable,
      opencode: EngineTable,
    }),
    routing: z.strictObject({
      roles: z.record(z.string().min(1), RoleRouting),
      subagents: z.record(z.string().min(1), SubagentRouting),
      frontier: z.strictObject({ requires: z.literal('preauthorised') }),
    }),
  })
  .superRefine((table, ctx) => {
    if (new Set(table.tiers).size !== table.tiers.length) {
      ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'tiers must be unique' })
    }
    const tiers = new Set(table.tiers)
    for (const [engine, entry] of Object.entries(table.engines)) {
      const maps =
        entry.models !== undefined
          ? [[`${engine}.models`, entry.models] as const]
          : Object.entries(entry.providers ?? {}).map(
              (p) => [`${engine}.providers.${p[0]}.models`, p[1].models] as const,
            )
      for (const [where, models] of maps) {
        for (const [id, model] of Object.entries(models)) {
          if (!tiers.has(model.tier)) {
            ctx.addIssue({
              code: 'custom',
              path: [where, id, 'tier'],
              message: `tier '${model.tier}' of '${id}' is not in the tiers ladder`,
            })
          }
        }
      }
    }
  })

export type ModelEntry = z.infer<typeof ModelEntry>
export type SelectSpec = z.infer<typeof SelectSpec>
export type SubagentsSpec = z.infer<typeof SubagentsSpec>
export type EngineTable = z.infer<typeof EngineTable>
export type RoleRouting = z.infer<typeof RoleRouting>
export type SubagentRouting = z.infer<typeof SubagentRouting>
export type CapabilityTable = z.infer<typeof CapabilityTable>

/** Everything loadModelsTable reports about where the table came from (§16.3 provenance). */
export type ModelsProvenance = {
  source: 'user' | 'default'
  path: string
  /** sha256 of the exact file bytes the table was parsed from — recorded with every plan. */
  sha256: string
}

/** A loud failure: never a silent fallback to defaults when the user's table is broken. */
export class ModelsTableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelsTableError'
  }
}

// ─── the strict YAML subset parser ─────────────────────────────────────────────

type Line = { indent: number; text: string; number: number }

/** Drops a comment: `#` at line start or after whitespace, outside quotes. */
function stripComment(line: string): string {
  let quote: '"' | "'" | undefined
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote === '"') {
      if (char === '\\') i += 1
      else if (char === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i)
  }
  return line
}

/** Bracket depth of `text` outside quotes — a positive depth means a flow collection is still open. */
function openDepth(text: string): number {
  let depth = 0
  let quote: '"' | "'" | undefined
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote === '"') {
      if (char === '\\') i += 1
      else if (char === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
  }
  return depth
}

/** Splits, comment-strips and joins continuation lines of multi-line flow collections. */
function physicalLines(text: string): Line[] {
  const lines: Line[] = []
  const raw = text.split(/\r?\n/)
  for (let i = 0; i < raw.length; i += 1) {
    const source = raw[i] ?? ''
    if (source.startsWith('\t')) {
      throw new ModelsTableError(`line ${i + 1}: tabs never indent the models table — use spaces`)
    }
    const indent = source.length - source.trimStart().length
    const stripped = stripComment(source.trimEnd()).trimEnd()
    if (stripped.trim() === '') continue
    const carried = lines.at(-1)
    if (carried !== undefined && openDepth(carried.text) > 0) {
      carried.text = `${carried.text} ${stripped.trim()}`
    } else {
      lines.push({ indent, text: stripped.trim() === '' ? '' : stripped.slice(indent), number: i + 1 })
    }
  }
  return lines
}

/** `key: value` (or `key:` opening a child block) — the one statement the subset knows. */
const KEY_VALUE = /^(?<key>[^:#]+?):(?<rest>.*)$/

/** Parses one scalar token: quoted string, number, boolean or bare string. */
function scalar(token: string, at: () => string): unknown {
  const text = token.trim()
  if (text === '') throw new ModelsTableError(`${at()}: empty value`)
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2)
      throw new ModelsTableError(`${at()}: unterminated string ${text}`)
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2)
      throw new ModelsTableError(`${at()}: unterminated string ${text}`)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number.parseFloat(text)
  return text
}

/** Splits a flow collection body on top-level commas (quote- and bracket-aware). */
function splitFlow(body: string, at: () => string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: '"' | "'" | undefined
  let current = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (quote === '"') {
      current += char
      if (char === '\\') {
        current += body[i + 1] ?? ''
        i += 1
      } else if (char === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      current += char
      if (char === "'") quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (quote !== undefined) throw new ModelsTableError(`${at()}: unterminated string in a flow collection`)
  if (current.trim() !== '' || parts.length > 0) parts.push(current)
  return parts.filter((part) => part.trim() !== '')
}

/** Parses a flow value: `[a, b]` or `{ k: v, ... }` (possibly nested). */
function parseFlowValue(text: string, at: () => string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) throw new ModelsTableError(`${at()}: unterminated flow sequence`)
    return splitFlow(trimmed.slice(1, -1), at).map((part) => value(part.trim(), at))
  }
  if (trimmed.startsWith('{')) {
    if (!trimmed.endsWith('}')) throw new ModelsTableError(`${at()}: unterminated flow mapping`)
    const map: Record<string, unknown> = {}
    for (const part of splitFlow(trimmed.slice(1, -1), at)) {
      const colon = part.indexOf(':')
      if (colon === -1) throw new ModelsTableError(`${at()}: flow mapping entry '${part.trim()}' has no key`)
      const key = scalar(part.slice(0, colon), at)
      if (typeof key !== 'string') throw new ModelsTableError(`${at()}: flow mapping key is not a string`)
      if (key in map) throw new ModelsTableError(`${at()}: duplicate key '${key}'`)
      map[key] = value(part.slice(colon + 1).trim(), at)
    }
    return map
  }
  return scalar(trimmed, at)
}

/** One value, flow or scalar — the bracket check keeps `[...]`/`{...}` whole. */
function value(text: string, at: () => string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseFlowValue(trimmed, at)
  return scalar(trimmed, at)
}

/** Parses a block mapping at exactly `indent`, returning the value and the next unread line. */
function parseBlockMap(lines: Line[], start: number, indent: number): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) break
    if (line.indent < indent) break
    if (line.indent !== indent) {
      throw new ModelsTableError(
        `line ${line.number}: indentation ${line.indent} where ${indent} was expected — the models table is a strict block mapping`,
      )
    }
    const match = KEY_VALUE.exec(line.text)
    if (match?.groups === undefined) {
      throw new ModelsTableError(`line ${line.number}: expected 'key: value', got '${line.text}'`)
    }
    const key = (match.groups.key ?? '').trim()
    if (key === '') throw new ModelsTableError(`line ${line.number}: empty key`)
    if (key in map) throw new ModelsTableError(`line ${line.number}: duplicate key '${key}'`)
    const rest = (match.groups.rest ?? '').trim()
    if (rest === '') {
      // a child block must be indented deeper on the next line
      const next = lines[i + 1]
      if (next === undefined || next.indent <= indent) {
        throw new ModelsTableError(`line ${line.number}: '${key}:' opens no block — a value is required`)
      }
      const [child, after] = parseBlockMap(lines, i + 1, next.indent)
      map[key] = child
      i = after
      continue
    }
    map[key] = value(rest, () => `line ${line.number}`)
    i += 1
  }
  return [map, i]
}

/**
 * Parses the strict YAML subset the capability table is written in. Throws
 * `ModelsTableError` (with a line number) on anything outside it — never guesses.
 */
export function parseModelsYaml(text: string): unknown {
  const lines = physicalLines(text)
  const first = lines[0]
  if (lines.length === 0 || first === undefined) throw new ModelsTableError('the models table is empty')
  if (first.indent !== 0) throw new ModelsTableError(`line ${first.number}: the table starts at column 0`)
  const [map, next] = parseBlockMap(lines, 0, 0)
  const leftover = lines[next]
  if (next !== lines.length) {
    throw new ModelsTableError(
      `line ${leftover?.number ?? first.number}: unexpected content after the top-level mapping`,
    )
  }
  return map
}

/** Validates a parsed table, rethrowing Zod's issues as one loud `ModelsTableError`. */
export function validateModelsTable(parsed: unknown): CapabilityTable {
  const result = CapabilityTable.safeParse(parsed)
  if (result.success) return result.data
  const details = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ')
  throw new ModelsTableError(`the models table does not match the capability-table schema — ${details}`)
}

/** The shipped default (§3), verbatim — the file this module's sibling `defaults/models.yaml` holds. */
export const DEFAULT_MODELS_YAML_PATH = fileURLToPath(new URL('../defaults/models.yaml', import.meta.url))

/** Where the user's table lives; `~/.mec/models.yaml` by default (§5.4 keystore root). */
export const userModelsPath = (root = join(homedir(), '.mec')) => join(root, 'models.yaml')

/**
 * Loads the capability table with provenance: the user's `~/.mec/models.yaml` when it
 * exists, the shipped default otherwise (§3). An invalid file throws — a broken table
 * must stop the planner, never quietly fall back to the default.
 */
export function loadModelsTable(opts: { userPath?: string } = {}): {
  table: CapabilityTable
  provenance: ModelsProvenance
} {
  const userPath = opts.userPath ?? userModelsPath()
  const source: ModelsProvenance['source'] = existsSync(userPath) ? 'user' : 'default'
  const path = source === 'user' ? userPath : DEFAULT_MODELS_YAML_PATH
  const text = readFileSync(path, 'utf8')
  return {
    table: validateModelsTable(parseModelsYaml(text)),
    provenance: { source, path, sha256: createHash('sha256').update(text, 'utf8').digest('hex') },
  }
}
