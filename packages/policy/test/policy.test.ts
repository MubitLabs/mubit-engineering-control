import { describe, expect, it } from 'vitest'
import { type Actor, can, defaultDeciders, type Resource } from '../src'

const actor = (userId: string, roles: Actor['projectRoles'] = {}, isAdmin = false): Actor => ({
  userId,
  isAdmin,
  projectRoles: roles,
})

const P = 'proj'
const viewer = actor('viewer', { [P]: 'viewer' })
const member = actor('member', { [P]: 'member' })
const owner = actor('owner', { [P]: 'member' })
const admin = actor('admin', { [P]: 'owner' }, true)
const outsider = actor('outsider')

const attempt: Resource = { kind: 'attempt', projectId: P, taskOwnerId: 'owner', collaboratorIds: ['member'] }
const approval: Resource = { kind: 'approval', projectId: P, allowedDeciderIds: ['owner'] }
const delivery: Resource = { kind: 'delivery', projectId: P, ownerId: 'owner' }
const profile: Resource = {
  kind: 'profile',
  ownerId: 'owner',
  delegateIds: ['member'],
  allowedProjectIds: [P],
  projectId: P,
}

describe('permission separation (PDF §5, §34)', () => {
  it('lets every project member observe, and nobody else', () => {
    expect(can(viewer, 'observe', attempt).allowed).toBe(true)
    expect(can(outsider, 'observe', attempt).allowed).toBe(false)
  })

  it('viewing never grants prompting, profile use or approval', () => {
    expect(can(viewer, 'prompt', attempt).allowed).toBe(false)
    expect(can(viewer, 'use_profile', profile).allowed).toBe(false)
    expect(can(viewer, 'resolve_approval', approval).allowed).toBe(false)
    expect(can(viewer, 'approve_plan', delivery).allowed).toBe(false)
  })

  it('lets the task owner and collaborators prompt', () => {
    expect(can(owner, 'prompt', attempt).allowed).toBe(true)
    expect(can(member, 'prompt', attempt).allowed).toBe(true)
    expect(can(actor('other', { [P]: 'member' }), 'prompt', attempt).allowed).toBe(false)
  })

  it('restricts profile use to the owner and named delegates on approved projects', () => {
    expect(can(owner, 'use_profile', profile).allowed).toBe(true)
    expect(can(member, 'use_profile', profile).allowed).toBe(true)
    expect(can(admin, 'use_profile', profile).allowed).toBe(false)
    expect(can(owner, 'use_profile', { ...profile, projectId: 'other' }).allowed).toBe(false)
  })

  it('binds approval to listed deciders; admins do not inherit it', () => {
    expect(can(owner, 'resolve_approval', approval).allowed).toBe(true)
    expect(can(admin, 'resolve_approval', approval).allowed).toBe(false)
    expect(can(member, 'resolve_approval', approval).allowed).toBe(false)
  })

  it('lets only the delivery owner approve plans and accept results', () => {
    expect(can(owner, 'approve_plan', delivery).allowed).toBe(true)
    expect(can(owner, 'review_result', delivery).allowed).toBe(true)
    expect(can(member, 'approve_plan', delivery).allowed).toBe(false)
    expect(can(admin, 'approve_plan', delivery).allowed).toBe(false)
  })

  it('restricts merge to authorised reviewers', () => {
    const pr: Resource = { kind: 'pull_request', projectId: P, reviewerIds: ['member'] }
    expect(can(member, 'merge', pr).allowed).toBe(true)
    expect(can(owner, 'merge', pr).allowed).toBe(false)
  })

  it('reserves fleet management for admins and lets writers create deliveries', () => {
    expect(can(admin, 'manage_fleet', { kind: 'fleet' }).allowed).toBe(true)
    expect(can(member, 'manage_fleet', { kind: 'fleet' }).allowed).toBe(false)
    expect(can(member, 'create_delivery', { kind: 'project', projectId: P }).allowed).toBe(true)
    expect(can(viewer, 'create_delivery', { kind: 'project', projectId: P }).allowed).toBe(false)
  })
})

describe('defaultDeciders', () => {
  it('routes tool approvals to the account owner and delegates, plans to the delivery owner', () => {
    expect(
      defaultDeciders('tool', { deliveryOwnerId: 'd', profileOwnerId: 'o', profileDelegateIds: ['x'] }),
    ).toEqual(['o', 'x'])
    expect(defaultDeciders('plan', { deliveryOwnerId: 'd', profileOwnerId: 'o' })).toEqual(['d'])
    expect(
      defaultDeciders('question', { deliveryOwnerId: 'd', taskOwnerId: 't', profileOwnerId: 'd' }),
    ).toEqual(['d', 't'])
  })
})
