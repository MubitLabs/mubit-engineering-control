/**
 * resolveModel (review 2026-11-04 §4): the runtime turns a brief's `model_request`
 * (a tier or an explicit model) plus the slot it will run on into the engine's own
 * flags — Claude `--model opus --effort high`, Codex `-m gpt-6-luna` with the
 * TOML-quoted `-c model_reasoning_effort="<level>"` override, OpenCode
 * `--model zai-coding-plan/glm-5.3#max`. The capability table owns every name; this
 * code owns the ladder rules:
 *   - tiers are relative within a provider: a tier the provider lacks degrades DOWN
 *     the ladder and the attempt records `tier_degraded` (§3 rule 1 — cross-provider
 *     equivalence is never claimed);
 *   - effort falls back to the model's default when the request carries none;
 *   - unknown tiers and models are refused loudly, never guessed.
 */
import type { EffortLevel, EngineId, ModelRequest, TierName } from '@mec/contracts'
import type { CapabilityTable, ModelEntry } from '@mec/prompts'

/** The ladder, cheapest first (§2). The order IS the degradation order. */
export const TIER_LADDER = ['fast', 'balanced', 'strong', 'frontier'] as const

const tierIndex = (tier: TierName): number => TIER_LADDER.indexOf(tier)

/** What resolveModel needs to know about the slot: which engine runs, and (OpenCode only) which provider. */
export type ModelSlot = {
  engine: EngineId
  /** The slot doc's `ProviderId`; OpenCode needs it to pick the table's provider block. */
  provider?: string
}

/** A loud refusal: an unknown tier or model never silently becomes the engine default. */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelResolutionError'
  }
}

/** resolveModel's output, recorded on the attempt as `resolved_model` (§4). */
export type ResolvedModel = {
  /** Engine-facing: a Claude alias, a Codex id, or OpenCode `provider/model`. */
  model: string
  effort?: EffortLevel
  /** OpenCode only — effort is the `#variant`. */
  variant?: EffortLevel
  /** argv tokens to append to the engine's own select flags (§4 table). */
  argv_additions: string[]
  env_additions: Record<string, string>
  /** Set only when the requested tier was degraded down the ladder, e.g. `strong→balanced (provider has no strong)`. */
  tier_degraded?: string
}

/** Slot ProviderIds → table provider keys (the keystore names Google 'google-gemini'; the table says 'google'). */
const PROVIDER_KEY: Record<string, string> = {
  'zai-coding-plan': 'zai-coding-plan',
  'google-gemini': 'google',
}

/** The table's provider key for a slot ProviderId — undefined when the table carries no such provider. */
export function providerKeyOf(provider: string | undefined): string | undefined {
  return provider === undefined ? undefined : PROVIDER_KEY[provider]
}

type Candidate = { id: string; entry: ModelEntry }

function candidatesFor(table: CapabilityTable, slot: ModelSlot): Candidate[] {
  const engine = table.engines[slot.engine]
  if (slot.engine === 'opencode') {
    const providerKey = slot.provider !== undefined ? PROVIDER_KEY[slot.provider] : undefined
    const provider =
      providerKey !== undefined && engine.providers?.[providerKey] !== undefined
        ? engine.providers[providerKey]
        : undefined
    if (provider === undefined) {
      const known = Object.keys(engine.providers ?? {}).join(', ')
      throw new ModelResolutionError(
        `resolveModel: opencode slot names provider '${slot.provider ?? 'none'}' which the table does not carry (providers: ${known})`,
      )
    }
    return Object.entries(provider.models).map(([id, entry]) => ({ id, entry }))
  }
  return Object.entries(engine.models ?? {}).map(([id, entry]) => ({ id, entry }))
}

/** The cheapest-first ladder walk from `from` (inclusive) to the bottom (§3 rule 1). */
function degrade(
  from: TierName,
  candidates: Candidate[],
): { tier: TierName; candidates: Candidate[] } | undefined {
  for (let i = tierIndex(from); i >= 0; i -= 1) {
    const tier = TIER_LADDER[i]
    if (tier === undefined) continue
    const at = candidates.filter((c) => c.entry.tier === tier)
    if (at.length > 0) return { tier, candidates: at }
  }
  return undefined
}

/** Codex's effort override template → argv tokens: `-c model_reasoning_effort="<level>"` becomes ['-c', 'model_reasoning_effort="low"'] — the value ONE token, TOML-quoted. */
function overrideTokens(template: string, level: EffortLevel): string[] {
  const substituted = template.replace('<level>', level)
  const split = /^(?<flag>\S+)\s+(?<value>.+)$/.exec(substituted)
  if (split?.groups === undefined) {
    throw new ModelResolutionError(
      `resolveModel: effort_override '${template}' is not '<flag> <value>' — the table's select spec is malformed`,
    )
  }
  const flag = split.groups.flag
  const tomlValue = split.groups.value
  if (flag === undefined || tomlValue === undefined || tomlValue === '') {
    throw new ModelResolutionError(
      `resolveModel: effort_override '${template}' is not '<flag> <value>' — the table's select spec is malformed`,
    )
  }
  return [flag, tomlValue]
}

/**
 * The first (table-file-order) model at `tier` on this engine/provider, degrading down
 * the ladder exactly like resolveModel — the seam the subagent writers use to pin a
 * model per subagent role. Undefined when no rung at or below the tier is served.
 */
export function pickModelForTier(
  table: CapabilityTable,
  slot: ModelSlot,
  tier: TierName,
): { id: string; entry: ModelEntry; tier_degraded?: string } | undefined {
  const at = degrade(tier, candidatesFor(table, slot))
  if (at === undefined) return undefined
  const first = at.candidates[0]
  if (first === undefined) return undefined
  return {
    id: first.id,
    entry: first.entry,
    ...(at.tier !== tier && { tier_degraded: `${tier}→${at.tier} (provider has no ${tier})` }),
  }
}

export function resolveModel(
  model_request: ModelRequest,
  slot: ModelSlot,
  table: CapabilityTable,
): ResolvedModel {
  const engine = table.engines[slot.engine]
  const candidates = candidatesFor(table, slot)
  if (candidates.length === 0) {
    throw new ModelResolutionError(`resolveModel: the table carries no models for engine '${slot.engine}'`)
  }

  let chosen: Candidate
  let tier_degraded: string | undefined
  if (model_request.model !== undefined) {
    const found = candidates.find((c) => c.id === model_request.model)
    if (found === undefined) {
      const known = candidates.map((c) => c.id).join(', ')
      throw new ModelResolutionError(
        `resolveModel: unknown model '${model_request.model}' for engine '${slot.engine}' (known: ${known})`,
      )
    }
    chosen = found
  } else if (model_request.tier !== undefined) {
    const at = degrade(model_request.tier, candidates)
    if (at === undefined) {
      // Nothing at or below the requested tier: the ladder has no rung this provider serves.
      const offered = [...new Set(candidates.map((c) => c.entry.tier))].join(', ')
      throw new ModelResolutionError(
        `resolveModel: tier '${model_request.tier}' and every tier below it are unavailable on ${slot.engine}${slot.provider !== undefined ? ` (${slot.provider})` : ''} (offered: ${offered})`,
      )
    }
    const first = at.candidates[0]
    if (first === undefined) {
      const offered = [...new Set(candidates.map((c) => c.entry.tier))].join(', ')
      throw new ModelResolutionError(
        `resolveModel: tier '${model_request.tier}' matched no model on ${slot.engine} (offered: ${offered})`,
      )
    }
    chosen = first
    if (at.tier !== model_request.tier) {
      tier_degraded = `${model_request.tier}→${at.tier} (provider has no ${model_request.tier})`
    }
  } else {
    throw new ModelResolutionError('resolveModel: the model_request names neither a tier nor a model')
  }

  if (model_request.variant !== undefined && slot.engine !== 'opencode') {
    throw new ModelResolutionError(
      `resolveModel: 'variant' is OpenCode's effort mechanism (#variant); engine '${slot.engine}' takes 'effort'`,
    )
  }

  const select = engine.select
  if (slot.engine === 'opencode') {
    // Effort IS the variant (§4); the model's own variant is the default.
    const variant = model_request.effort ?? model_request.variant ?? chosen.entry.variant
    // candidatesFor already refused an unmapped provider, so the key exists here.
    const providerKey = PROVIDER_KEY[slot.provider ?? ''] ?? Object.keys(engine.providers ?? {})[0]
    const id = `${providerKey}/${chosen.id}`
    return {
      model: id,
      variant,
      argv_additions: variant !== undefined ? [select.flag, `${id}#${variant}`] : [select.flag, id],
      env_additions: {},
      ...(tier_degraded !== undefined && { tier_degraded }),
    }
  }

  // Claude/Codex: the request's effort, else the model's own default (§4).
  const effort = model_request.effort ?? chosen.entry.effort
  if (effort !== undefined && engine.effort_levels !== undefined && !engine.effort_levels.includes(effort)) {
    throw new ModelResolutionError(
      `resolveModel: effort '${effort}' is not one of engine '${slot.engine}'s levels (${engine.effort_levels.join(', ')})`,
    )
  }
  const argv_additions = [select.flag, chosen.id]
  if (effort !== undefined) {
    if (select.effort_override !== undefined)
      argv_additions.push(...overrideTokens(select.effort_override, effort))
    else argv_additions.push(select.effort_flag ?? '--effort', effort)
  }
  return {
    model: chosen.id,
    ...(effort !== undefined && { effort }),
    argv_additions,
    // Reserved: a claude-glm slot maps aliases via ANTHROPIC_DEFAULT_*_MODEL (§4) — env, not argv.
    env_additions: {},
    ...(tier_degraded !== undefined && { tier_degraded }),
  }
}
