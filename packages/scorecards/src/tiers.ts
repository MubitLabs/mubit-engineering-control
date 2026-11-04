/**
 * The tier-era scorecards, plan §5.5 (learning without experiments): what each repository's
 * role × tier combinations actually delivered, and the hints the planner reads instead of
 * running experiments. Pure functions over `AttemptOutcome` rows — the nightly projection
 * stores what these return; there is no storage here.
 *
 * Types mirrored while contracts-v0.1 is in flight: `ModelTier` and `LaunchModel` duplicate
 * the `AttemptBrief.model_request.tier` / `LaunchSpec.model` shapes another change is adding
 * to `@mec/contracts`. They are structurally identical, so the integrator unifies them at
 * merge with no seam.
 *
 * Unknown-handling (§19's rule — missing data is unknown, not zero — carried into tiers):
 * - Every metric stays null until a cell holds `MIN_TIER_CELL_ATTEMPTS` attempts; below that
 *   only the count is emitted. A thin cell never whispers a rate.
 * - `repairRate` divides by the attempts a task could be linked to: rows without `taskId`
 *   leave the divisor, and a cell with no linkage at all reports null — never a fake 0.
 * - `reviewFindings` averages the attempts that reported findings; `meanWallClockMs` and
 *   `meanCostUsd` average the known values. Unknown costs never count as $0.
 * - Rows that never carried a tier (explicit-model or pre-tier asks) keep their own
 *   `tier: undefined` cell — the counts stay honest — but they never rank in hints.
 */
import type { AttemptOutcome } from './project'

/** The ladder, cheapest rung first (plan §2); the order full ties break on. */
export const TIER_LADDER = ['fast', 'balanced', 'strong', 'frontier'] as const

/** A rung on the ladder; mirrors contracts-v0.1 `AttemptBrief.model_request.tier`. */
export type ModelTier = (typeof TIER_LADDER)[number]

/** What the runtime launched once a tier resolved; mirrors contracts-v0.1 `LaunchSpec.model`. */
export type LaunchModel = { id: string; effort?: string; variant?: string }

/** §5.5: unknown until five attempts exist. */
export const MIN_TIER_CELL_ATTEMPTS = 5

/** One repository × role × tier cell of the nightly `scorecards/tiers` projection. */
export type TierCell = {
  repository: string
  role: string
  /** Undefined for rows that never carried one — an explicit-model or pre-tier ask. */
  tier: ModelTier | undefined
  attempts: number
  successRate: number | null
  repairRate: number | null
  reviewFindings: number | null
  meanWallClockMs: number | null
  meanCostUsd: number | null
}

/** The per-tier snapshot an ordering carries, so the planner sees what is behind it. */
export type TierSnapshot = {
  tier: ModelTier
  attempts: number
  successRate: number | null
  repairRate: number | null
  reviewFindings: number | null
  meanWallClockMs: number | null
  meanCostUsd: number | null
}

/** One role's best-first answer. */
export type RoleTierOrdering = {
  role: string
  /** Best-first: success → fewer repairs → faster → cheaper; a full tie goes to the cheaper rung. */
  ordering: ModelTier[]
  /** Attempts behind the thinnest ranked tier; 0 when nothing ranked yet. */
  confidence: number
  /** Every tiered cell for the role, ladder order — sub-threshold cells carry counts and nulls. */
  tiers: TierSnapshot[]
}

/** What `hintsFor` hands the planner (§5.1's `scorecard hints` line). */
export type TierHints =
  | { known: true; orderings: RoleTierOrdering[] }
  | { known: false; reason: 'not_enough_data'; attemptsSeen: number; attemptsNeeded: number }

function ladderIndexOf(tier: ModelTier | undefined): number {
  if (tier === undefined) return TIER_LADDER.length // tier-undefined cells sort last
  const index = TIER_LADDER.indexOf(tier)
  return index === -1 ? TIER_LADDER.length : index
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Deterministic output order: repository, then role, then the ladder with tier-undefined last. */
function compareCells(a: TierCell, b: TierCell): number {
  if (a.repository !== b.repository) return a.repository < b.repository ? -1 : 1
  if (a.role !== b.role) return a.role < b.role ? -1 : 1
  return ladderIndexOf(a.tier) - ladderIndexOf(b.tier)
}

type PlacedRow = AttemptOutcome & { repository: string }
type LinkedRow = PlacedRow & { taskId: string }

function cellOf(
  group: { repository: string; role: string; tier: ModelTier | undefined; rows: PlacedRow[] },
  repairedTasks: ReadonlySet<string>,
): TierCell {
  const { repository, role, tier, rows } = group
  const attempts = rows.length
  if (attempts < MIN_TIER_CELL_ATTEMPTS) {
    return {
      repository,
      role,
      tier,
      attempts,
      successRate: null,
      repairRate: null,
      reviewFindings: null,
      meanWallClockMs: null,
      meanCostUsd: null,
    }
  }
  const linked = rows.filter((row): row is LinkedRow => row.taskId !== undefined)
  const findings = rows
    .map((row) => row.reviewFindings)
    .filter((finding): finding is number => finding !== undefined)
  const clocks = rows
    .map((row) => row.durationMs)
    .filter((duration): duration is number => duration !== 'unknown')
  const costs = rows.map((row) => row.spend).filter((spend): spend is number => spend !== 'unknown')
  return {
    repository,
    role,
    tier,
    attempts,
    successRate: rows.filter((row) => row.result === 'completed').length / attempts,
    repairRate:
      linked.length === 0
        ? null
        : linked.filter((row) => repairedTasks.has(row.taskId)).length / linked.length,
    reviewFindings: findings.length === 0 ? null : meanOf(findings),
    meanWallClockMs: clocks.length === 0 ? null : meanOf(clocks),
    meanCostUsd: costs.length === 0 ? null : meanOf(costs),
  }
}

/**
 * The nightly projection: one cell per repository × role × tier. Rows the attempt could not
 * place in a repository cannot join a per-repository projection and are skipped; rows without
 * a role bucket under `'unknown'` (the rollup's convention). Repair linkage is read from the
 * same rows: a task saw a repair when any `repair_agent` attempt in the repository carries its
 * `taskId`.
 */
export function projectTiers(rows: readonly AttemptOutcome[]): TierCell[] {
  const placed = rows.filter((row): row is PlacedRow => row.repository !== undefined)
  const repairs = new Map<string, Set<string>>()
  for (const row of placed) {
    if (row.role !== 'repair_agent' || row.taskId === undefined) continue
    const tasks = repairs.get(row.repository) ?? new Set<string>()
    tasks.add(row.taskId)
    repairs.set(row.repository, tasks)
  }
  const groups = new Map<
    string,
    { repository: string; role: string; tier: ModelTier | undefined; rows: PlacedRow[] }
  >()
  for (const row of placed) {
    const role = row.role ?? 'unknown'
    const key = JSON.stringify([row.repository, role, row.tier])
    const group = groups.get(key) ?? { repository: row.repository, role, tier: row.tier, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => cellOf(group, repairs.get(group.repository) ?? new Set<string>()))
    .sort(compareCells)
}

/** A cell that passed the gate — `successRate` is non-null exactly when the gate was passed. */
type RankedCell = TierSnapshot & { successRate: number }

/** An axis without data decides nothing: null on either side skips to the next criterion. */
function axis(x: number | null, y: number | null): number {
  if (x === null || y === null) return 0
  return x - y
}

function compareRanked(a: RankedCell, b: RankedCell): number {
  if (a.successRate !== b.successRate) return b.successRate - a.successRate
  const repairs = axis(a.repairRate, b.repairRate)
  if (repairs !== 0) return repairs
  const speed = axis(a.meanWallClockMs, b.meanWallClockMs)
  if (speed !== 0) return speed
  const cost = axis(a.meanCostUsd, b.meanCostUsd)
  if (cost !== 0) return cost
  return ladderIndexOf(a.tier) - ladderIndexOf(b.tier) // ties go to the cheapest rung
}

function snapshotOf(cell: TierCell & { tier: ModelTier }): TierSnapshot {
  return {
    tier: cell.tier,
    attempts: cell.attempts,
    successRate: cell.successRate,
    repairRate: cell.repairRate,
    reviewFindings: cell.reviewFindings,
    meanWallClockMs: cell.meanWallClockMs,
    meanCostUsd: cell.meanCostUsd,
  }
}

/**
 * The planner's hints for one repository, one role (or every role the repository saw).
 * Unknown until five attempts exist for the query — and unknown-tier attempts count towards
 * `attemptsSeen` but never rank, so pre-tier history fills the gate without voting.
 */
export function hintsFor(
  repository: string,
  role: string | undefined,
  rows: readonly AttemptOutcome[],
): TierHints {
  const inRepo = rows.filter((row) => row.repository === repository)
  const scope = role === undefined ? inRepo : inRepo.filter((row) => row.role === role)
  const attemptsSeen = scope.length
  if (attemptsSeen < MIN_TIER_CELL_ATTEMPTS) {
    return {
      known: false,
      reason: 'not_enough_data',
      attemptsSeen,
      attemptsNeeded: MIN_TIER_CELL_ATTEMPTS,
    }
  }
  // The projection is built from every role's rows in the repository: repair linkage must see
  // the repair agents, whatever role the hint is for.
  const tiered = projectTiers(inRepo).filter(
    (cell): cell is TierCell & { tier: ModelTier } => cell.tier !== undefined,
  )
  const roles = role !== undefined ? [role] : [...new Set(inRepo.map((row) => row.role ?? 'unknown'))].sort()
  return {
    known: true,
    orderings: roles.map((each) => {
      const tiers = tiered.filter((cell) => cell.role === each).map(snapshotOf)
      const ranked = tiers.filter((cell): cell is RankedCell => cell.successRate !== null)
      return {
        role: each,
        ordering: [...ranked].sort(compareRanked).map((cell) => cell.tier),
        confidence: ranked.length === 0 ? 0 : Math.min(...ranked.map((cell) => cell.attempts)),
        tiers,
      }
    }),
  }
}
