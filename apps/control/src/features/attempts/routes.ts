import { AgentKind, FakeStep } from '@mec/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../../config'
import type { Sql } from '../../db/sql'
import { authorize, type RequestActor, requireActor } from '../../http/actor'
import { conflict, notFound, parse } from '../../http/errors'
import type { RunnerRegistry } from '../runners/registry'
import { claimAttempt, commandAttempt, loadAttempt, type TaskRow } from './service'

const StartAttempt = z.object({
  runnerId: z.uuid().optional(),
  agentKind: AgentKind.default('fake'),
  script: z.array(FakeStep).max(500).optional(),
})

export function registerAttemptRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; registry: RunnerRegistry; config: Config },
) {
  const { sql, registry, config } = deps

  const loadTask = async (taskId: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw notFound('Task')
    const [task] = await sql<
      (TaskRow & { projectId: string; deliveryTitle: string; deliveryOwnerId: string })[]
    >`
      select t.*, d.project_id, d.title as delivery_title, d.owner_id as delivery_owner_id
      from tasks t join deliveries d on d.id = t.delivery_id where t.id = ${taskId}
    `
    if (!task) throw notFound('Task')
    return task
  }
  const attemptResource = (task: { projectId: string; ownerId: string | null }) => ({
    kind: 'attempt' as const,
    projectId: task.projectId,
    taskOwnerId: task.ownerId,
    collaboratorIds: [],
  })

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (req) => {
    const actor = await requireActor(sql, req)
    const task = await loadTask(req.params.taskId)
    authorize(actor, 'observe', { kind: 'project', projectId: task.projectId })
    const [attempts, dependencies, approvals] = await Promise.all([
      sql`
        select a.*, r.name as runner_name from attempts a left join runners r on r.id = a.runner_id
        where a.task_id = ${task.id} order by a.number desc
      `,
      sql`
        select t.id, t.key, t.title, t.state from task_dependencies d join tasks t on t.id = d.depends_on_task_id
        where d.task_id = ${task.id}
      `,
      sql`select * from approvals where task_id = ${task.id} order by created_at desc`,
    ])
    return {
      task,
      attempts,
      dependencies,
      approvals,
      canPrompt: canPrompt(actor, task),
    }
  })

  /** Manual start or retry (PDF §24: POST /tasks/:id/attempts). The scheduler uses the same claim. */
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/attempts', async (req, reply) => {
    const actor = await requireActor(sql, req)
    const body = parse(StartAttempt, req.body ?? {})
    const task = await loadTask(req.params.taskId)
    authorize(actor, 'prompt', attemptResource(task))
    const runnerId = body.runnerId ?? (await pickRunner(sql, registry))
    if (!runnerId) throw conflict('no_runner', 'No online, non-draining runner is available')
    const [runner] = await sql<{ draining: boolean; revokedAt: Date | null }[]>`
      select draining, revoked_at from runners where id = ${runnerId}
    `
    if (!runner || runner.revokedAt) throw notFound('Runner')
    if (runner.draining) throw conflict('runner_draining', 'That runner is draining and takes no new work')
    const result = await sql.begin((tx) =>
      claimAttempt(tx, {
        taskId: task.id,
        runnerId,
        agentKind: body.agentKind,
        inputs: body.script ? { script: body.script } : {},
        actor: { kind: 'user', id: actor.userId },
        leaseMs: config.scheduling.leaseTtlMs,
        capacity: { limits: config.scheduling.limits, connectedIds: registry.connectedIds() },
      }),
    )
    return reply.status(result.created ? 201 : 200).send(result)
  })

  app.get<{ Params: { attemptId: string } }>('/api/attempts/:attemptId', async (req) => {
    const actor = await requireActor(sql, req)
    const attempt = await loadAttempt(sql, req.params.attemptId)
    authorize(actor, 'observe', { kind: 'project', projectId: attempt.projectId })
    const [checks, artifacts] = await Promise.all([
      sql`select * from check_results where attempt_id = ${attempt.id} order by created_at`,
      sql`select id, kind, name, size_bytes, created_at from artifacts where attempt_id = ${attempt.id} order by created_at`,
    ])
    return { attempt, checks, artifacts }
  })

  app.get<{ Params: { attemptId: string } }>('/api/attempts/:attemptId/events', async (req) => {
    const actor = await requireActor(sql, req)
    const attempt = await loadAttempt(sql, req.params.attemptId)
    authorize(actor, 'observe', { kind: 'project', projectId: attempt.projectId })
    const q = parse(
      z.object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(2000).default(1000),
      }),
      req.query,
    )
    const events = await sql`
      select id, seq, type, actor_kind, actor_id, payload, occurred_at, recorded_at, source_sequence, source_generation
      from events where attempt_id = ${attempt.id} and id > ${q.after}
      order by id limit ${q.limit}
    `
    return { events }
  })

  for (const type of ['interrupt', 'cancel'] as const) {
    app.post<{ Params: { attemptId: string } }>(`/api/attempts/:attemptId/${type}`, async (req) => {
      const actor = await requireActor(sql, req)
      const attempt = await loadAttempt(sql, req.params.attemptId)
      const task = await loadTask(attempt.taskId)
      authorize(actor, 'prompt', attemptResource(task))
      const commandId = await sql.begin((tx) =>
        commandAttempt(tx, attempt, type, {}, { kind: 'user', id: actor.userId }),
      )
      return { commandId }
    })
  }
}

function canPrompt(actor: RequestActor, task: { projectId: string; ownerId: string | null }): boolean {
  const role = actor.projectRoles[task.projectId]
  return (role === 'owner' || role === 'member') && task.ownerId === actor.userId
}

/** Any connected, non-draining runner with the fewest active attempts. The scheduler replaces this. */
async function pickRunner(sql: Sql, registry: RunnerRegistry): Promise<string | null> {
  const connected = registry.connectedIds()
  if (connected.length === 0) return null
  const [row] = await sql<{ id: string }[]>`
    select r.id from runners r
    where r.id = any(${sql.array(connected)}::uuid[]) and not r.draining and r.revoked_at is null
    order by (select count(*) from attempts a where a.runner_id = r.id
              and a.state in ('leased','preparing','running','awaiting_input','work_complete','checking','stalled')), r.name
    limit 1
  `
  return row?.id ?? null
}
