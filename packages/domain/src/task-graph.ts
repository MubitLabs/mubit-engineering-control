import type { TaskSpec } from '@mec/contracts'

/**
 * Task-graph validation, PDF §8: reject cycles, missing dependencies, references outside the
 * delivery, missing acceptance checks and unavailable profiles. Path overlap and hotspot files
 * are conflict *signals* (warnings), not a semantic dependency detector.
 */

export type GraphIssueCode =
  | 'empty_graph'
  | 'duplicate_task'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'cycle'
  | 'unknown_requirement'
  | 'missing_objective'
  | 'missing_acceptance_checks'
  | 'unknown_check'
  | 'unavailable_profile'
  | 'invalid_budget'
  | 'owned_path_overlap'
  | 'hotspot'
  | 'concurrent_hotspot'
  | 'uncovered_requirement'
  | 'no_owned_paths'

export interface GraphIssue {
  severity: 'error' | 'warning'
  code: GraphIssueCode
  message: string
  taskKeys: string[]
}

export interface GraphContext {
  requirementIds: readonly string[]
  availableProfileIds: readonly string[]
  /** Check names defined by the repository validation profile; omit to skip the check. */
  knownCheckNames?: readonly string[]
  limits?: { maxAttempts: number; maxTimeBudgetMinutes: number }
}

export interface GraphValidation {
  ok: boolean
  errors: GraphIssue[]
  warnings: GraphIssue[]
  /** Topological order (dependencies first), ties broken by integrationOrder then key. */
  order: string[]
  /** Depth of each task: 0 for tasks without dependencies. */
  levels: Record<string, number>
  /** Largest number of tasks at the same depth, an upper bound on useful parallelism. */
  maxParallelism: number
}

type Spec = Pick<
  TaskSpec,
  | 'key'
  | 'objective'
  | 'requirementIds'
  | 'acceptanceChecks'
  | 'dependsOn'
  | 'ownedPaths'
  | 'executionProfileId'
  | 'maxAttempts'
  | 'timeBudgetMinutes'
  | 'integrationOrder'
>

const DEFAULT_LIMITS = { maxAttempts: 5, maxTimeBudgetMinutes: 480 }

export function validateTaskGraph(tasks: readonly Spec[], ctx: GraphContext): GraphValidation {
  const errors: GraphIssue[] = []
  const warnings: GraphIssue[] = []
  const error = (code: GraphIssueCode, message: string, taskKeys: string[]) =>
    errors.push({ severity: 'error', code, message, taskKeys })
  const warn = (code: GraphIssueCode, message: string, taskKeys: string[]) =>
    warnings.push({ severity: 'warning', code, message, taskKeys })

  if (tasks.length === 0) error('empty_graph', 'The plan has no tasks', [])

  const byKey = new Map<string, Spec>()
  for (const t of tasks) {
    if (byKey.has(t.key)) error('duplicate_task', `Task key '${t.key}' is used more than once`, [t.key])
    else byKey.set(t.key, t)
  }

  const requirementIds = new Set(ctx.requirementIds)
  const profiles = new Set(ctx.availableProfileIds)
  const checks = ctx.knownCheckNames ? new Set(ctx.knownCheckNames) : null
  const limits = ctx.limits ?? DEFAULT_LIMITS

  for (const t of byKey.values()) {
    if (t.objective.trim() === '') error('missing_objective', `Task '${t.key}' has no objective`, [t.key])
    if (t.acceptanceChecks.length === 0) {
      error('missing_acceptance_checks', `Task '${t.key}' has no acceptance checks`, [t.key])
    }
    if (checks) {
      for (const c of t.acceptanceChecks) {
        if (!checks.has(c)) {
          error('unknown_check', `Task '${t.key}' uses check '${c}', not defined for this repository`, [
            t.key,
          ])
        }
      }
    }
    for (const dep of t.dependsOn) {
      if (dep === t.key) error('self_dependency', `Task '${t.key}' depends on itself`, [t.key])
      else if (!byKey.has(dep)) {
        error('unknown_dependency', `Task '${t.key}' depends on '${dep}', which is not in this delivery`, [
          t.key,
        ])
      }
    }
    for (const r of t.requirementIds) {
      if (!requirementIds.has(r)) {
        error('unknown_requirement', `Task '${t.key}' references requirement '${r}', not in this plan`, [
          t.key,
        ])
      }
    }
    if (t.executionProfileId !== null && !profiles.has(t.executionProfileId)) {
      error(
        'unavailable_profile',
        `Task '${t.key}' is assigned to profile '${t.executionProfileId}', which is not available`,
        [t.key],
      )
    }
    if (t.maxAttempts < 1 || t.maxAttempts > limits.maxAttempts) {
      error('invalid_budget', `Task '${t.key}': maxAttempts must be 1..${limits.maxAttempts}`, [t.key])
    }
    if (t.timeBudgetMinutes < 1 || t.timeBudgetMinutes > limits.maxTimeBudgetMinutes) {
      error(
        'invalid_budget',
        `Task '${t.key}': timeBudgetMinutes must be 1..${limits.maxTimeBudgetMinutes}`,
        [t.key],
      )
    }
    if (t.ownedPaths.length === 0) {
      warn('no_owned_paths', `Task '${t.key}' declares no owned paths; conflicts cannot be predicted`, [
        t.key,
      ])
    }
  }

  const covered = new Set([...byKey.values()].flatMap((t) => t.requirementIds))
  for (const r of ctx.requirementIds) {
    if (!covered.has(r)) warn('uncovered_requirement', `Requirement '${r}' is not covered by any task`, [])
  }

  const deps = (t: Spec) => t.dependsOn.filter((d) => d !== t.key && byKey.has(d))
  for (const cycle of findCycles(byKey, deps)) {
    error('cycle', `Dependency cycle: ${[...cycle, cycle[0]].join(' -> ')}`, cycle)
  }

  const { order, levels } = errors.some((e) => e.code === 'cycle')
    ? { order: [], levels: {} }
    : topoOrder(byKey, deps)
  const levelCounts = new Map<number, number>()
  for (const l of Object.values(levels)) levelCounts.set(l, (levelCounts.get(l) ?? 0) + 1)
  const maxParallelism = Math.max(0, ...levelCounts.values())

  if (order.length > 0) conflictSignals(byKey, deps, warn)

  return { ok: errors.length === 0, errors, warnings, order, levels, maxParallelism }
}

function findCycles(byKey: Map<string, Spec>, deps: (t: Spec) => string[]): string[][] {
  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const color = new Map<string, number>([...byKey.keys()].map((k) => [k, WHITE]))
  const stack: string[] = []
  const cycles: string[][] = []
  const seen = new Set<string>()

  const visit = (key: string) => {
    color.set(key, GREY)
    stack.push(key)
    for (const d of deps(byKey.get(key)!)) {
      if (color.get(d) === GREY) {
        const cycle = stack.slice(stack.indexOf(d))
        const id = [...cycle].sort().join(',')
        if (!seen.has(id)) {
          seen.add(id)
          cycles.push(cycle)
        }
      } else if (color.get(d) === WHITE) visit(d)
    }
    stack.pop()
    color.set(key, BLACK)
  }
  for (const k of [...byKey.keys()].sort()) if (color.get(k) === WHITE) visit(k)
  return cycles
}

function topoOrder(byKey: Map<string, Spec>, deps: (t: Spec) => string[]) {
  const levels: Record<string, number> = {}
  const levelOf = (key: string): number => {
    const cached = levels[key]
    if (cached !== undefined) return cached
    const ds = deps(byKey.get(key)!)
    const l = ds.length === 0 ? 0 : 1 + Math.max(...ds.map(levelOf))
    levels[key] = l
    return l
  }
  for (const k of byKey.keys()) levelOf(k)
  const order = [...byKey.values()]
    .sort(
      (a, b) =>
        levels[a.key]! - levels[b.key]! ||
        a.integrationOrder - b.integrationOrder ||
        a.key.localeCompare(b.key),
    )
    .map((t) => t.key)
  return { order, levels }
}

// ── Conflict signals ────────────────────────────────────────────────────────────────────────

type HotspotCategory = 'lockfile' | 'migration' | 'generated' | 'shared_config'

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
])
const SHARED_CONFIG = /^(package\.json|tsconfig(\..+)?\.json|biome\.json|\.eslintrc.*|vite\.config\..+)$/

export function hotspotCategory(path: string): HotspotCategory | null {
  const segments = normalisePath(path).split('/').filter(Boolean)
  const name = segments.at(-1) ?? ''
  if (LOCKFILES.has(name)) return 'lockfile'
  if (segments.some((s) => s === 'migrations' || s === 'migrate') || name.endsWith('.sql')) return 'migration'
  if (segments.some((s) => s === 'generated' || s === '__generated__') || /\.(gen|generated)\./.test(name)) {
    return 'generated'
  }
  if (SHARED_CONFIG.test(name) || segments[0] === '.github') return 'shared_config'
  return null
}

/** Strip glob suffixes so 'src/api/**' and 'src/api/' compare as the prefix 'src/api'. */
export function normalisePath(path: string): string {
  let p = path.trim().replace(/^\.\//, '').replace(/\\/g, '/')
  const glob = p.search(/[*?[{]/)
  if (glob !== -1) p = p.slice(0, glob)
  return p.replace(/\/+$/, '')
}

export function pathsOverlap(a: string, b: string): boolean {
  const pa = normalisePath(a)
  const pb = normalisePath(b)
  if (pa === '' || pb === '') return true
  return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)
}

function conflictSignals(
  byKey: Map<string, Spec>,
  deps: (t: Spec) => string[],
  warn: (code: GraphIssueCode, message: string, keys: string[]) => void,
) {
  const ancestors = new Map<string, Set<string>>()
  const ancestorsOf = (key: string): Set<string> => {
    const cached = ancestors.get(key)
    if (cached) return cached
    const out = new Set<string>()
    for (const d of deps(byKey.get(key)!)) {
      out.add(d)
      for (const a of ancestorsOf(d)) out.add(a)
    }
    ancestors.set(key, out)
    return out
  }
  const concurrent = (a: string, b: string) => !ancestorsOf(a).has(b) && !ancestorsOf(b).has(a)

  const tasks = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
  for (const t of tasks) {
    const cats = new Set(t.ownedPaths.map(hotspotCategory).filter((c) => c !== null))
    for (const c of cats) {
      warn('hotspot', `Task '${t.key}' touches ${c.replace('_', ' ')} files; coordinate changes explicitly`, [
        t.key,
      ])
    }
  }

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!
      const b = tasks[j]!
      if (!concurrent(a.key, b.key)) continue
      const overlaps = a.ownedPaths.flatMap((pa) =>
        b.ownedPaths.filter((pb) => pathsOverlap(pa, pb)).map((pb) => `${pa} ~ ${pb}`),
      )
      if (overlaps.length > 0) {
        warn(
          'owned_path_overlap',
          `Tasks '${a.key}' and '${b.key}' can run in parallel but own overlapping paths: ${overlaps.join(', ')}`,
          [a.key, b.key],
        )
      }
      const catsA = new Set(a.ownedPaths.map(hotspotCategory))
      for (const c of new Set(b.ownedPaths.map(hotspotCategory))) {
        if (c !== null && catsA.has(c)) {
          warn(
            'concurrent_hotspot',
            `Tasks '${a.key}' and '${b.key}' can run in parallel and both touch ${c.replace('_', ' ')} files`,
            [a.key, b.key],
          )
        }
      }
    }
  }
}
