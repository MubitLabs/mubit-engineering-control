import type { AttemptReport, RunnerEventEnvelope, RunnerHello } from '@mec/contracts'
import { ACTIVE_ATTEMPT_STATES, attemptMachine, checkSequence, fence, LEASE_DEFAULTS } from '@mec/domain'
import type { Sql, Tx } from '../../db/sql'
import { appendEvent, FLEET_STREAM, projectStream } from '../../events/append'
import { type AttemptRow, applyLifecycle, followTask, isLifecycleEvent } from '../attempts/service'
import { transition } from '../state'

export type IngestOutcome =
  | { kind: 'stored'; gap: number }
  | { kind: 'duplicate' }
  | { kind: 'stale' }
  | { kind: 'rejected'; reason: string }

/**
 * Persists one runner event (PDF §25). Duplicates (same runner + eventId) are acknowledged without
 * a second row; a sequence that goes backwards is a protocol violation; events from a fenced
 * generation are kept as evidence but never change state. The caller acknowledges only after this
 * transaction commits.
 */
export async function ingestRunnerEvent(
  sql: Sql,
  runnerId: string,
  env: RunnerEventEnvelope,
): Promise<IngestOutcome> {
  if (env.runnerId !== runnerId) return { kind: 'rejected', reason: 'runner id mismatch' }
  if (!/^[0-9a-f-]{36}$/i.test(env.attemptId)) return { kind: 'rejected', reason: 'unknown attempt' }

  return sql.begin(async (tx): Promise<IngestOutcome> => {
    const [attempt] = await tx<AttemptRow[]>`select * from attempts where id = ${env.attemptId} for update`
    if (!attempt || attempt.runnerId !== runnerId)
      return { kind: 'rejected', reason: 'attempt not assigned to this runner' }

    const [dup] = await tx`
      select 1 from events where source_runner_id = ${runnerId} and source_event_id = ${env.eventId}
    `
    if (dup) return { kind: 'duplicate' }

    const seq = checkSequence(attempt.lastSequence < 0 ? null : attempt.lastSequence, env.sequence)
    if (seq.kind === 'out_of_order') {
      await appendEvent(tx, {
        stream: projectStream(attempt.projectId),
        type: 'runner.protocol_violation',
        projectId: attempt.projectId,
        attemptId: attempt.id,
        actor: { kind: 'system' },
        payload: {
          runnerId,
          eventId: env.eventId,
          sequence: env.sequence,
          lastSequence: attempt.lastSequence,
        },
      })
      return { kind: 'rejected', reason: 'sequence went backwards' }
    }

    const lease = {
      attemptId: attempt.id,
      runnerId: attempt.runnerId,
      generation: attempt.generation,
      expiresAt: attempt.leaseExpiresAt ?? new Date(0),
    }
    const fenced = fence(lease, { runnerId, generation: env.generation }, new Date(), 'telemetry')
    const stale = !fenced.ok

    await appendEvent(tx, {
      stream: projectStream(attempt.projectId),
      type: env.type,
      projectId: attempt.projectId,
      deliveryId: attempt.deliveryId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      actor: { kind: 'runner', id: runnerId },
      payload: stale ? { ...env.payload, fenced: fenced.error } : env.payload,
      source: { runnerId, eventId: env.eventId, sequence: env.sequence, generation: env.generation },
      occurredAt: new Date(env.occurredAt),
    })
    if (seq.kind === 'gap') {
      await appendEvent(tx, {
        stream: projectStream(attempt.projectId),
        type: 'runner.sequence_gap',
        projectId: attempt.projectId,
        attemptId: attempt.id,
        actor: { kind: 'system' },
        payload: { runnerId, missing: seq.missing, before: env.sequence },
      })
    }
    await tx`update attempts set last_sequence = ${env.sequence} where id = ${attempt.id}`

    if (stale) return { kind: 'stale' }
    if (isLifecycleEvent(env.type)) await applyLifecycle(tx, { ...attempt, lastSequence: env.sequence }, env)
    return { kind: 'stored', gap: seq.kind === 'gap' ? seq.missing : 0 }
  })
}

/** Renews the lease of every attempt the runner reports alive for the current generation. */
export async function renewLeases(sql: Sql, runnerId: string, attempts: AttemptReport[]): Promise<void> {
  await sql`update runners set last_seen_at = now() where id = ${runnerId}`
  const live = attempts.filter((a) => a.process === 'live')
  for (const a of live) {
    await sql`
      update attempts set lease_expires_at = now() + make_interval(secs => ${LEASE_DEFAULTS.ttlMs / 1000})
      where id = ${a.attemptId} and runner_id = ${runnerId} and generation = ${a.generation}
        and state = any(${sql.array(['leased', 'preparing', 'running', 'awaiting_input', 'work_complete', 'checking'])})
    `
  }
}

/**
 * Reconciles a (re)connecting runner (PDF §26). Returns the highest persisted sequence per
 * reported attempt so the runner can replay the rest. A stalled attempt the runner still runs
 * resumes its lease; an active attempt the runner has no record of is marked interrupted.
 */
export async function reconcileHello(
  sql: Sql,
  runnerId: string,
  hello: RunnerHello,
): Promise<Record<string, number>> {
  return sql.begin(async (tx) => {
    await tx`
      update runners set
        status = 'online', connected_at = now(), last_seen_at = now(), hostname = ${hello.hostname},
        os = ${hello.os}, arch = ${hello.arch}, runner_version = ${hello.runnerVersion},
        capacity = ${tx.json(hello.capacity as never)}, agents = ${tx.json(hello.agents as never)}
      where id = ${runnerId}
    `
    await appendEvent(tx, {
      stream: FLEET_STREAM,
      type: 'runner.connected',
      actor: { kind: 'runner', id: runnerId },
      payload: { runnerId, hostname: hello.hostname, attempts: hello.attempts.length },
    })

    const acked: Record<string, number> = {}
    const reported = new Map(hello.attempts.map((a) => [a.attemptId, a]))
    const ids = hello.attempts.map((a) => a.attemptId).filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    if (ids.length > 0) {
      const rows = await tx<{ id: string; lastSequence: number; runnerId: string }[]>`
        select id, last_sequence, runner_id from attempts where id = any(${tx.array(ids)}::uuid[])
      `
      for (const r of rows) if (r.runnerId === runnerId) acked[r.id] = r.lastSequence
    }

    const active = await tx<AttemptRow[]>`
      select * from attempts
      where runner_id = ${runnerId} and state = any(${tx.array([...ACTIVE_ATTEMPT_STATES])})
      for update
    `
    for (const attempt of active) {
      const report = reported.get(attempt.id)
      if (report && report.process === 'live' && report.generation === attempt.generation) {
        if (attempt.state === 'stalled') await reconcileStalled(tx, attempt, 'runner_reconciled_running')
        continue
      }
      // A leased attempt whose start command is still queued is not yet known to the runner.
      if (!report && attempt.state === 'leased') continue
      if (!report || report.process === 'stopped') {
        // The runner will report its own interruption for attempts it knows; this covers the
        // ones it has no record of at all.
        if (!report) await markLost(tx, attempt)
      }
    }
    return acked
  })
}

async function reconcileStalled(tx: Tx, attempt: AttemptRow, event: 'runner_reconciled_running') {
  await transition(tx, {
    table: 'attempts',
    machine: attemptMachine,
    id: attempt.id,
    from: 'stalled',
    event,
    set: { leaseExpiresAt: new Date(Date.now() + LEASE_DEFAULTS.ttlMs) },
    projectId: attempt.projectId,
    deliveryId: attempt.deliveryId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    actor: { kind: 'system' },
  })
}

async function markLost(tx: Tx, attempt: AttemptRow) {
  const event = attempt.state === 'stalled' ? 'runner_reconciled_stopped' : 'interrupt_confirmed'
  const check = attemptMachine.transition(attempt.state, event)
  if (!check.ok) return
  const to = await transition(tx, {
    table: 'attempts',
    machine: attemptMachine,
    id: attempt.id,
    from: attempt.state,
    event,
    set: { leaseExpiresAt: null },
    projectId: attempt.projectId,
    deliveryId: attempt.deliveryId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    actor: { kind: 'system' },
    payload: { reason: 'runner reconnected without a record of this attempt' },
  })
  await followTask(tx, { ...attempt, state: to }, to)
}

export async function markRunnerOffline(sql: Sql, runnerId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`update runners set status = 'offline', last_seen_at = now() where id = ${runnerId}`
    await appendEvent(tx, {
      stream: FLEET_STREAM,
      type: 'runner.disconnected',
      actor: { kind: 'system' },
      payload: { runnerId },
    })
  })
}
