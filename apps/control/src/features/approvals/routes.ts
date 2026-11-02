import { ResolveApproval } from '@mec/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Sql } from '../../db/sql'
import { authorize, requireActor } from '../../http/actor'
import { notFound, parse } from '../../http/errors'
import { type ApprovalHookMap, type ApprovalRow, resolveApproval } from './service'

const ListQuery = z.object({
  projectId: z.uuid().optional(),
  scope: z.enum(['mine', 'project']).default('mine'),
  status: z.enum(['pending', 'all']).default('pending'),
})

export function registerApprovals(app: FastifyInstance, deps: { sql: Sql; hooks: ApprovalHookMap }) {
  const { sql, hooks } = deps

  /** The decision inbox: by default, pending requests the caller is authorised to decide. */
  app.get('/api/approvals', async (req) => {
    const actor = await requireActor(sql, req)
    const q = parse(ListQuery, req.query)
    if (q.projectId) authorize(actor, 'observe', { kind: 'project', projectId: q.projectId })
    const projectIds = q.projectId ? [q.projectId] : Object.keys(actor.projectRoles)
    if (projectIds.length === 0) return { approvals: [] }
    const approvals = await sql`
      select a.*, t.key as task_key, d.title as delivery_title, u.login as resolved_by_login
      from approvals a
      left join tasks t on t.id = a.task_id
      left join deliveries d on d.id = a.delivery_id
      left join users u on u.id = a.resolved_by
      where a.project_id = any(${sql.array(projectIds)}::uuid[])
        and (${q.status} = 'all' or a.status = 'pending')
        and (${q.scope} = 'project' or ${actor.userId}::uuid = any(a.allowed_decider_ids))
      order by a.created_at desc
      limit 200
    `
    return { approvals }
  })

  app.get<{ Params: { approvalId: string } }>('/api/approvals/:approvalId', async (req) => {
    const actor = await requireActor(sql, req)
    if (!/^[0-9a-f-]{36}$/i.test(req.params.approvalId)) throw notFound('Approval')
    const [approval] = await sql<ApprovalRow[]>`select * from approvals where id = ${req.params.approvalId}`
    if (!approval) throw notFound('Approval')
    authorize(actor, 'observe', { kind: 'project', projectId: approval.projectId })
    const deciders = await sql`
      select id, login, name from users where id = any(${sql.array(approval.allowedDeciderIds)}::uuid[])
    `
    return { approval, deciders, canDecide: approval.allowedDeciderIds.includes(actor.userId) }
  })

  app.post<{ Params: { approvalId: string } }>('/api/approvals/:approvalId/resolve', async (req) => {
    const actor = await requireActor(sql, req)
    const body = parse(ResolveApproval, req.body)
    const approval = await resolveApproval(sql, hooks, actor, req.params.approvalId, body.decision)
    return { approval }
  })
}
