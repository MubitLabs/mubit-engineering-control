import type { Action, Actor, ProjectRole, Resource } from '@mec/policy'
import { can } from '@mec/policy'
import type { FastifyRequest } from 'fastify'
import type { Db } from '../db/sql'
import type { SessionUser } from '../features/auth/sessions'
import { forbidden, unauthorized } from './errors'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
}

export interface RequestActor extends Actor {
  user: SessionUser
}

/** Loads the signed-in user's project roles into a policy Actor, or throws 401. */
export async function requireActor(db: Db, req: FastifyRequest): Promise<RequestActor> {
  const user = req.user
  if (!user) throw unauthorized()
  const rows = await db<{ projectId: string; role: ProjectRole }[]>`
    select project_id, role from memberships where user_id = ${user.id}
  `
  return {
    user,
    userId: user.id,
    isAdmin: user.isAdmin,
    projectRoles: Object.fromEntries(rows.map((r) => [r.projectId, r.role])),
  }
}

export function authorize(actor: Actor, action: Action, resource: Resource): void {
  const decision = can(actor, action, resource)
  if (!decision.allowed) throw forbidden(decision.reason)
}
