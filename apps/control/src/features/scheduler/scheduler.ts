import type { TaskSpec } from '@mec/contracts'
import { type Blocker, type Candidate, planDispatches } from '@mec/domain'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../../config'
import type { Sql } from '../../db/sql'
import type { EventBus } from '../../events/bus'
import { HttpError } from '../../http/errors'
import { claimAttempt } from '../attempts/service'
import type { RunnerRegistry } from '../runners/registry'
import { currentLoad, dispatchPaused, runnerSlots } from './capacity'

interface ReadyTask {
  id: string
  deliveryId: string
  projectId: string
  ownerId: string | null
  priority: number
  createdAt: Date
  spec: TaskSpec
  blocker: Blocker | null
}

export interface SchedulingProfile {
  id: string
  ownerId: string
  runnerId: string
  agentKind: string
  allowedProjectIds: string[]
  delegateIds: string[]
  authState: string
  maxActive: number
}

/**
 * Picks the execution profile for a task (PDF §5): the one named in the task, or any profile the
 * task owner may use on this project. Never another employee's account without a grant, and never
 * one whose native sign-in is known to be broken.
 */
export function chooseProfile(
  task: { projectId: string; ownerId: string | null; spec: TaskSpec },
  profiles: SchedulingProfile[],
  byProfile: Readonly<Record<string, number>>,
): SchedulingProfile | null {
  const usable = (p: SchedulingProfile) =>
    p.allowedProjectIds.includes(task.projectId) &&
    task.ownerId !== null &&
    (p.ownerId === task.ownerId || p.delegateIds.includes(task.ownerId)) &&
    p.authState !== 'required'
  if (task.spec.executionProfileId) {
    const named = profiles.find((p) => p.id === task.spec.executionProfileId)
    return named && usable(named) ? named : null
  }
  const load = (p: SchedulingProfile) => byProfile[p.id] ?? 0
  const full = (p: SchedulingProfile) => (load(p) >= p.maxActive ? 1 : 0)
  return (
    profiles
      .filter(usable)
      .sort((a, b) => full(a) - full(b) || load(a) - load(b) || a.id.localeCompare(b.id))[0] ?? null
  )
}

/**
 * The deterministic scheduler (PDF §11): every tick it plans dispatches for ready tasks with
 * @mec/domain's planDispatches and claims each in its own transaction, where the limits are checked
 * again under the dispatch lock. Wakes early on any event.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private unsubscribe: (() => void) | null = null
  private running = false
  private again = false

  constructor(
    private readonly sql: Sql,
    private readonly registry: RunnerRegistry,
    private readonly bus: EventBus,
    private readonly config: Config['scheduling'],
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.tickMs)
    this.unsubscribe = this.bus.subscribe('*', () => void this.tick())
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
  }

  /** One planning pass. Concurrent calls coalesce into one extra pass. */
  async tick(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      do {
        this.again = false
        await this.pass()
      } while (this.again)
    } catch (err) {
      this.log.error({ err }, 'scheduler pass failed')
    } finally {
      this.running = false
    }
  }

  private async pass(): Promise<void> {
    if (await dispatchPaused(this.sql)) return
    const ready = await this.sql<ReadyTask[]>`
      select t.id, t.delivery_id, d.project_id, t.owner_id, d.priority, t.created_at, t.spec, t.blocker
      from tasks t
      join deliveries d on d.id = t.delivery_id
      join projects p on p.id = d.project_id
      where t.state = 'ready' and t.kind = 'work' and p.paused_at is null and d.state in ('approved', 'executing')
        and t.attempts_used < coalesce((t.spec->>'maxAttempts')::int, 2)
      order by t.created_at
      limit 500
    `
    if (ready.length === 0) return
    const connected = this.registry.connectedIds()
    const load = await currentLoad(this.sql)
    const profiles = await this.sql<SchedulingProfile[]>`
      select id, owner_id, runner_id, agent_kind, allowed_project_ids, delegate_ids, auth_state, max_active
      from execution_profiles where revoked_at is null
    `
    const candidates: Candidate[] = []
    const unassignable: { taskId: string; detail: string }[] = []
    for (const t of ready) {
      const profile = chooseProfile(t, profiles, load.byProfile)
      const base = {
        taskId: t.id,
        deliveryId: t.deliveryId,
        projectId: t.projectId,
        priority: t.priority,
        createdAt: t.createdAt.getTime(),
      }
      if (profile) {
        candidates.push({
          ...base,
          agentKind: profile.agentKind,
          profileId: profile.id,
          runnerId: profile.runnerId,
          profileMaxActive: profile.maxActive,
        })
      } else if (this.config.defaultAgent === 'fake' && !t.spec.executionProfileId) {
        candidates.push({ ...base, agentKind: 'fake', profileId: null, runnerId: null })
      } else {
        unassignable.push({
          taskId: t.id,
          detail: 'Waiting: no execution profile the task owner may use here',
        })
      }
    }
    const plan = planDispatches(candidates, await runnerSlots(this.sql, connected), load, this.config.limits)
    plan.held.push(
      ...unassignable.map((u) => ({
        taskId: u.taskId,
        limit: 'no_runner' as const,
        detail: u.detail.replace('Waiting: ', ''),
      })),
    )

    for (const d of plan.dispatches) {
      const candidate = candidates.find((c) => c.taskId === d.taskId)!
      try {
        await this.sql.begin((tx) =>
          claimAttempt(tx, {
            taskId: d.taskId,
            runnerId: d.runnerId,
            agentKind: candidate.agentKind as 'fake' | 'claude-code',
            profileId: candidate.profileId,
            inputs: {},
            actor: { kind: 'system', id: 'scheduler' },
            leaseMs: this.config.leaseTtlMs,
            capacity: { limits: this.config.limits, connectedIds: connected },
          }),
        )
      } catch (err) {
        // A concurrent claim or a limit reached since planning; the next pass re-plans.
        if (!(err instanceof HttpError && err.status === 409)) throw err
      }
    }

    for (const h of plan.held) {
      const task = ready.find((t) => t.id === h.taskId)!
      const blocker: Blocker = {
        kind: h.limit === 'no_runner' ? 'infrastructure' : 'capacity',
        detail: `Waiting: ${h.detail}`,
        refs: [],
      }
      if (task.blocker?.detail === blocker.detail) continue
      await this.sql`
        update tasks set blocker = ${this.sql.json(blocker as never)}, updated_at = now()
        where id = ${task.id} and state = 'ready'
      `
    }
  }
}
