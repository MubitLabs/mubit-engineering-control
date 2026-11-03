import type { TaskId } from '@mec/contracts'

/**
 * Task-graph validation, plan §10: the deterministic validator the meta agent's proposed
 * plan must pass — cycles, missing dependencies, unknown checks/roles, path-conflict
 * signals and attempt budgets. Ported from v1's task-graph.ts, reduced to v4.1's kinds.
 *
 * Path overlap between independent tasks is a conflict *signal*, not a semantic dependency
 * detector (v1 discipline, kept): it is returned so the plan can be tightened, but it does
 * not alone invalidate the graph. `slot_unavailable` is emitted by the scheduling-side
 * check, which sees live slot health; this pure graph check never produces it, and the kind
 * is shared so plans and scheduling report uniformly.
 */

export type BasePolicy = 'integration' | 'contract'

export type TaskNode = {
  id: TaskId
  dependsOn: TaskId[]
  ownedPaths: string[]
  acceptanceChecks: string[]
  maxAttempts: number
  basePolicy: BasePolicy
}

/**
 * A task may pin a specialist role from the registry (§7); a plain TaskNode carries none.
 * The validator rejects roles outside `knownRoles` so a plan can never reference a role
 * that no prompt bundle defines.
 */
export type RoledTaskNode = TaskNode & { role?: string }

export type GraphIssueKind =
  | 'cycle'
  | 'missing_dependency'
  | 'unknown_check'
  | 'unknown_role'
  | 'path_conflict'
  | 'budget'
  | 'slot_unavailable'

export type GraphIssue = {
  kind: GraphIssueKind
  detail: string
  taskId?: TaskId
}

export function validateGraph(
  tasks: readonly RoledTaskNode[],
  opts: { knownChecks: readonly string[]; knownRoles: readonly string[] },
): GraphIssue[] {
  const issues: GraphIssue[] = []
  const byId = new Map<TaskId, RoledTaskNode>()
  for (const t of tasks) byId.set(t.id, t)

  const checks = new Set(opts.knownChecks)
  const roles = new Set(opts.knownRoles)

  for (const t of byId.values()) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) {
        issues.push({
          kind: 'missing_dependency',
          detail: `Task '${t.id}' depends on '${dep}', which is not in this plan`,
          taskId: t.id,
        })
      }
    }
    for (const check of t.acceptanceChecks) {
      if (!checks.has(check)) {
        issues.push({
          kind: 'unknown_check',
          detail: `Task '${t.id}' uses check '${check}', which is not defined for this repository`,
          taskId: t.id,
        })
      }
    }
    if (t.role !== undefined && !roles.has(t.role)) {
      issues.push({
        kind: 'unknown_role',
        detail: `Task '${t.id}' names role '${t.role}', which is not in the registry`,
        taskId: t.id,
      })
    }
    if (t.maxAttempts <= 0) {
      issues.push({
        kind: 'budget',
        detail: `Task '${t.id}' has maxAttempts ${t.maxAttempts}; at least 1 is required`,
        taskId: t.id,
      })
    }
  }

  const deps = (t: RoledTaskNode): TaskId[] => t.dependsOn.filter((d) => byId.has(d))
  for (const cycle of findCycles(byId, deps)) {
    const [head] = cycle
    if (head !== undefined) {
      issues.push({
        kind: 'cycle',
        detail: `Dependency cycle: ${[...cycle, head].join(' -> ')}`,
        taskId: head,
      })
    }
  }

  // Dependency closures are only well-defined on an acyclic graph (v1 discipline, kept).
  if (!issues.some((issue) => issue.kind === 'cycle')) conflictSignals(byId, deps, issues)
  return issues
}

/** Depth-first cycle search; each distinct cycle is reported once, with its full path. */
function findCycles(byId: Map<TaskId, RoledTaskNode>, deps: (t: RoledTaskNode) => TaskId[]): TaskId[][] {
  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const color = new Map<TaskId, number>([...byId.keys()].map((k) => [k, WHITE]))
  const stack: TaskId[] = []
  const cycles: TaskId[][] = []
  const seen = new Set<string>()

  const visit = (key: TaskId): void => {
    color.set(key, GREY)
    stack.push(key)
    const node = byId.get(key)
    if (node !== undefined) {
      for (const dep of deps(node)) {
        if (color.get(dep) === GREY) {
          const cycle = stack.slice(stack.indexOf(dep))
          const id = [...cycle].sort().join(',')
          if (!seen.has(id)) {
            seen.add(id)
            cycles.push(cycle)
          }
        } else if (color.get(dep) === WHITE) {
          visit(dep)
        }
      }
    }
    stack.pop()
    color.set(key, BLACK)
  }
  for (const key of [...byId.keys()].sort()) {
    if (color.get(key) === WHITE) visit(key)
  }
  return cycles
}

/**
 * Flag independent tasks that own overlapping paths. Dependent tasks never conflict: a task
 * that depends on another builds on its integration (§14), so shared paths are expected.
 */
function conflictSignals(
  byId: Map<TaskId, RoledTaskNode>,
  deps: (t: RoledTaskNode) => TaskId[],
  issues: GraphIssue[],
): void {
  const ancestors = new Map<TaskId, Set<TaskId>>()
  const ancestorsOf = (key: TaskId): Set<TaskId> => {
    const cached = ancestors.get(key)
    if (cached) return cached
    const out = new Set<TaskId>()
    const node = byId.get(key)
    if (node !== undefined) {
      for (const dep of deps(node)) {
        out.add(dep)
        for (const ancestor of ancestorsOf(dep)) out.add(ancestor)
      }
    }
    ancestors.set(key, out)
    return out
  }

  const tasks = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]
      const b = tasks[j]
      if (a === undefined || b === undefined) continue
      if (ancestorsOf(a.id).has(b.id) || ancestorsOf(b.id).has(a.id)) continue
      const overlaps = a.ownedPaths.flatMap((pa) =>
        b.ownedPaths.filter((pb) => pathsOverlap(pa, pb)).map((pb) => `${pa} ~ ${pb}`),
      )
      if (overlaps.length > 0) {
        issues.push({
          kind: 'path_conflict',
          detail: `Tasks '${a.id}' and '${b.id}' can run concurrently but own overlapping paths: ${overlaps.join(', ')}`,
          taskId: a.id,
        })
      }
    }
  }
}

/** Strip glob suffixes so 'src/api/**' and 'src/api/' compare as the prefix 'src/api'. */
export function normalisePath(path: string): string {
  let p = path.trim().replace(/^\.\//, '').replace(/\\/g, '/')
  const glob = p.search(/[*?[{]/)
  if (glob !== -1) p = p.slice(0, glob)
  return p.replace(/\/+$/, '')
}

/** Do two declared paths cover any of the same files? A root path covers everything. */
export function pathsOverlap(a: string, b: string): boolean {
  const pa = normalisePath(a)
  const pb = normalisePath(b)
  if (pa === '' || pb === '') return true
  return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)
}
