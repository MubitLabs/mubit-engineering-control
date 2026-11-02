import type { AgentProbe, AttemptReport, RunnerEventEnvelope, RunnerHello } from '@mec/contracts'
import { ACTIVE_ATTEMPT_STATES, attemptMachine, checkSequence, fence, LEASE_DEFAULTS } from '@mec/domain'
import type { Db, Sql, Tx } from '../../db/sql'
import { appendEvent, FLEET_STREAM, projectStream } from '../../events/append'
import { enqueueCommand } from '../../outbox/commands'
import { type AttemptRow, applyLifecycle, followTask, isLifecycleEvent } from '../attempts/service'
import { handleControlCall } from '../decisions/calls'
import { openDecision } from '../decisions/service'
import { onIntegrationCompleted, onIntegrationConflict } from '../integration/outcomes'
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
    await projectEvidence(tx, attempt, env)
    if (isLifecycleEvent(env.type)) await applyLifecycle(tx, { ...attempt, lastSequence: env.sequence }, env)
    return { kind: 'stored', gap: seq.kind === 'gap' ? seq.missing : 0 }
  })
}

/** Renews the lease of every attempt the runner reports alive for the current generation. */
export async function renewLeases(
  sql: Sql,
  runnerId: string,
  attempts: AttemptReport[],
  ttlMs: number = LEASE_DEFAULTS.ttlMs,
  agents?: AgentProbe[],
): Promise<void> {
  await sql`update runners set last_seen_at = now() where id = ${runnerId}`
  if (agents) await recordAgentHealth(sql, runnerId, agents)
  const live = attempts.filter((a) => a.process === 'live')
  for (const a of live) {
    await sql`
      update attempts set lease_expires_at = now() + make_interval(secs => ${ttlMs / 1000})
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
    await recordAgentHealth(tx, runnerId, hello.agents)
    await appendEvent(tx, {
      stream: FLEET_STREAM,
      type: 'runner.connected',
      actor: { kind: 'runner', id: runnerId },
      payload: { runnerId, hostname: hello.hostname, attempts: hello.attempts.length },
    })

    const acked: Record<string, number> = {}
    const reported = new Map(hello.attempts.map((a) => [a.attemptId, a]))
    const ids = hello.attempts.map((a) => a.attemptId).filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    const known = new Set<string>()
    if (ids.length > 0) {
      const rows = await tx<{ id: string; lastSequence: number; runnerId: string }[]>`
        select id, last_sequence, runner_id from attempts where id = any(${tx.array(ids)}::uuid[])
      `
      for (const r of rows) {
        known.add(r.id)
        if (r.runnerId === runnerId) acked[r.id] = r.lastSequence
      }
    }
    // Attempts this database has no record of (e.g. after restoring an older backup) are stopped on
    // the runner, their workspace preserved, before anything could start the same work again.
    for (const report of hello.attempts) {
      if (known.has(report.attemptId) || report.process !== 'live') continue
      await enqueueCommand(tx, runnerId, {
        commandId: `${report.attemptId}:g${report.generation}:cancel:unknown`,
        type: 'cancel',
        attemptId: report.attemptId,
        generation: report.generation,
        payload: { reason: 'control has no record of this attempt (restored from a backup?)' },
      })
      await appendEvent(tx, {
        stream: FLEET_STREAM,
        type: 'runner.unknown_attempt',
        actor: { kind: 'system' },
        payload: { runnerId, attemptId: report.attemptId, taskId: report.taskId ?? null, action: 'stopped' },
      })
    }

    const active = await tx<AttemptRow[]>`
      select * from attempts
      where runner_id = ${runnerId} and state = any(${tx.array([...ACTIVE_ATTEMPT_STATES])})
      for update
    `
    for (const attempt of active) {
      const report = reported.get(attempt.id)
      // The lease holder is back: un-stall it. Whatever happened meanwhile (finished, interrupted)
      // arrives next as replayed events from its journal and applies in order.
      if (report && report.generation === attempt.generation) {
        if (attempt.state === 'stalled') await reconcileStalled(tx, attempt, 'runner_reconciled_running')
        continue
      }
      // The runner holds an older generation; the queued resume command will bring it forward.
      if (report && report.generation < attempt.generation) continue
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
  await tx`update tasks set blocker = null, updated_at = now() where id = ${attempt.taskId}`
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

/**
 * A runner refused a start or resume (capacity, unknown attempt, stale generation). The attempt
 * cannot be running there, so it fails and the task follows the normal retry rules.
 */
export async function failRejectedCommand(
  sql: Sql,
  runnerId: string,
  commandId: string,
  reason: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<
      { payload: { type: string; attemptId: string | null; generation: number | null } }[]
    >`
      select payload from outbox where idempotency_key = ${commandId} and target = ${runnerId}
    `
    const cmd = row?.payload
    if (cmd?.type === 'message') {
      const messageId = (cmd as unknown as { payload: { messageId?: string } }).payload.messageId
      if (messageId) await tx`update attempt_messages set status = 'rejected' where id = ${messageId}::uuid`
      return
    }
    if (!cmd?.attemptId || (cmd.type !== 'start' && cmd.type !== 'resume')) return
    const [attempt] = await tx<AttemptRow[]>`select * from attempts where id = ${cmd.attemptId} for update`
    if (attempt?.state !== 'leased' || attempt.generation !== cmd.generation) return
    const to = await transition(tx, {
      table: 'attempts',
      machine: attemptMachine,
      id: attempt.id,
      from: 'leased',
      event: 'error',
      set: { leaseExpiresAt: null, finishedAt: new Date() },
      projectId: attempt.projectId,
      deliveryId: attempt.deliveryId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      actor: { kind: 'runner', id: runnerId },
      payload: { reason: `runner rejected ${cmd.type}: ${reason}` },
    })
    await followTask(tx, { ...attempt, state: to }, to)
  })
}

/** Keeps queryable read models in step with evidence events (current generation only). */
async function projectEvidence(tx: Tx, attempt: AttemptRow, env: RunnerEventEnvelope): Promise<void> {
  const p = env.payload
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  switch (env.type) {
    case 'attempt.input_requested':
      await openDecision(tx, attempt, env)
      return
    case 'control.call':
      await handleControlCall(tx, attempt, env)
      return
    case 'integration.completed':
      await onIntegrationCompleted(tx, attempt, env)
      return
    case 'integration.conflict':
      await onIntegrationConflict(tx, attempt, env)
      return
    case 'message.delivered':
      if (str(p.messageId)) {
        await tx`
          update attempt_messages set status = 'delivered', delivered_at = now()
          where id = ${str(p.messageId)}::uuid and attempt_id = ${attempt.id} and status = 'queued'
        `
      }
      return
    case 'workspace.ready': {
      await tx`
        update attempts set branch = coalesce(${str(p.branch)}, branch), base_sha = coalesce(${str(p.baseSha)}, base_sha)
        where id = ${attempt.id}
      `
      // The first resolved base pins the delivery (PDF §8: pinned base).
      if (str(p.baseSha) && attempt.kind !== 'integration') {
        await tx`update deliveries set base_sha = ${str(p.baseSha)} where id = ${attempt.deliveryId} and base_sha is null`
      }
      return
    }
    case 'workspace.diff':
      await tx`
        update attempts set head_sha = coalesce(${str(p.headSha)}, head_sha), diff = ${tx.json(p as never)}
        where id = ${attempt.id}
      `
      return
    case 'check.result': {
      const artifactId = str(p.logArtifactId)
      const [artifact] = artifactId
        ? await tx`select id from artifacts where id = ${artifactId}::uuid and attempt_id = ${attempt.id}`
        : []
      await tx`
        insert into check_results (
          project_id, attempt_id, task_id, delivery_id, scope, name, status, exit_code, duration_ms,
          tested_sha, log_artifact_id, log_tail, source_event_id
        ) values (
          ${attempt.projectId}, ${attempt.id}, ${attempt.taskId}, ${attempt.deliveryId},
          ${p.scope === 'integration' ? 'integration' : 'task'}, ${String(p.name ?? 'check')},
          ${['passed', 'failed', 'error'].includes(String(p.status)) ? String(p.status) : 'error'},
          ${typeof p.exitCode === 'number' ? p.exitCode : null}, ${Math.round(Number(p.durationMs) || 0)},
          ${str(p.sha)}, ${artifact ? artifactId : null}, ${str(p.logTail)?.slice(-8000) ?? null}, ${env.eventId}
        )
        on conflict (attempt_id, source_event_id) do nothing
      `
      return
    }
  }
}

/** Native auth health and capabilities flow from the runner's probes to the profiles it hosts. */
export async function recordAgentHealth(db: Db, runnerId: string, agents: AgentProbe[]): Promise<void> {
  await db`update runners set agents = ${db.json(agents as never)} where id = ${runnerId}`
  for (const a of agents) {
    await db`
      update execution_profiles
      set auth_state = ${a.available ? a.auth : 'unknown'}, agent_version = ${a.version},
          capability_set = ${db.json(a.capabilities as never)}, updated_at = now()
      where runner_id = ${runnerId} and agent_kind = ${a.kind}
    `
  }
}
