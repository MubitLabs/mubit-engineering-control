import { CreateDelivery, ExpectedVersion, UpdatePlan } from '@mec/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Sql } from '../../db/sql'
import { appendEvent, projectStream } from '../../events/append'
import { authorize, requireActor } from '../../http/actor'
import { conflict, notFound, parse } from '../../http/errors'
import { type ApprovalHookMap, resolveApproval } from '../approvals/service'
import { audit } from '../audit'
import {
  type DeliveryRow,
  insertRevision,
  loadDelivery,
  loadRevision,
  openNewRevision,
  type PlanRevisionRow,
  submitRevision,
  updateRevision,
  validateRevision,
} from '../plans/service'
import { loadProject } from '../projects/routes'

export function registerDeliveries(app: FastifyInstance, deps: { sql: Sql; hooks: ApprovalHookMap }) {
  const { sql, hooks } = deps

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/deliveries', async (req) => {
    const actor = await requireActor(sql, req)
    const project = await loadProject(sql, req.params.projectId)
    authorize(actor, 'observe', { kind: 'project', projectId: project.id })
    const deliveries = await sql`
      select d.*, u.login as owner_login,
        (select count(*)::int from tasks t where t.delivery_id = d.id and t.state <> 'cancelled' and t.kind = 'work') as task_count,
        (select count(*)::int from approvals a where a.delivery_id = d.id and a.status = 'pending') as pending_approvals
      from deliveries d join users u on u.id = d.owner_id
      where d.project_id = ${project.id}
      order by d.created_at desc
    `
    return { deliveries }
  })

  /** Idempotent create: the same key returns the existing delivery (PDF §24). */
  app.post('/api/deliveries', async (req, reply) => {
    const actor = await requireActor(sql, req)
    const body = parse(CreateDelivery, req.body)
    const project = await loadProject(sql, body.projectId)
    authorize(actor, 'create_delivery', { kind: 'project', projectId: project.id })

    const result = await sql.begin(async (tx) => {
      const [existing] = await tx<DeliveryRow[]>`
        select * from deliveries where project_id = ${project.id} and idempotency_key = ${body.idempotencyKey}
      `
      if (existing) return { delivery: existing, created: false }
      const [repo] = await tx<{ id: string; defaultBranch: string }[]>`
        select id, default_branch from repositories where id = ${body.repositoryId} and project_id = ${project.id}
      `
      if (!repo) throw notFound('Repository')
      const [delivery] = await tx<DeliveryRow[]>`
        insert into deliveries (project_id, repository_id, title, owner_id, base_ref, idempotency_key, created_by)
        values (${project.id}, ${repo.id}, ${body.title}, ${actor.userId}, ${body.baseRef ?? repo.defaultBranch},
                ${body.idempotencyKey}, ${actor.userId})
        on conflict (project_id, idempotency_key) do nothing
        returning *
      `
      if (!delivery) {
        const [raced] = await tx<DeliveryRow[]>`
          select * from deliveries where project_id = ${project.id} and idempotency_key = ${body.idempotencyKey}
        `
        return { delivery: raced!, created: false }
      }
      await appendEvent(tx, {
        stream: projectStream(project.id),
        type: 'delivery.created',
        projectId: project.id,
        deliveryId: delivery.id,
        actor: { kind: 'user', id: actor.userId },
        payload: { title: delivery.title, baseRef: delivery.baseRef },
      })
      await insertRevision(tx, delivery, body, actor.userId, null)
      await audit(tx, actor.userId, 'delivery.create', 'delivery', delivery.id, project.id, {
        title: body.title,
      })
      return { delivery, created: true }
    })
    return reply.status(result.created ? 201 : 200).send(result)
  })

  app.get<{ Params: { deliveryId: string } }>('/api/deliveries/:deliveryId', async (req) => {
    const actor = await requireActor(sql, req)
    const delivery = await loadDelivery(sql, req.params.deliveryId)
    authorize(actor, 'observe', { kind: 'project', projectId: delivery.projectId })
    const [revisions, tasks, dependencies, approvals, [owner], [repository], pullRequests] =
      await Promise.all([
        sql<
          PlanRevisionRow[]
        >`select * from plan_revisions where delivery_id = ${delivery.id} order by number desc`,
        sql`select * from tasks where delivery_id = ${delivery.id} order by created_at, key`,
        sql`
        select d.task_id, d.depends_on_task_id from task_dependencies d
        join tasks t on t.id = d.task_id where t.delivery_id = ${delivery.id}
      `,
        sql`select * from approvals where delivery_id = ${delivery.id} order by created_at desc`,
        sql`select id, login, name, avatar_url from users where id = ${delivery.ownerId}`,
        sql`select id, name, clone_url, default_branch, validation_profile from repositories where id = ${delivery.repositoryId}`,
        sql`select * from pull_requests where delivery_id = ${delivery.id} order by created_at desc`,
      ])
    return { delivery, owner, repository, revisions, tasks, dependencies, approvals, pullRequests }
  })

  app.get<{ Params: { revisionId: string } }>('/api/plans/:revisionId', async (req) => {
    const actor = await requireActor(sql, req)
    const revision = await loadRevision(sql, req.params.revisionId)
    const delivery = await loadDelivery(sql, revision.deliveryId)
    authorize(actor, 'observe', { kind: 'project', projectId: delivery.projectId })
    return { revision }
  })

  app.post<{ Params: { deliveryId: string } }>('/api/deliveries/:deliveryId/plans', async (req, reply) => {
    const actor = await requireActor(sql, req)
    const body = parse(z.object({ fromRevisionId: z.uuid().optional() }), req.body ?? {})
    const revision = await sql.begin(async (tx) => {
      const delivery = await loadDelivery(tx, req.params.deliveryId, true)
      authorize(actor, 'edit_plan', {
        kind: 'delivery',
        projectId: delivery.projectId,
        ownerId: delivery.ownerId,
      })
      const [latest] = body.fromRevisionId
        ? [await loadRevision(tx, body.fromRevisionId)]
        : await tx<PlanRevisionRow[]>`
            select * from plan_revisions where delivery_id = ${delivery.id} order by number desc limit 1
          `
      if (!latest || latest.deliveryId !== delivery.id) throw notFound('Plan revision')
      return openNewRevision(tx, delivery, latest, actor)
    })
    return reply.status(201).send({ revision })
  })

  app.patch<{ Params: { revisionId: string } }>('/api/plans/:revisionId', async (req) => {
    const actor = await requireActor(sql, req)
    const body = parse(UpdatePlan, req.body)
    const revision = await sql.begin(async (tx) => {
      const rev = await loadRevision(tx, req.params.revisionId)
      const delivery = await loadDelivery(tx, rev.deliveryId)
      authorize(actor, 'edit_plan', {
        kind: 'delivery',
        projectId: delivery.projectId,
        ownerId: delivery.ownerId,
      })
      const { expectedVersion, ...patch } = body
      return updateRevision(tx, rev.id, expectedVersion, patch, { kind: 'user', id: actor.userId })
    })
    return { revision }
  })

  app.post<{ Params: { revisionId: string } }>('/api/plans/:revisionId/validate', async (req) => {
    const actor = await requireActor(sql, req)
    const revision = await loadRevision(sql, req.params.revisionId)
    const delivery = await loadDelivery(sql, revision.deliveryId)
    authorize(actor, 'observe', { kind: 'project', projectId: delivery.projectId })
    return { validation: await validateRevision(sql, delivery, revision) }
  })

  app.post<{ Params: { revisionId: string } }>('/api/plans/:revisionId/submit', async (req) => {
    const actor = await requireActor(sql, req)
    const body = parse(ExpectedVersion, req.body)
    // Validation errors are recorded on the revision even though the submission is refused.
    const rev = await loadRevision(sql, req.params.revisionId)
    const delivery = await loadDelivery(sql, rev.deliveryId)
    authorize(actor, 'edit_plan', {
      kind: 'delivery',
      projectId: delivery.projectId,
      ownerId: delivery.ownerId,
    })
    return sql.begin((tx) =>
      submitRevision(tx, rev.id, body.expectedVersion, { kind: 'user', id: actor.userId }),
    )
  })

  /** Approve an exact revision: the expected version must still be current (PDF §24). */
  app.post<{ Params: { revisionId: string } }>('/api/plans/:revisionId/approve', async (req) => {
    const actor = await requireActor(sql, req)
    const body = parse(ExpectedVersion, req.body)
    const rev = await loadRevision(sql, req.params.revisionId)
    const delivery = await loadDelivery(sql, rev.deliveryId)
    authorize(actor, 'approve_plan', {
      kind: 'delivery',
      projectId: delivery.projectId,
      ownerId: delivery.ownerId,
    })
    if (rev.version !== body.expectedVersion) {
      throw conflict('version_conflict', 'The revision changed since you reviewed it', { current: rev })
    }
    const [pending] = await sql<{ id: string }[]>`
      select id from approvals where plan_revision_id = ${rev.id} and kind = 'plan' and status = 'pending'
    `
    if (!pending) throw conflict('not_submitted', 'This revision has no pending approval')
    const approval = await resolveApproval(sql, hooks, actor, pending.id, { kind: 'approve' })
    return { approval, revision: await loadRevision(sql, rev.id) }
  })
}
