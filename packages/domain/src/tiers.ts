// `ModelTier` is contracts-v0.1's type, mirrored here rather than imported: contracts is
// frozen at v0 and another lane owns it, and domain depends on contracts only — a local
// ladder keeps tier validation standalone. The integrator swaps the mirror for the
// contracts import when v0.1 lands.
export const MODEL_TIERS = ['fast', 'balanced', 'strong', 'frontier'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/**
 * Tier validation, model-tiers design §3 rule 1/§5.2 (T5): the deterministic checks a
 * proposed plan must pass BEFORE anything executes — tier availability on at least one
 * healthy slot, frontier only with pre-authorisation, a specialist's subagent policy
 * within its role ceiling.
 *
 * Pure and structural on purpose: `domain` depends only on `@mec/contracts`, so the
 * capability table arrives as `TierTableLike` (the `@mec/prompts` CapabilityTable
 * satisfies it structurally) and the probe marks as `SlotModelsView` — the same mark
 * vocabulary `packages/slots`' probe produces (`available | unavailable | unlisted`),
 * restated here because domain cannot import that package.
 *
 * §3 rule 2, probe before trust: only an `available` mark makes a tier placeable. An
 * `unavailable` mark is the engine saying no; an `unlisted` mark is the honest v0 state
 * for Claude/Codex slots (the acceptance probe is the gated T8 canary's) — unknown, not
 * offered — so it does NOT place a tier either, and the repair issue says exactly that,
 * naming the placeable alternatives and the escape (drop `model_request` and let the
 * role's routing default apply). A task with NO model_request is always allowed: the
 * registry's default routing (§3) resolves it, which keeps a v0 install with only
 * unlisted marks planning normally.
 */

/** Is `tier` a name on the ladder? Callers validate raw strings before casting. */
export function isModelTier(value: unknown): value is ModelTier {
  return isModelTierValue(value)
}

function isModelTierValue(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)
}

/** The four rungs, cheapest first; the order is the ranking (design §2). */
export const TIER_LADDER: readonly ModelTier[] = ['fast', 'balanced', 'strong', 'frontier']

/** 0 for fast … 3 for frontier; higher runs harder and dearer. */
export function tierRank(tier: ModelTier): number {
  const rank = TIER_LADDER.indexOf(tier)
  if (rank === -1) throw new Error(`tierRank: '${tier}' is not on the tier ladder`)
  return rank
}

/** Is `tier` at or below `ceiling` on the ladder? */
export function tierWithin(tier: ModelTier, ceiling: ModelTier): boolean {
  return tierRank(tier) <= tierRank(ceiling)
}

/** The slots-package probe vocabulary, restated (domain imports contracts only). */
export type ModelAvailability = 'available' | 'unavailable' | 'unlisted'

/** The table shape tier validation reads; a full capability table satisfies it structurally. */
export type TierTableLike = {
  tiers: readonly ModelTier[]
  engines: Record<
    string,
    {
      models?: Record<string, { tier: ModelTier }>
      providers?: Record<string, { models: Record<string, { tier: ModelTier }> }>
    }
  >
  routing: { subagents: Record<string, { max_tier: ModelTier; depth: number }> }
}

/** One slot as tier validation sees it: identity, health, and the probe marks by key. */
export type SlotModelsView = {
  slotId: string
  engine: string
  healthy: boolean
  /** mark key (`provider/id` on opencode, bare id elsewhere) → availability; a missing key is `unlisted`. */
  marks: Record<string, ModelAvailability>
  /** The slot's provider, which picks the table's block on OpenCode. */
  provider?: string
  slotClass?: string
  /** Last reported window utilisation (0-1); absent means no reading yet. */
  utilisation?: number
  /** Units the slot takes at once; absent means the policy's per-slot cap. */
  concurrency?: number
}

/**
 * The mark key for a table entry — the same key rule `packages/slots`' probe writes
 * (`modelAvailabilityKey`): `provider/id` when a provider names the model (opencode),
 * the bare id otherwise.
 */
export function markKeyFor(engine: string, provider: string | undefined, id: string): string {
  return provider !== undefined && provider !== '' && engine === 'opencode' ? `${provider}/${id}` : id
}

/** Every table entry flattened: engine, catalog provider (opencode only), id, tier. */
export function tableEntries(
  table: TierTableLike,
): { engine: string; provider?: string; id: string; tier: ModelTier }[] {
  const out: { engine: string; provider?: string; id: string; tier: ModelTier }[] = []
  for (const [engine, def] of Object.entries(table.engines)) {
    for (const [id, entry] of Object.entries(def.models ?? {})) out.push({ engine, id, tier: entry.tier })
    for (const [provider, byProvider] of Object.entries(def.providers ?? {})) {
      for (const [id, entry] of Object.entries(byProvider.models)) {
        out.push({ engine, provider, id, tier: entry.tier })
      }
    }
  }
  return out
}

function markOf(
  slot: SlotModelsView,
  entry: { engine: string; provider?: string; id: string },
): ModelAvailability {
  if (slot.engine !== entry.engine) return 'unavailable'
  return slot.marks[markKeyFor(entry.engine, entry.provider, entry.id)] ?? 'unlisted'
}

/**
 * The tiers one slot can actually run (§3 rule 2): every tier with at least one table
 * entry the probe marked `available` on that slot. `unlisted` never qualifies — unknown
 * is not offered — and unhealthy slots contribute nothing.
 */
export function availableTiersOnSlot(slot: SlotModelsView, table: TierTableLike): ModelTier[] {
  if (!slot.healthy) return []
  const tiers = new Set<ModelTier>()
  for (const entry of tableEntries(table)) {
    if (markOf(slot, entry) === 'available') tiers.add(entry.tier)
  }
  return table.tiers.filter((tier) => tiers.has(tier))
}

/** The tiers placeable anywhere: the union of `availableTiersOnSlot` over healthy slots. */
export function placeableTiers(table: TierTableLike, slots: readonly SlotModelsView[]): ModelTier[] {
  const union = new Set<ModelTier>()
  for (const slot of slots) for (const tier of availableTiersOnSlot(slot, table)) union.add(tier)
  return table.tiers.filter((tier) => union.has(tier))
}

/** What each healthy slot's marks say about one tier — for honest repair messages. */
export function tierMarkSummary(
  tier: ModelTier,
  table: TierTableLike,
  slots: readonly SlotModelsView[],
): ModelAvailability {
  let sawAvailable = false
  let sawUnavailable = false
  for (const slot of slots) {
    if (!slot.healthy) continue
    for (const entry of tableEntries(table)) {
      if (entry.tier !== tier) continue
      // An entry the slot's engine cannot even address says nothing — only a probe mark
      // on the slot's OWN engine counts (unavailable must mean the engine said no).
      if (slot.engine !== entry.engine) continue
      const mark = slot.marks[markKeyFor(entry.engine, entry.provider, entry.id)] ?? 'unlisted'
      if (mark === 'available') sawAvailable = true
      else if (mark === 'unavailable') sawUnavailable = true
    }
  }
  if (sawAvailable) return 'available'
  return sawUnavailable ? 'unavailable' : 'unlisted'
}

// ── Plan-level validation (§5.2) ─────────────────────────────────────────────────────────────

export type TierIssueKind =
  | 'tier_not_in_table'
  | 'tier_unavailable'
  | 'unknown_model'
  | 'model_unavailable'
  | 'frontier_not_authorised'
  | 'subagent_policy_over_ceiling'

export type TierIssue = { kind: TierIssueKind; detail: string; taskId?: string }

/** One proposed task as tier validation sees it (the §5.2 propose_plan task, trimmed). */
export type TierPlanTask = {
  taskId: string
  role?: string
  modelRequest?: { tier?: ModelTier; model?: string; effort?: string; variant?: string; reason: string }
  subagentPolicy?: { maxTier: ModelTier; depth: number }
}

/** The default subagent ceiling when neither the role nor 'default' is in the table. */
const FALLBACK_SUBAGENT_CEILING = { max_tier: 'fast' as ModelTier, depth: 1 }

/**
 * Validates the tier side of a proposed plan (§5.2): every model_request must name a
 * table tier/model that at least one healthy slot marks available, `frontier` needs the
 * user's pre-authorisation, and a task's subagent policy must stay within its role's
 * ceiling (the role-specific entry, else the table's `default`). Deterministic and pure —
 * the same input always yields the same issues in task order.
 */
export function validateTierPlan(input: {
  tasks: readonly TierPlanTask[]
  table: TierTableLike
  slots: readonly SlotModelsView[]
  /** §3 `frontier: requires: preauthorised` — computed by the caller from the policy digest. */
  frontierPreAuthorised: boolean
}): TierIssue[] {
  const issues: TierIssue[] = []
  const placeable = placeableTiers(input.table, input.slots)
  const entries = tableEntries(input.table)

  for (const task of input.tasks) {
    const request = task.modelRequest
    if (request !== undefined) {
      if (request.tier !== undefined && !input.table.tiers.includes(request.tier)) {
        issues.push({
          kind: 'tier_not_in_table',
          taskId: task.taskId,
          detail: `Task '${task.taskId}': tier '${request.tier}' is not in the capability table (tiers: ${input.table.tiers.join(', ')})`,
        })
        continue
      }
      if (request.tier !== undefined) {
        if (!placeable.includes(request.tier)) {
          const mark = tierMarkSummary(request.tier, input.table, input.slots)
          const alternatives =
            placeable.length > 0
              ? placeable.join(', ')
              : 'none — drop model_request and let the role default apply'
          issues.push({
            kind: 'tier_unavailable',
            taskId: task.taskId,
            detail: `Task '${task.taskId}': no healthy slot marks a '${request.tier}' model available (mark: ${mark}${
              mark === 'unlisted' ? ' — unprobed on this engine, not offered' : ''
            }); placeable tiers: ${alternatives}`,
          })
          continue
        }
        if (request.tier === 'frontier' && !input.frontierPreAuthorised) {
          issues.push({
            kind: 'frontier_not_authorised',
            taskId: task.taskId,
            detail:
              `Task '${task.taskId}' asks for frontier, which is never autonomous (§3): it needs the user's ` +
              `pre-authorisation (a frontier_model confirmation) — propose strong instead, or request the confirmation first`,
          })
          continue
        }
      }
      if (request.model !== undefined) {
        const [providerPart, idPart] = request.model.includes('/')
          ? (request.model.split('/') as [string, string])
          : [undefined, request.model]
        const entry = entries.find(
          (candidate) =>
            candidate.id === idPart &&
            (providerPart === undefined ||
              candidate.provider === undefined ||
              candidate.provider === providerPart),
        )
        if (entry === undefined) {
          issues.push({
            kind: 'unknown_model',
            taskId: task.taskId,
            detail: `Task '${task.taskId}': model '${request.model}' is not in the capability table`,
          })
          continue
        }
        const onHealthySlot = input.slots.some((slot) => slot.healthy && markOf(slot, entry) === 'available')
        if (!onHealthySlot) {
          issues.push({
            kind: 'model_unavailable',
            taskId: task.taskId,
            detail: `Task '${task.taskId}': model '${request.model}' is not marked available on any healthy slot (probe before trust, §3 rule 2)`,
          })
          continue
        }
        if (entry.tier === 'frontier' && !input.frontierPreAuthorised) {
          issues.push({
            kind: 'frontier_not_authorised',
            taskId: task.taskId,
            detail: `Task '${task.taskId}' names frontier model '${request.model}', which needs the user's pre-authorisation — never autonomous (§3)`,
          })
        }
      }
    }

    const policy = task.subagentPolicy
    if (policy !== undefined) {
      const ceiling =
        input.table.routing.subagents[task.role ?? 'default'] ??
        input.table.routing.subagents.default ??
        FALLBACK_SUBAGENT_CEILING
      if (!tierWithin(policy.maxTier, ceiling.max_tier)) {
        issues.push({
          kind: 'subagent_policy_over_ceiling',
          taskId: task.taskId,
          detail: `Task '${task.taskId}': subagent max_tier '${policy.maxTier}' exceeds the ceiling for role '${task.role ?? 'default'}' (${ceiling.max_tier})`,
        })
      }
      if (policy.depth > ceiling.depth) {
        issues.push({
          kind: 'subagent_policy_over_ceiling',
          taskId: task.taskId,
          detail: `Task '${task.taskId}': subagent depth ${policy.depth} exceeds the ceiling for role '${task.role ?? 'default'}' (${ceiling.depth})`,
        })
      }
    }
  }
  return issues
}
