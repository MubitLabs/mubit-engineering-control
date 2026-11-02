import { attemptMachine, type Blocker } from '@mec/domain'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../../config'
import type { Sql, Tx } from '../../db/sql'
import { appendEvent, projectStream } from '../../events/append'
import { withdrawCommands } from '../../outbox/commands'
import { type AttemptRow, followTask } from '../attempts/service'
import { transition } from '../state'

/**
 * Recovery loop (PDF §11, §26). An expired lease does not prove the old process is dead, so the
 * attempt becomes `stalled` (quarantined, still holding its slot) until the runner reconnects and
 * reports, or an operator confirms the process is stopped. Only an attempt whose start command was
 * never delivered is released straight back to the queue — no process can exist for it.
 */
export class Reconciler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly startedAt = Date.now()

  constructor(
    private readonly sql: Sql,
    private readonly config: Config['scheduling'],
    private readonly log: FastifyBaseLogger,
    private readonly onApprovalExpired: (tx: Tx, approvalId: string) => Promise<void> = async () => {},
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.reconcileTickMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      if (Date.now() - this.startedAt >= this.config.startupGraceMs) await this.expireLeases()
      await this.expireApprovals()
    } catch (err) {
      this.log.error({ err }, 'reconciler pass failed')
    } finally {
      this.running = false
    }
  }

  async expireLeases(): Promise<void> {
    const expired = await this.sql<{ id: string }[]>`
      select id from attempts
      where state in ('leased', 'preparing', 'running', 'awaiting_input', 'work_complete', 'checking')
        and lease_expires_at < now()
      order by lease_expires_at
      limit 50
    `
    for (const { id } of expired) await this.sql.begin((tx) => expireLease(tx, id))
  }

  async expireApprovals(): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      select id from approvals where status = 'pending' and expires_at is not null and expires_at <= now() limit 50
    `
    for (const { id } of rows) {
      await this.sql.begin(async (tx) => {
        const [a] = await tx<
          { id: string; projectId: string; kind: string; taskId: string | null; attemptId: string | null }[]
        >`
          update approvals set status = 'expired', resolved_at = now(), answer = ${tx.json({ reason: 'expired unanswered' } as never)}
          where id = ${id} and status = 'pending'
          returning id, project_id, kind, task_id, attempt_id
        `
        if (!a) return
        await appendEvent(tx, {
          stream: projectStream(a.projectId),
          type: 'approval.closed',
          projectId: a.projectId,
          taskId: a.taskId,
          attemptId: a.attemptId,
          actor: { kind: 'system' },
          payload: { approvalId: a.id, kind: a.kind, status: 'expired', reason: 'expired unanswered' },
        })
        await this.onApprovalExpired(tx, a.id)
      })
    }
  }
}

export async function expireLease(tx: Tx, attemptId: string): Promise<void> {
  const [attempt] = await tx<AttemptRow[]>`
    select * from attempts where id = ${attemptId} and lease_expires_at < now() for update
  `
  if (
    !attempt ||
    !['leased', 'preparing', 'running', 'awaiting_input', 'work_complete', 'checking'].includes(attempt.state)
  ) {
    return
  }
  const ctx = {
    projectId: attempt.projectId,
    deliveryId: attempt.deliveryId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    actor: { kind: 'system' as const },
  }

  if (attempt.state === 'leased' && attempt.generation === 1) {
    const [undelivered] = await tx`
      select 1 from outbox where idempotency_key = ${`${attempt.id}:g1:start`} and delivered_at is null
    `
    if (undelivered) {
      await withdrawCommands(tx, attempt.id, 'dispatch expired before the runner received it')
      await tx`update tasks set attempts_used = greatest(attempts_used - 1, 0) where id = ${attempt.taskId}`
      const to = await transition(tx, {
        table: 'attempts',
        machine: attemptMachine,
        id: attempt.id,
        from: 'leased',
        event: 'cancel',
        set: { leaseExpiresAt: null, finishedAt: new Date() },
        ...ctx,
        payload: { reason: 'dispatch_expired' },
      })
      await followTask(tx, { ...attempt, state: to }, to)
      return
    }
  }

  await transition(tx, {
    table: 'attempts',
    machine: attemptMachine,
    id: attempt.id,
    from: attempt.state,
    event: 'lease_expired',
    ...ctx,
    payload: { runnerId: attempt.runnerId, generation: attempt.generation },
  })
  const blocker: Blocker = {
    kind: 'infrastructure',
    detail:
      'Runner stopped reporting; waiting for it to reconnect or for an operator to confirm the process stopped',
    refs: [attempt.id],
  }
  await tx`update tasks set blocker = ${tx.json(blocker as never)}, updated_at = now() where id = ${attempt.taskId}`
}
