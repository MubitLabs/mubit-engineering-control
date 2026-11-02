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
  priority: number
  createdAt: Date
  spec: TaskSpec
  blocker: Blocker | null
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
      select t.id, t.delivery_id, d.project_id, d.priority, t.created_at, t.spec, t.blocker
      from tasks t
      join deliveries d on d.id = t.delivery_id
      join projects p on p.id = d.project_id
      where t.state = 'ready' and p.paused_at is null and d.state in ('approved', 'executing')
      order by t.created_at
      limit 500
    `
    if (ready.length === 0) return
    const connected = this.registry.connectedIds()
    const candidates: Candidate[] = ready.map((t) => ({
      taskId: t.id,
      deliveryId: t.deliveryId,
      projectId: t.projectId,
      priority: t.priority,
      createdAt: t.createdAt.getTime(),
      agentKind: this.config.defaultAgent,
      profileId: t.spec.executionProfileId ?? null,
      runnerId: null,
    }))
    const plan = planDispatches(
      candidates,
      await runnerSlots(this.sql, connected),
      await currentLoad(this.sql),
      this.config.limits,
    )

    for (const d of plan.dispatches) {
      const candidate = candidates.find((c) => c.taskId === d.taskId)!
      try {
        await this.sql.begin((tx) =>
          claimAttempt(tx, {
            taskId: d.taskId,
            runnerId: d.runnerId,
            agentKind: candidate.agentKind as 'fake' | 'claude-code',
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
