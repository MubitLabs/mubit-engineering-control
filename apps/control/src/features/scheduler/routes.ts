import { ACTIVE_ATTEMPT_STATES, attemptMachine, PARKED_ATTEMPT_STATES } from '@mec/domain'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../../config'
import type { Sql, Tx } from '../../db/sql'
import { appendEvent, FLEET_STREAM, projectStream } from '../../events/append'
import { authorize, requireActor } from '../../http/actor'
import { conflict, forbidden, parse } from '../../http/errors'
import { enqueueCommand, withdrawCommands } from '../../outbox/commands'
import { type AttemptRow, commandAttempt, followTask, loadAttempt } from '../attempts/service'
import { audit } from '../audit'
import { loadProject } from '../projects/routes'
import type { RunnerRegistry } from '../runners/registry'
import { transition } from '../state'
import { assertCapacity, currentLoad, dispatchLock, dispatchPaused } from './capacity'

const LIVE_STATES = ['leased', 'preparing', 'running', 'awaiting_input', 'work_complete', 'checking']

export function registerSchedulerRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; registry: RunnerRegistry; config: Config },
) {
  const { sql, registry, config } = deps

  /** A paused project gets no new dispatch; running work continues (PDF §13). */
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/pause', async (req) => {
    const actor = await requireActor(sql, req)
    const project = await loadProject(sql, req.params.projectId)
    authorize(actor, 'manage_project', { kind: 'project', projectId: project.id })
    const body = parse(z.object({ paused: z.boolean() }), req.body)
    await sql.begin(async (tx) => {
      await tx`
        update projects set paused_at = ${body.paused ? new Date() : null}, paused_by = ${body.paused ? actor.userId : null}
        where id = ${project.id}
      `
      await appendEvent(tx, {
        stream: projectStream(project.id),
        type: body.paused ? 'project.paused' : 'project.resumed',
        projectId: project.id,
        actor: { kind: 'user', id: actor.userId },
      })
      await audit(
        tx,
        actor.userId,
        body.paused ? 'project.pause' : 'project.resume',
        'project',
        project.id,
        project.id,
      )
    })
    return { paused: body.paused }
  })

  app.get('/api/fleet/status', async (req) => {
    const actor = await requireActor(sql, req)
    if (!actor.isAdmin) throw forbidden('Fleet status is admin-only')
    const [latest] = await sql<{ id: string }[]>`select id from fleet_stops order by created_at desc limit 1`
    return {
      dispatchPaused: await dispatchPaused(sql),
      limits: config.scheduling.limits,
      load: await currentLoad(sql),
      latestStop: latest ? await stopStatus(sql, registry, latest.id) : null,
    }
  })

  /**
   * Fleet stop (PDF §13): pause dispatch, ask every current attempt to stop, and track which
   * runners acknowledged. A disconnected runner is reported as unreachable, not as stopped.
   */
  app.post('/api/fleet/stop', async (req) => {
    const actor = await requireActor(sql, req)
    if (!actor.isAdmin) throw forbidden('Only admins can stop the fleet')
    const body = parse(z.object({ reason: z.string().max(500).default('') }), req.body ?? {})
    const stopId = await sql.begin(async (tx) => {
      await setDispatchPaused(tx, true, actor.userId)
      const live = await tx<AttemptRow[]>`
        select * from attempts where state = any(${tx.array(LIVE_STATES)}) for update
      `
      const entries = []
      for (const a of live) {
        const commandId = await commandAttempt(
          tx,
          a,
          'interrupt',
          { reason: 'fleet stop' },
          { kind: 'user', id: actor.userId },
        )
        entries.push({ attemptId: a.id, runnerId: a.runnerId, commandId })
      }
      const [stop] = await tx<{ id: string }[]>`
        insert into fleet_stops (requested_by, reason, attempts)
        values (${actor.userId}, ${body.reason}, ${tx.json(entries as never)})
        returning id
      `
      await appendEvent(tx, {
        stream: FLEET_STREAM,
        type: 'fleet.stop_requested',
        actor: { kind: 'user', id: actor.userId },
        payload: { stopId: stop!.id, attempts: entries.length, reason: body.reason },
      })
      await audit(tx, actor.userId, 'fleet.stop', 'fleet', stop!.id, null, { attempts: entries.length })
      return stop!.id
    })
    return stopStatus(sql, registry, stopId)
  })

  app.post('/api/fleet/resume', async (req) => {
    const actor = await requireActor(sql, req)
    if (!actor.isAdmin) throw forbidden('Only admins can resume dispatch')
    await sql.begin(async (tx) => {
      await setDispatchPaused(tx, false, actor.userId)
      await appendEvent(tx, {
        stream: FLEET_STREAM,
        type: 'fleet.dispatch_resumed',
        actor: { kind: 'user', id: actor.userId },
      })
      await audit(tx, actor.userId, 'fleet.resume', 'fleet', null, null)
    })
    return { dispatchPaused: false }
  })

  /**
   * Resume a parked attempt on its own runner (its workspace lives there). The generation is
   * bumped, so anything the previous generation still sends is fenced.
   */
  app.post<{ Params: { attemptId: string } }>('/api/attempts/:attemptId/resume', async (req) => {
    const actor = await requireActor(sql, req)
    const attempt = await sql.begin(async (tx) => {
      await dispatchLock(tx)
      const a = await loadAttempt(tx, req.params.attemptId, true)
      const [task] = await tx<{ ownerId: string | null; projectId: string; priority: number }[]>`
        select t.owner_id, d.project_id, d.priority from tasks t join deliveries d on d.id = t.delivery_id where t.id = ${a.taskId}
      `
      authorize(actor, 'prompt', {
        kind: 'attempt',
        projectId: a.projectId,
        taskOwnerId: task!.ownerId,
        collaboratorIds: [],
      })
      if (!PARKED_ATTEMPT_STATES.includes(a.state)) {
        throw conflict(
          'not_parked',
          `Attempt is ${a.state}; only interrupted, quota or auth waits can resume`,
        )
      }
      if (!a.runnerId) throw conflict('no_runner', 'Attempt has no runner')
      await assertCapacity(
        tx,
        {
          taskId: a.taskId,
          deliveryId: a.deliveryId,
          projectId: a.projectId,
          priority: task!.priority,
          createdAt: 0,
          agentKind: a.agentKind,
          profileId: null,
          runnerId: a.runnerId,
        },
        a.runnerId,
        registry.connectedIds().includes(a.runnerId)
          ? registry.connectedIds()
          : [...registry.connectedIds(), a.runnerId],
        config.scheduling.limits,
      )
      const generation = a.generation + 1
      await transition(tx, {
        table: 'attempts',
        machine: attemptMachine,
        id: a.id,
        from: a.state,
        event: 'resume',
        set: {
          generation,
          leaseExpiresAt: new Date(Date.now() + config.scheduling.leaseTtlMs),
          blocker: null,
        },
        projectId: a.projectId,
        deliveryId: a.deliveryId,
        taskId: a.taskId,
        attemptId: a.id,
        actor: { kind: 'user', id: actor.userId },
        payload: { generation },
      })
      await tx`update tasks set blocker = null, updated_at = now() where id = ${a.taskId}`
      await enqueueCommand(tx, a.runnerId, {
        commandId: `${a.id}:g${generation}:resume`,
        type: 'resume',
        attemptId: a.id,
        generation,
        payload: { nativeSessionRef: a.nativeSessionRef },
      })
      return loadAttempt(tx, a.id)
    })
    return { attempt }
  })

  /**
   * An operator confirms a stalled attempt's process is gone (e.g. the machine was rebuilt).
   * Only then may the work be resumed or replaced.
   */
  app.post<{ Params: { attemptId: string } }>('/api/attempts/:attemptId/confirm-stopped', async (req) => {
    const actor = await requireActor(sql, req)
    const attempt = await sql.begin(async (tx) => {
      const a = await loadAttempt(tx, req.params.attemptId, true)
      const [runner] = await tx<{ ownerId: string }[]>`select owner_id from runners where id = ${a.runnerId}`
      if (!actor.isAdmin && runner?.ownerId !== actor.userId) {
        throw forbidden('Only an admin or the runner owner can confirm a stop')
      }
      if (a.state !== 'stalled') throw conflict('not_stalled', `Attempt is ${a.state}, not stalled`)
      await withdrawCommands(tx, a.id, 'operator confirmed the process stopped')
      const to = await transition(tx, {
        table: 'attempts',
        machine: attemptMachine,
        id: a.id,
        from: 'stalled',
        event: 'runner_reconciled_stopped',
        set: { leaseExpiresAt: null },
        projectId: a.projectId,
        deliveryId: a.deliveryId,
        taskId: a.taskId,
        attemptId: a.id,
        actor: { kind: 'user', id: actor.userId },
        payload: { reason: 'operator confirmed stopped' },
      })
      await followTask(tx, { ...a, state: to }, to)
      await audit(tx, actor.userId, 'attempt.confirm_stopped', 'attempt', a.id, a.projectId)
      return loadAttempt(tx, a.id)
    })
    return { attempt }
  })

  /** Abandon a parked attempt so the task can start fresh (on any runner). */
  app.post<{ Params: { attemptId: string } }>('/api/attempts/:attemptId/abandon', async (req) => {
    const actor = await requireActor(sql, req)
    const attempt = await sql.begin(async (tx) => {
      const a = await loadAttempt(tx, req.params.attemptId, true)
      const [task] = await tx<{ ownerId: string | null }[]>`select owner_id from tasks where id = ${a.taskId}`
      authorize(actor, 'prompt', {
        kind: 'attempt',
        projectId: a.projectId,
        taskOwnerId: task!.ownerId,
        collaboratorIds: [],
      })
      if (!PARKED_ATTEMPT_STATES.includes(a.state)) throw conflict('not_parked', `Attempt is ${a.state}`)
      await withdrawCommands(tx, a.id, 'abandoned')
      if (a.runnerId)
        await commandAttempt(tx, a, 'cancel', { reason: 'abandoned' }, { kind: 'user', id: actor.userId })
      const to = await transition(tx, {
        table: 'attempts',
        machine: attemptMachine,
        id: a.id,
        from: a.state,
        event: 'cancel',
        set: { finishedAt: new Date() },
        projectId: a.projectId,
        deliveryId: a.deliveryId,
        taskId: a.taskId,
        attemptId: a.id,
        actor: { kind: 'user', id: actor.userId },
        payload: { reason: 'abandoned; branch and workspace are preserved on the runner' },
      })
      await followTask(tx, { ...a, state: to }, to)
      return loadAttempt(tx, a.id)
    })
    return { attempt }
  })
}

async function setDispatchPaused(tx: Tx, paused: boolean, userId: string): Promise<void> {
  await tx`
    insert into settings (key, value, updated_by) values ('dispatch', ${tx.json({ dispatchPaused: paused } as never)}, ${userId})
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
  `
}

async function stopStatus(sql: Sql, registry: RunnerRegistry, stopId: string) {
  const [stop] = await sql<
    {
      id: string
      createdAt: Date
      reason: string
      attempts: { attemptId: string; runnerId: string; commandId: string }[]
    }[]
  >`select id, created_at, reason, attempts from fleet_stops where id = ${stopId}`
  const ids = stop!.attempts.map((a) => a.attemptId)
  const states = ids.length
    ? await sql<
        { id: string; state: string }[]
      >`select id, state from attempts where id = any(${sql.array(ids)}::uuid[])`
    : []
  const acks = ids.length
    ? await sql<{ key: string; deliveredAt: Date | null }[]>`
        select idempotency_key as key, delivered_at from outbox
        where idempotency_key = any(${sql.array(stop!.attempts.map((a) => a.commandId))})
      `
    : []
  const attempts = stop!.attempts.map((e) => {
    const state = states.find((s) => s.id === e.attemptId)?.state ?? 'unknown'
    const acknowledged = acks.find((a) => a.key === e.commandId)?.deliveredAt != null
    const stopped = !ACTIVE_ATTEMPT_STATES.includes(state as never) || state === 'stalled'
    return {
      ...e,
      state,
      acknowledged,
      stopped: stopped && state !== 'stalled',
      runnerReachable: registry.get(e.runnerId) !== undefined,
    }
  })
  return {
    id: stop!.id,
    createdAt: stop!.createdAt,
    reason: stop!.reason,
    attempts,
    summary: {
      total: attempts.length,
      stopped: attempts.filter((a) => a.stopped).length,
      unreachable: attempts.filter((a) => !a.stopped && !a.runnerReachable).length,
    },
  }
}
