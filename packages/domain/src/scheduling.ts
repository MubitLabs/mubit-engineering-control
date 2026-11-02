/**
 * Deterministic dispatch planning, PDF §11. Given ready tasks, available runners and current
 * load, decide which task goes to which runner. An LLM may suggest priorities; it never grants
 * leases or bypasses limits. The control service re-checks every choice inside the claim
 * transaction, so this function only has to be correct for one snapshot.
 */

export interface Candidate {
  taskId: string
  deliveryId: string
  projectId: string
  /** Higher first. */
  priority: number
  /** Milliseconds since epoch; older first within a project. */
  createdAt: number
  agentKind: string
  /** Execution profile, when the task is bound to one (M7). */
  profileId: string | null
  /** Runner required by the profile, if any. */
  runnerId: string | null
}

export interface RunnerSlot {
  runnerId: string
  name: string
  /** The employee whose machine and accounts this runner uses. */
  ownerId: string
  active: number
  capacity: number
  agentKinds: readonly string[]
}

export interface Load {
  total: number
  byEmployee: Readonly<Record<string, number>>
  byDelivery: Readonly<Record<string, number>>
  byProfile: Readonly<Record<string, number>>
}

export interface Limits {
  global: number
  perEmployee: number
  perDelivery: number
  perProfile: number
}

export const DEFAULT_LIMITS: Limits = { global: 6, perEmployee: 2, perDelivery: 3, perProfile: 1 }

export interface Dispatch {
  taskId: string
  runnerId: string
}

export interface Held {
  taskId: string
  limit: 'global' | 'employee' | 'delivery' | 'profile' | 'runner' | 'no_runner'
  detail: string
}

/**
 * Orders candidates by priority, then rotates fairly across projects (the n-th oldest task of
 * each project before the (n+1)-th of any), then by age and id for a stable result.
 */
export function orderCandidates(candidates: readonly Candidate[]): Candidate[] {
  const byProject = new Map<string, Candidate[]>()
  for (const c of [...candidates].sort(
    (a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId),
  )) {
    const list = byProject.get(c.projectId) ?? []
    list.push(c)
    byProject.set(c.projectId, list)
  }
  const round = new Map<string, number>()
  for (const list of byProject.values()) {
    for (const [i, c] of list.entries()) round.set(c.taskId, i)
  }
  return [...candidates].sort(
    (a, b) =>
      b.priority - a.priority ||
      round.get(a.taskId)! - round.get(b.taskId)! ||
      a.createdAt - b.createdAt ||
      a.taskId.localeCompare(b.taskId),
  )
}

export function planDispatches(
  candidates: readonly Candidate[],
  runners: readonly RunnerSlot[],
  load: Load,
  limits: Limits,
): { dispatches: Dispatch[]; held: Held[] } {
  const total = { n: load.total }
  const employee = { ...load.byEmployee }
  const delivery = { ...load.byDelivery }
  const profile = { ...load.byProfile }
  const runnerActive = new Map(runners.map((r) => [r.runnerId, r.active]))
  const dispatches: Dispatch[] = []
  const held: Held[] = []

  for (const c of orderCandidates(candidates)) {
    if (total.n >= limits.global) {
      held.push({
        taskId: c.taskId,
        limit: 'global',
        detail: `global limit of ${limits.global} active attempts`,
      })
      continue
    }
    if ((delivery[c.deliveryId] ?? 0) >= limits.perDelivery) {
      held.push({ taskId: c.taskId, limit: 'delivery', detail: `delivery limit of ${limits.perDelivery}` })
      continue
    }
    if (c.profileId && (profile[c.profileId] ?? 0) >= limits.perProfile) {
      held.push({ taskId: c.taskId, limit: 'profile', detail: `profile limit of ${limits.perProfile}` })
      continue
    }

    const eligible = runners
      .filter((r) => r.agentKinds.includes(c.agentKind) && (c.runnerId === null || r.runnerId === c.runnerId))
      .sort(
        (a, b) =>
          runnerActive.get(a.runnerId)! - runnerActive.get(b.runnerId)! || a.name.localeCompare(b.name),
      )
    if (eligible.length === 0) {
      held.push({ taskId: c.taskId, limit: 'no_runner', detail: `no connected runner offers ${c.agentKind}` })
      continue
    }
    const withRoom = eligible.filter((r) => runnerActive.get(r.runnerId)! < r.capacity)
    if (withRoom.length === 0) {
      held.push({ taskId: c.taskId, limit: 'runner', detail: 'every eligible runner is at capacity' })
      continue
    }
    const chosen = withRoom.find((r) => (employee[r.ownerId] ?? 0) < limits.perEmployee)
    if (!chosen) {
      held.push({ taskId: c.taskId, limit: 'employee', detail: `employee limit of ${limits.perEmployee}` })
      continue
    }

    dispatches.push({ taskId: c.taskId, runnerId: chosen.runnerId })
    total.n++
    runnerActive.set(chosen.runnerId, runnerActive.get(chosen.runnerId)! + 1)
    employee[chosen.ownerId] = (employee[chosen.ownerId] ?? 0) + 1
    delivery[c.deliveryId] = (delivery[c.deliveryId] ?? 0) + 1
    if (c.profileId) profile[c.profileId] = (profile[c.profileId] ?? 0) + 1
  }
  return { dispatches, held }
}
