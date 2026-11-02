import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Sql, Tx } from '../../db/sql'
import { appendEvent, FLEET_STREAM } from '../../events/append'
import { requireActor } from '../../http/actor'
import { badRequest, conflict, forbidden, notFound, parse } from '../../http/errors'
import { audit } from '../audit'

const CreateProfile = z.object({
  runnerId: z.uuid(),
  agentKind: z.enum(['fake', 'claude-code']),
  label: z.string().min(1).max(80),
  model: z.string().max(80).nullable().default(null),
  allowedProjectIds: z.array(z.uuid()).default([]),
  delegateLogins: z.array(z.string()).default([]),
  maxActive: z.number().int().min(1).max(4).default(1),
})

const UpdateGrants = z.object({
  allowedProjectIds: z.array(z.uuid()).optional(),
  delegateLogins: z.array(z.string()).optional(),
  maxActive: z.number().int().min(1).max(4).optional(),
})

export interface ProfileRow {
  id: string
  ownerId: string
  runnerId: string
  agentKind: string
  label: string
  model: string | null
  agentVersion: string | null
  capabilitySet: string[]
  authState: 'ok' | 'required' | 'unknown'
  allowedProjectIds: string[]
  delegateIds: string[]
  maxActive: number
  revokedAt: Date | null
}

/**
 * Owned execution profiles and delegation grants (PDF §5, ticket 09). Only the employee who owns
 * the runner can offer one of its native accounts; they choose the projects and the colleagues
 * that may use it. Admins do not inherit this — the account is personal.
 */
export function registerProfiles(app: FastifyInstance, deps: { sql: Sql }) {
  const { sql } = deps

  app.get('/api/profiles', async (req) => {
    const actor = await requireActor(sql, req)
    const profiles = await sql`
      select p.*, u.login as owner_login, r.name as runner_name, r.status as runner_status,
        (select coalesce(array_agg(login order by login), '{}') from users where id = any(p.delegate_ids)) as delegate_logins,
        (select count(*)::int from attempts a where a.profile_id = p.id
           and a.state in ('leased','preparing','running','awaiting_input','work_complete','checking','stalled')) as active
      from execution_profiles p
      join users u on u.id = p.owner_id
      join runners r on r.id = p.runner_id
      where p.revoked_at is null
        and (p.owner_id = ${actor.userId} or ${actor.userId}::uuid = any(p.delegate_ids) or ${actor.isAdmin})
      order by u.login, p.label
    `
    return { profiles }
  })

  app.post('/api/profiles', async (req, reply) => {
    const actor = await requireActor(sql, req)
    const body = parse(CreateProfile, req.body)
    const profile = await sql.begin(async (tx) => {
      const [runner] = await tx<
        {
          id: string
          ownerId: string
          agents: {
            kind: string
            available: boolean
            version: string | null
            auth: string
            capabilities: string[]
          }[]
        }[]
      >`
        select id, owner_id, agents from runners where id = ${body.runnerId} and revoked_at is null
      `
      if (!runner) throw notFound('Runner')
      if (runner.ownerId !== actor.userId)
        throw forbidden('Only the runner owner can offer its agent accounts')
      const agent = runner.agents.find((a) => a.kind === body.agentKind && a.available)
      if (!agent) throw badRequest(`The runner does not report ${body.agentKind} as available`)
      const delegateIds = await resolveLogins(tx, body.delegateLogins)
      const [row] = await tx<ProfileRow[]>`
        insert into execution_profiles (
          owner_id, runner_id, agent_kind, label, model, agent_version, capability_set, auth_state,
          allowed_project_ids, delegate_ids, max_active
        ) values (
          ${actor.userId}, ${runner.id}, ${body.agentKind}, ${body.label}, ${body.model}, ${agent.version},
          ${tx.json(agent.capabilities as never)}, ${agent.auth === 'ok' || agent.auth === 'required' ? agent.auth : 'unknown'},
          ${tx.array(body.allowedProjectIds)}::uuid[], ${tx.array(delegateIds)}::uuid[], ${body.maxActive}
        )
        on conflict (runner_id, agent_kind, label) do nothing
        returning *
      `
      if (!row) throw conflict('label_taken', 'A profile with that label already exists on this runner')
      await appendEvent(tx, {
        stream: FLEET_STREAM,
        type: 'profile.created',
        actor: { kind: 'user', id: actor.userId },
        payload: { profileId: row.id, label: row.label, agentKind: row.agentKind },
      })
      await audit(tx, actor.userId, 'profile.create', 'profile', row.id, null, { label: row.label })
      return row
    })
    return reply.status(201).send({ profile })
  })

  app.patch<{ Params: { profileId: string } }>('/api/profiles/:profileId', async (req) => {
    const actor = await requireActor(sql, req)
    const body = parse(UpdateGrants, req.body)
    const profile = await sql.begin(async (tx) => {
      const p = await ownProfile(tx, req.params.profileId, actor.userId)
      const delegateIds = body.delegateLogins ? await resolveLogins(tx, body.delegateLogins) : p.delegateIds
      const [row] = await tx<ProfileRow[]>`
        update execution_profiles set
          allowed_project_ids = ${tx.array(body.allowedProjectIds ?? p.allowedProjectIds)}::uuid[],
          delegate_ids = ${tx.array(delegateIds)}::uuid[],
          max_active = ${body.maxActive ?? p.maxActive}, updated_at = now()
        where id = ${p.id}
        returning *
      `
      await audit(tx, actor.userId, 'profile.grants', 'profile', p.id, null, body)
      return row!
    })
    return { profile }
  })

  /** Revocation stops new work at once; running attempts are left to the owner to stop or finish. */
  app.post<{ Params: { profileId: string } }>('/api/profiles/:profileId/revoke', async (req) => {
    const actor = await requireActor(sql, req)
    await sql.begin(async (tx) => {
      const p = await ownProfile(tx, req.params.profileId, actor.userId)
      await tx`update execution_profiles set revoked_at = now(), updated_at = now() where id = ${p.id}`
      // Pending tool approvals for this account lose their authority.
      await tx`
        update approvals set status = 'stale', resolved_at = now(), answer = ${tx.json({ reason: 'profile revoked' } as never)}
        where status = 'pending' and kind = 'tool' and attempt_id in (select id from attempts where profile_id = ${p.id})
      `
      await audit(tx, actor.userId, 'profile.revoke', 'profile', p.id, null)
    })
    return { ok: true }
  })
}

async function ownProfile(tx: Tx, id: string, userId: string): Promise<ProfileRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Profile')
  const [p] = await tx<
    ProfileRow[]
  >`select * from execution_profiles where id = ${id} and revoked_at is null for update`
  if (!p) throw notFound('Profile')
  if (p.ownerId !== userId) throw forbidden('Only the profile owner can change its grants')
  return p
}

async function resolveLogins(tx: Tx, logins: string[]): Promise<string[]> {
  if (logins.length === 0) return []
  const rows = await tx<{ id: string; login: string }[]>`
    select id, login from users where lower(login) = any(${tx.array(logins.map((l) => l.toLowerCase()))})
  `
  const missing = logins.filter((l) => !rows.some((r) => r.login.toLowerCase() === l.toLowerCase()))
  if (missing.length) throw badRequest(`Unknown users: ${missing.join(', ')}`)
  return rows.map((r) => r.id)
}
