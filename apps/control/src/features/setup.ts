import type { FastifyInstance } from 'fastify'
import type { Sql } from '../db/sql'
import { requireActor } from '../http/actor'

/** What still stands between the signed-in user and a first delivery, over the projects they can see. */
export function registerSetup(app: FastifyInstance, deps: { sql: Sql }) {
  const { sql } = deps

  app.get('/api/setup', async (req) => {
    const actor = await requireActor(sql, req)
    const projects = await sql<{ id: string }[]>`
      select p.id from projects p
      where ${actor.isAdmin} or exists (select 1 from memberships m where m.project_id = p.id and m.user_id = ${actor.userId})
      order by p.created_at
    `
    const ids = projects.map((p) => p.id)
    const [row] = await sql<
      {
        repository: boolean
        runner: boolean
        profile: boolean
        delivery: boolean
        repositoryProjectId: string | null
      }[]
    >`
      select
        exists (select 1 from repositories r where r.project_id = any(${sql.array(ids)}::uuid[])
                  and jsonb_array_length(r.validation_profile -> 'checks') > 0) as repository,
        exists (select 1 from runners r where r.revoked_at is null and r.status = 'online') as runner,
        exists (select 1 from execution_profiles p where p.revoked_at is null
                  and p.allowed_project_ids && ${sql.array(ids)}::uuid[]) as profile,
        exists (select 1 from deliveries d where d.project_id = any(${sql.array(ids)}::uuid[])) as delivery,
        (select r.project_id from repositories r where r.project_id = any(${sql.array(ids)}::uuid[])
           order by r.created_at limit 1) as repository_project_id
    `
    return {
      projectId: row!.repositoryProjectId ?? ids[0] ?? null,
      steps: {
        project: ids.length > 0,
        repository: row!.repository,
        runner: row!.runner,
        profile: row!.profile,
        delivery: row!.delivery,
      },
    }
  })
}
