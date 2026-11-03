import { randomBytes } from 'node:crypto'
import { EnrolRequest } from '@mec/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../../config'
import type { Sql } from '../../db/sql'
import { appendEvent, FLEET_STREAM } from '../../events/append'
import { requireActor } from '../../http/actor'
import { forbidden, HttpError, notFound, parse } from '../../http/errors'
import { audit } from '../audit'
import { hashRunnerToken } from './gateway'
import type { RunnerRegistry } from './registry'

const INVITE_TTL_MINUTES = 60

export function registerRunnerRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; config: Config; registry: RunnerRegistry },
) {
  const { sql, config, registry } = deps

  /** Admin creates a short-lived, single-use invitation for one employee's environment. */
  app.post('/api/runners/invites', async (req, reply) => {
    const actor = await requireActor(sql, req)
    if (!actor.isAdmin) throw forbidden('Only admins can enrol runners')
    const body = parse(
      z.object({
        ownerLogin: z.string().optional(),
        label: z.string().min(1).max(100),
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'letters, digits, dot, dash and underscore')
          .optional(),
      }),
      req.body,
    )
    const [owner] = body.ownerLogin
      ? await sql<
          { id: string; login: string }[]
        >`select id, login from users where lower(login) = lower(${body.ownerLogin})`
      : [{ id: actor.userId, login: actor.user.login }]
    if (!owner) throw notFound('User')
    const token = `mec_inv_${randomBytes(24).toString('base64url')}`
    const invite = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string; expiresAt: Date }[]>`
        insert into runner_invites (token_hash, owner_id, label, created_by, expires_at)
        values (${hashRunnerToken(token)}, ${owner.id}, ${body.label}, ${actor.userId},
                now() + make_interval(mins => ${INVITE_TTL_MINUTES}))
        returning id, expires_at
      `
      await audit(tx, actor.userId, 'runner.invite', 'runner_invite', row!.id, null, { owner: owner.login })
      return row!
    })
    return reply.status(201).send({
      invite: { ...invite, owner: owner.login, label: body.label },
      token,
      command: `node apps/runner/dist/main.js enrol --url ${config.publicUrl} --invite ${token}${body.name ? ` --name ${body.name}` : ''}`,
    })
  })

  /** The runner exchanges an invitation for a device identity. The invitation is consumed. */
  app.post('/api/runners/enrol', async (req, reply) => {
    const body = parse(EnrolRequest, req.body)
    const deviceToken = `mec_rt_${randomBytes(32).toString('base64url')}`
    const runner = await sql.begin(async (tx) => {
      const [invite] = await tx<{ id: string; ownerId: string }[]>`
        update runner_invites set used_at = now()
        where token_hash = ${hashRunnerToken(body.inviteToken)} and used_at is null and expires_at > now()
        returning id, owner_id
      `
      if (!invite)
        throw new HttpError(401, 'invalid_invite', 'The invitation is invalid, expired or already used')
      const [existing] = await tx`select 1 from runners where name = ${body.name}`
      if (existing) throw new HttpError(409, 'name_taken', `A runner named '${body.name}' already exists`)
      const [r] = await tx<{ id: string }[]>`
        insert into runners (owner_id, name, token_hash, hostname, os, arch)
        values (${invite.ownerId}, ${body.name}, ${hashRunnerToken(deviceToken)}, ${body.hostname}, ${body.os}, ${body.arch})
        returning id
      `
      await tx`update runner_invites set runner_id = ${r!.id} where id = ${invite.id}`
      await appendEvent(tx, {
        stream: FLEET_STREAM,
        type: 'runner.enrolled',
        actor: { kind: 'system' },
        payload: { runnerId: r!.id, name: body.name, hostname: body.hostname },
      })
      await audit(tx, invite.ownerId, 'runner.enrol', 'runner', r!.id, null, { name: body.name })
      return r!
    })
    return reply.status(201).send({ runnerId: runner.id, token: deviceToken })
  })

  app.get('/api/runners', async (req) => {
    const actor = await requireActor(sql, req)
    const runners = await sql`
      select r.id, r.name, r.hostname, r.os, r.arch, r.runner_version, r.capacity, r.agents, r.status, r.draining,
             r.revoked_at, r.connected_at, r.last_seen_at, r.created_at, u.login as owner_login, r.owner_id,
             (select count(*)::int from attempts a where a.runner_id = r.id
                and a.state in ('leased','preparing','running','awaiting_input','work_complete','checking','stalled')) as active_attempts
      from runners r join users u on u.id = r.owner_id
      where ${actor.isAdmin} or r.owner_id = ${actor.userId}
      order by r.name
    `
    return { runners: runners.map((r) => ({ ...r, connected: registry.get(r.id as string) !== undefined })) }
  })

  /** Asks a connected runner to re-check its agents now (e.g. right after signing an agent in). */
  app.post<{ Params: { runnerId: string } }>('/api/runners/:runnerId/probe', async (req) => {
    const actor = await requireActor(sql, req)
    const runner = await loadRunner(sql, req.params.runnerId)
    if (!actor.isAdmin && runner.ownerId !== actor.userId)
      throw forbidden('Only the owner or an admin can probe a runner')
    const conn = registry.get(runner.id)
    if (!conn) throw new HttpError(409, 'runner_offline', 'The runner is not connected')
    conn.send({
      type: 'command',
      command: {
        commandId: `probe:${randomBytes(8).toString('hex')}`,
        type: 'probe',
        attemptId: null,
        generation: null,
        payload: {},
      },
    })
    return { ok: true }
  })

  app.post<{ Params: { runnerId: string } }>('/api/runners/:runnerId/drain', async (req) => {
    const actor = await requireActor(sql, req)
    const body = parse(z.object({ draining: z.boolean() }), req.body)
    const runner = await loadRunner(sql, req.params.runnerId)
    if (!actor.isAdmin && runner.ownerId !== actor.userId)
      throw forbidden('Only the owner or an admin can drain a runner')
    await sql.begin(async (tx) => {
      await tx`update runners set draining = ${body.draining} where id = ${runner.id}`
      await appendEvent(tx, {
        stream: FLEET_STREAM,
        type: body.draining ? 'runner.draining' : 'runner.undrained',
        actor: { kind: 'user', id: actor.userId },
        payload: { runnerId: runner.id },
      })
      await audit(tx, actor.userId, 'runner.drain', 'runner', runner.id, null, body)
    })
    return { ok: true }
  })

  app.post<{ Params: { runnerId: string } }>('/api/runners/:runnerId/revoke', async (req) => {
    const actor = await requireActor(sql, req)
    if (!actor.isAdmin) throw forbidden('Only admins can revoke runners')
    const runner = await loadRunner(sql, req.params.runnerId)
    await sql.begin(async (tx) => {
      await tx`update runners set revoked_at = now(), draining = true where id = ${runner.id}`
      await appendEvent(tx, {
        stream: FLEET_STREAM,
        type: 'runner.revoked',
        actor: { kind: 'user', id: actor.userId },
        payload: { runnerId: runner.id },
      })
      await audit(tx, actor.userId, 'runner.revoke', 'runner', runner.id, null)
    })
    registry.get(runner.id)?.close(4401, 'revoked')
    return { ok: true }
  })
}

async function loadRunner(sql: Sql, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Runner')
  const [runner] = await sql<
    { id: string; ownerId: string }[]
  >`select id, owner_id from runners where id = ${id}`
  if (!runner) throw notFound('Runner')
  return runner
}
