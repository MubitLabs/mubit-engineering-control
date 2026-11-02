import type { RunnerCommand } from '@mec/contracts'
import type { Sql, Tx } from '../db/sql'

export const OUTBOX_CHANNEL = 'mec_outbox'

/**
 * Queues a command for a runner in the caller's transaction. The commandId is the idempotency
 * key: queueing the same command twice is a no-op, and the runner executes it at most once.
 */
export async function enqueueCommand(tx: Tx, runnerId: string, command: RunnerCommand): Promise<void> {
  await tx`
    insert into outbox (topic, target, payload, idempotency_key)
    values ('runner.command', ${runnerId}, ${tx.json(command as never)}, ${command.commandId})
    on conflict (idempotency_key) do nothing
  `
  await tx`select pg_notify(${OUTBOX_CHANNEL}, ${runnerId})`
}

export interface PendingCommand {
  id: number
  target: string
  payload: RunnerCommand
}

const RESEND_AFTER_SECONDS = 10

/** Commands not yet acknowledged; unacknowledged sends are retried after a pause. */
export async function pendingCommands(sql: Sql, runnerId: string, limit = 100): Promise<PendingCommand[]> {
  return sql<PendingCommand[]>`
    update outbox set sent_at = now(), attempts = attempts + 1
    where id in (
      select id from outbox
      where topic = 'runner.command' and target = ${runnerId} and delivered_at is null
        and (sent_at is null or sent_at < now() - make_interval(secs => ${RESEND_AFTER_SECONDS}))
      order by id
      limit ${limit}
      for update skip locked
    )
    returning id, target, payload
  `
}

export async function markCommandResult(
  sql: Sql,
  runnerId: string,
  commandId: string,
  status: 'accepted' | 'duplicate' | 'rejected',
  reason?: string,
): Promise<void> {
  await sql`
    update outbox set delivered_at = now(), last_error = ${status === 'rejected' ? (reason ?? 'rejected') : null}
    where idempotency_key = ${commandId} and target = ${runnerId} and delivered_at is null
  `
}
