/**
 * Executable permission policy, PDF §5 and §13.
 *
 *   Permission               Default holder                  Scope
 *   observe                  project members                 transcript, logs, diff
 *   prompt                   task owner and collaborators    this task and attempt
 *   use_profile              profile owner and delegates     approved projects
 *   approve_tool             profile owner or delegate       exact pending operation
 *   approve_plan             delivery owner                  exact plan revision
 *   merge                    authorised GitHub reviewers     branch rules still apply
 *
 * Viewing never implies prompting or approving. App admins manage the installation but do not
 * inherit approval authority over someone else's account.
 */

export type ProjectRole = 'owner' | 'member' | 'viewer'

export interface Actor {
  userId: string
  isAdmin: boolean
  /** projectId -> role. Absent means not a member. */
  projectRoles: Readonly<Record<string, ProjectRole>>
}

export type Resource =
  | { kind: 'project'; projectId: string }
  | { kind: 'delivery'; projectId: string; ownerId: string }
  | { kind: 'attempt'; projectId: string; taskOwnerId: string | null; collaboratorIds: readonly string[] }
  | {
      kind: 'profile'
      ownerId: string
      delegateIds: readonly string[]
      allowedProjectIds: readonly string[]
      projectId?: string
    }
  | { kind: 'approval'; projectId: string; allowedDeciderIds: readonly string[] }
  | { kind: 'pull_request'; projectId: string; reviewerIds: readonly string[] }
  | { kind: 'fleet' }

export type Action =
  | 'observe'
  | 'prompt'
  | 'use_profile'
  | 'resolve_approval'
  | 'approve_plan'
  | 'edit_plan'
  | 'create_delivery'
  | 'review_result'
  | 'merge'
  | 'manage_project'
  | 'manage_fleet'

export interface PolicyDecision {
  allowed: boolean
  reason: string
}

const allow = (reason: string): PolicyDecision => ({ allowed: true, reason })
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason })

const roleOf = (actor: Actor, projectId: string): ProjectRole | undefined => actor.projectRoles[projectId]
const isMember = (actor: Actor, projectId: string) => roleOf(actor, projectId) !== undefined
const canWrite = (actor: Actor, projectId: string) => {
  const r = roleOf(actor, projectId)
  return r === 'owner' || r === 'member'
}

export function can(actor: Actor, action: Action, resource: Resource): PolicyDecision {
  switch (action) {
    case 'observe': {
      if (resource.kind === 'fleet') return actor.isAdmin ? allow('admin') : deny('fleet is admin-only')
      if (resource.kind === 'profile') {
        return resource.ownerId === actor.userId || actor.isAdmin
          ? allow('owner or admin')
          : deny('not owner')
      }
      return isMember(actor, resource.projectId) ? allow('project member') : deny('not a project member')
    }

    case 'prompt': {
      if (resource.kind !== 'attempt') return deny('prompting applies to attempts')
      if (!canWrite(actor, resource.projectId)) return deny('viewers cannot prompt')
      if (resource.taskOwnerId === actor.userId) return allow('task owner')
      if (resource.collaboratorIds.includes(actor.userId)) return allow('task collaborator')
      return deny('only the task owner and collaborators can prompt')
    }

    case 'use_profile': {
      if (resource.kind !== 'profile') return deny('use_profile applies to profiles')
      const isOwner = resource.ownerId === actor.userId
      if (!isOwner && !resource.delegateIds.includes(actor.userId)) {
        return deny('only the profile owner and named delegates can use it')
      }
      if (resource.projectId !== undefined && !resource.allowedProjectIds.includes(resource.projectId)) {
        return deny('profile is not approved for this project')
      }
      return allow(isOwner ? 'profile owner' : 'named delegate')
    }

    case 'resolve_approval': {
      if (resource.kind !== 'approval') return deny('resolve_approval applies to approvals')
      if (!isMember(actor, resource.projectId)) return deny('not a project member')
      // Admin status is deliberately ignored: deciders are bound to the exact request.
      return resource.allowedDeciderIds.includes(actor.userId)
        ? allow('listed decider')
        : deny('not an authorised decider for this request')
    }

    case 'approve_plan':
    case 'review_result': {
      if (resource.kind !== 'delivery') return deny(`${action} applies to deliveries`)
      if (!canWrite(actor, resource.projectId)) return deny('viewers cannot approve')
      return resource.ownerId === actor.userId ? allow('delivery owner') : deny('only the delivery owner')
    }

    case 'edit_plan':
    case 'create_delivery': {
      const projectId = 'projectId' in resource ? resource.projectId : undefined
      if (projectId === undefined) return deny(`${action} needs a project`)
      return canWrite(actor, projectId) ? allow('project writer') : deny('viewers cannot edit')
    }

    case 'merge': {
      if (resource.kind !== 'pull_request') return deny('merge applies to pull requests')
      return resource.reviewerIds.includes(actor.userId)
        ? allow('authorised reviewer; repository branch rules still apply')
        : deny('not an authorised reviewer')
    }

    case 'manage_project': {
      if (resource.kind !== 'project') return deny('manage_project applies to projects')
      if (actor.isAdmin) return allow('admin')
      return roleOf(actor, resource.projectId) === 'owner'
        ? allow('project owner')
        : deny('not a project owner')
    }

    case 'manage_fleet':
      return actor.isAdmin ? allow('admin') : deny('fleet management is admin-only')
  }
}

/**
 * Default deciders when an approval is created. Tool approvals belong to whoever owns the account
 * that would run the tool; plan and result approvals to the delivery owner.
 */
export function defaultDeciders(
  kind: 'plan' | 'tool' | 'question' | 'result' | 'merge',
  ctx: {
    deliveryOwnerId: string
    profileOwnerId?: string | null
    profileDelegateIds?: readonly string[]
    taskOwnerId?: string | null
  },
): string[] {
  const ids = new Set<string>()
  switch (kind) {
    case 'plan':
    case 'result':
    case 'merge':
      ids.add(ctx.deliveryOwnerId)
      break
    case 'tool':
      if (ctx.profileOwnerId) ids.add(ctx.profileOwnerId)
      for (const d of ctx.profileDelegateIds ?? []) ids.add(d)
      break
    case 'question':
      ids.add(ctx.deliveryOwnerId)
      if (ctx.taskOwnerId) ids.add(ctx.taskOwnerId)
      if (ctx.profileOwnerId) ids.add(ctx.profileOwnerId)
      break
  }
  return [...ids]
}
