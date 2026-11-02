import { createHash } from 'node:crypto'
import type { Requirement, TaskSpec, ValidationProfile } from '@mec/contracts'
import {
  canonicalJson,
  type DeliveryState,
  deliveryMachine,
  type GraphValidation,
  type PlanRevisionState,
  planRevisionMachine,
  validateTaskGraph,
} from '@mec/domain'
import { defaultDeciders } from '@mec/policy'
import type { Db, Tx } from '../../db/sql'
import { appendEvent, projectStream } from '../../events/append'
import type { RequestActor } from '../../http/actor'
import { conflict, HttpError, notFound } from '../../http/errors'
import type { ApprovalHooks } from '../approvals/service'
import { closeApprovals, createApproval } from '../approvals/service'
import { transition } from '../state'
import { refreshReadiness } from '../tasks/readiness'

export interface PlanRevisionRow {
  id: string
  deliveryId: string
  number: number
  state: PlanRevisionState
  planMarkdown: string
  constraints: string
  requirements: Requirement[]
  tasks: TaskSpec[]
  validation: GraphValidation | null
  version: number
  contentHash: string
  authorId: string | null
  supersedesId: string | null
  impactSummary: string | null
  approvedBy: string | null
  approvedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface DeliveryRow {
  id: string
  projectId: string
  repositoryId: string
  title: string
  ownerId: string
  state: DeliveryState
  baseRef: string
  baseSha: string | null
  priority: number
  createdAt: Date
  updatedAt: Date
}

export interface PlanContent {
  planMarkdown: string
  constraints: string
  requirements: Requirement[]
  tasks: TaskSpec[]
}

export function planContentHash(c: PlanContent): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        planMarkdown: c.planMarkdown,
        constraints: c.constraints,
        requirements: c.requirements,
        tasks: c.tasks,
      }),
    )
    .digest('hex')
}

export async function loadDelivery(db: Db, id: string, lock = false): Promise<DeliveryRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Delivery')
  const [row] = lock
    ? await db<DeliveryRow[]>`select * from deliveries where id = ${id} for update`
    : await db<DeliveryRow[]>`select * from deliveries where id = ${id}`
  if (!row) throw notFound('Delivery')
  return row
}

export async function loadRevision(db: Db, id: string, lock = false): Promise<PlanRevisionRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Plan revision')
  const [row] = lock
    ? await db<PlanRevisionRow[]>`select * from plan_revisions where id = ${id} for update`
    : await db<PlanRevisionRow[]>`select * from plan_revisions where id = ${id}`
  if (!row) throw notFound('Plan revision')
  return row
}

/** Profiles that may run tasks in this project. Execution profiles arrive in M7. */
export async function availableProfileIds(db: Db, projectId: string): Promise<string[]> {
  const [exists] = await db<{ t: string | null }[]>`select to_regclass('execution_profiles')::text as t`
  if (!exists?.t) return []
  const rows = await db<{ id: string }[]>`
    select id from execution_profiles
    where ${projectId} = any(allowed_project_ids) and revoked_at is null
  `
  return rows.map((r) => r.id)
}

export async function validateRevision(
  db: Db,
  delivery: DeliveryRow,
  content: PlanContent,
): Promise<GraphValidation> {
  const [repo] = await db<{ validationProfile: ValidationProfile }[]>`
    select validation_profile from repositories where id = ${delivery.repositoryId}
  `
  return validateTaskGraph(content.tasks, {
    requirementIds: content.requirements.map((r) => r.id),
    availableProfileIds: await availableProfileIds(db, delivery.projectId),
    knownCheckNames: repo?.validationProfile.checks.map((c) => c.name) ?? [],
  })
}

export async function insertRevision(
  tx: Tx,
  delivery: DeliveryRow,
  content: PlanContent,
  authorId: string | null,
  supersedesId: string | null,
): Promise<PlanRevisionRow> {
  const [counter] = await tx<{ next: number }[]>`
    select coalesce(max(number), 0) + 1 as next from plan_revisions where delivery_id = ${delivery.id}
  `
  const next = counter!.next
  const [row] = await tx<PlanRevisionRow[]>`
    insert into plan_revisions (
      delivery_id, number, plan_markdown, constraints, requirements, tasks, content_hash, author_id, supersedes_id
    ) values (
      ${delivery.id}, ${next}, ${content.planMarkdown}, ${content.constraints},
      ${tx.json(content.requirements as never)}, ${tx.json(content.tasks as never)}, ${planContentHash(content)},
      ${authorId}, ${supersedesId}
    )
    returning *
  `
  await appendEvent(tx, {
    stream: projectStream(delivery.projectId),
    type: 'plan.revision_created',
    projectId: delivery.projectId,
    deliveryId: delivery.id,
    actor: authorId ? { kind: 'user', id: authorId } : { kind: 'system' },
    payload: { revisionId: row!.id, number: next, supersedesId },
  })
  return row!
}

/** Only one open (draft or proposed) revision per delivery: opening a new one supersedes it. */
export async function openNewRevision(
  tx: Tx,
  delivery: DeliveryRow,
  base: PlanRevisionRow,
  actor: RequestActor,
): Promise<PlanRevisionRow> {
  const open = await tx<PlanRevisionRow[]>`
    select * from plan_revisions where delivery_id = ${delivery.id} and state in ('draft', 'proposed') for update
  `
  for (const r of open) {
    await closeApprovals(tx, { planRevisionId: r.id }, 'stale', 'superseded by a newer revision')
    await transition(tx, {
      table: 'plan_revisions',
      machine: planRevisionMachine,
      id: r.id,
      from: r.state,
      event: 'supersede',
      projectId: delivery.projectId,
      deliveryId: delivery.id,
      actor: { kind: 'user', id: actor.userId },
    })
  }
  return insertRevision(tx, delivery, base, actor.userId, base.id)
}

/** Optimistic edit: a stale expectedVersion returns the newer text so the editor can merge. */
export async function updateRevision(
  tx: Tx,
  revisionId: string,
  expectedVersion: number,
  patch: Partial<PlanContent>,
  actor: RequestActor,
): Promise<PlanRevisionRow> {
  const rev = await loadRevision(tx, revisionId, true)
  const delivery = await loadDelivery(tx, rev.deliveryId)
  if (rev.state !== 'draft' && rev.state !== 'proposed') {
    throw conflict('immutable_revision', `Revision ${rev.number} is ${rev.state} and cannot be edited`)
  }
  if (rev.version !== expectedVersion) {
    throw conflict('version_conflict', 'Someone else changed this revision', { current: rev })
  }
  if (rev.state === 'proposed') {
    await closeApprovals(tx, { planRevisionId: rev.id }, 'stale', 'the plan was edited after submission')
    await transition(tx, {
      table: 'plan_revisions',
      machine: planRevisionMachine,
      id: rev.id,
      from: 'proposed',
      event: 'edit',
      projectId: delivery.projectId,
      deliveryId: delivery.id,
      actor: { kind: 'user', id: actor.userId },
    })
  }
  const content: PlanContent = {
    planMarkdown: patch.planMarkdown ?? rev.planMarkdown,
    constraints: patch.constraints ?? rev.constraints,
    requirements: patch.requirements ?? rev.requirements,
    tasks: patch.tasks ?? rev.tasks,
  }
  const [updated] = await tx<PlanRevisionRow[]>`
    update plan_revisions set
      plan_markdown = ${content.planMarkdown}, constraints = ${content.constraints},
      requirements = ${tx.json(content.requirements as never)}, tasks = ${tx.json(content.tasks as never)},
      content_hash = ${planContentHash(content)}, validation = null,
      version = version + 1, updated_at = now()
    where id = ${rev.id} and version = ${expectedVersion}
    returning *
  `
  await appendEvent(tx, {
    stream: projectStream(delivery.projectId),
    type: 'plan.edited',
    projectId: delivery.projectId,
    deliveryId: delivery.id,
    actor: { kind: 'user', id: actor.userId },
    payload: { revisionId: rev.id, version: updated!.version },
  })
  return updated!
}

/** Validates the graph; a valid revision becomes 'proposed' with a plan approval for the owner. */
export async function submitRevision(
  tx: Tx,
  revisionId: string,
  expectedVersion: number,
  actor: { kind: 'user' | 'agent'; id: string | null },
): Promise<{ revision: PlanRevisionRow; validation: GraphValidation }> {
  const rev = await loadRevision(tx, revisionId, true)
  const delivery = await loadDelivery(tx, rev.deliveryId)
  if (rev.version !== expectedVersion) {
    throw conflict('version_conflict', 'Someone else changed this revision', { current: rev })
  }
  if (rev.state !== 'draft') {
    throw conflict(
      'invalid_transition',
      `Revision ${rev.number} is ${rev.state}; only drafts can be submitted`,
    )
  }
  const validation = await validateRevision(tx, delivery, rev)
  await tx`update plan_revisions set validation = ${tx.json(validation as never)} where id = ${rev.id}`
  if (!validation.ok) {
    throw new HttpError(422, 'invalid_plan', 'The task graph has errors', { validation })
  }
  await transition(tx, {
    table: 'plan_revisions',
    machine: planRevisionMachine,
    id: rev.id,
    from: 'draft',
    event: 'submit',
    projectId: delivery.projectId,
    deliveryId: delivery.id,
    actor,
  })
  await createApproval(tx, {
    kind: 'plan',
    projectId: delivery.projectId,
    deliveryId: delivery.id,
    planRevisionId: rev.id,
    bindingHash: rev.contentHash,
    title: `Approve plan revision ${rev.number} for "${delivery.title}"`,
    detail: { revisionNumber: rev.number, taskCount: rev.tasks.length, warnings: validation.warnings.length },
    requestedBy: actor,
    allowedDeciderIds: defaultDeciders('plan', { deliveryOwnerId: delivery.ownerId }),
  })
  return { revision: await loadRevision(tx, rev.id), validation }
}

/**
 * Plan approvals bind to the revision's content hash. Approving makes the revision immutable,
 * supersedes the previous approved revision and materialises its tasks.
 */
export const planApprovalHooks: ApprovalHooks = {
  async currentBinding(tx, approval) {
    if (!approval.planRevisionId) return null
    const [rev] = await tx<{ state: string; contentHash: string }[]>`
      select state, content_hash from plan_revisions where id = ${approval.planRevisionId} for update
    `
    return rev && rev.state === 'proposed' ? rev.contentHash : null
  },

  async onResolved(tx, approval, decision, actor) {
    const rev = await loadRevision(tx, approval.planRevisionId!, true)
    const delivery = await loadDelivery(tx, rev.deliveryId, true)
    const by = { kind: 'user' as const, id: actor.userId }
    if (decision.kind === 'reject') {
      await transition(tx, {
        table: 'plan_revisions',
        machine: planRevisionMachine,
        id: rev.id,
        from: 'proposed',
        event: 'reject',
        projectId: delivery.projectId,
        deliveryId: delivery.id,
        actor: by,
      })
      return
    }
    const previous = await tx<{ id: string }[]>`
      select id from plan_revisions where delivery_id = ${delivery.id} and state = 'approved' for update
    `
    for (const p of previous) {
      await transition(tx, {
        table: 'plan_revisions',
        machine: planRevisionMachine,
        id: p.id,
        from: 'approved',
        event: 'supersede',
        projectId: delivery.projectId,
        deliveryId: delivery.id,
        actor: by,
      })
    }
    await transition(tx, {
      table: 'plan_revisions',
      machine: planRevisionMachine,
      id: rev.id,
      from: 'proposed',
      event: 'approve',
      set: { approvedBy: actor.userId, approvedAt: new Date() },
      projectId: delivery.projectId,
      deliveryId: delivery.id,
      actor: by,
    })
    await materializeTasks(tx, delivery, rev)
    if (delivery.state === 'planning') {
      await transition(tx, {
        table: 'deliveries',
        machine: deliveryMachine,
        id: delivery.id,
        from: 'planning',
        event: 'plan_approved',
        projectId: delivery.projectId,
        deliveryId: delivery.id,
        actor: by,
      })
    }
  },
}

/** Turns an approved revision into task rows. Unstarted tasks from older revisions are cancelled. */
export async function materializeTasks(tx: Tx, delivery: DeliveryRow, rev: PlanRevisionRow): Promise<void> {
  const cancelled = await tx<{ id: string }[]>`
    update tasks set state = 'cancelled', updated_at = now()
    where delivery_id = ${delivery.id} and plan_revision_id <> ${rev.id}
      and state in ('proposed', 'approved', 'ready')
    returning id
  `
  const ids = new Map<string, string>()
  for (const spec of rev.tasks) {
    const [t] = await tx<{ id: string }[]>`
      insert into tasks (delivery_id, plan_revision_id, key, title, spec, state, owner_id)
      values (${delivery.id}, ${rev.id}, ${spec.key}, ${spec.title}, ${tx.json(spec as never)}, 'approved',
              ${delivery.ownerId})
      returning id
    `
    ids.set(spec.key, t!.id)
  }
  for (const spec of rev.tasks) {
    for (const dep of spec.dependsOn) {
      await tx`
        insert into task_dependencies (task_id, depends_on_task_id) values (${ids.get(spec.key)!}, ${ids.get(dep)!})
      `
    }
  }
  await appendEvent(tx, {
    stream: projectStream(delivery.projectId),
    type: 'plan.tasks_materialized',
    projectId: delivery.projectId,
    deliveryId: delivery.id,
    actor: { kind: 'system' },
    payload: { revisionId: rev.id, taskIds: [...ids.values()], cancelledTaskIds: cancelled.map((c) => c.id) },
  })
  await refreshReadiness(tx, delivery)
}
