import type { Decision } from '@mec/contracts'
import { type ApprovalKind, type ApprovalState, checkResolution } from '@mec/domain'
import type { Sql, Tx } from '../../db/sql'
import { appendEvent, projectStream } from '../../events/append'
import { authorize, type RequestActor } from '../../http/actor'
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../http/errors'
import { audit } from '../audit'

export interface ApprovalRow {
  id: string
  kind: ApprovalKind
  projectId: string
  deliveryId: string | null
  taskId: string | null
  attemptId: string | null
  generation: number | null
  nativeRequestRef: string | null
  planRevisionId: string | null
  policyRevision: string
  bindingHash: string
  inputCommit: string | null
  title: string
  detail: Record<string, unknown>
  requestedByKind: 'user' | 'agent' | 'system'
  requestedBy: string | null
  allowedDeciderIds: string[]
  status: ApprovalState
  expiresAt: Date | null
  resolvedBy: string | null
  resolvedAt: Date | null
  answer: Record<string, unknown> | null
  createdAt: Date
}

/**
 * Each approval kind knows how to compute the binding of the input it was granted for (so a
 * changed plan or command makes the old approval stale) and what to do once it is resolved.
 */
export interface ApprovalHooks {
  /** Hash of the current input, or null if the bound input no longer exists. */
  currentBinding(tx: Tx, approval: ApprovalRow): Promise<string | null>
  onResolved(tx: Tx, approval: ApprovalRow, decision: Decision, actor: RequestActor): Promise<void>
}

export type ApprovalHookMap = Partial<Record<ApprovalKind, ApprovalHooks>>

export interface NewApproval {
  kind: ApprovalKind
  projectId: string
  deliveryId?: string | null
  taskId?: string | null
  attemptId?: string | null
  generation?: number | null
  nativeRequestRef?: string | null
  planRevisionId?: string | null
  bindingHash: string
  inputCommit?: string | null
  title: string
  detail?: Record<string, unknown>
  requestedBy: { kind: 'user' | 'agent' | 'system'; id?: string | null }
  allowedDeciderIds: string[]
  expiresAt?: Date | null
}

export async function createApproval(tx: Tx, a: NewApproval): Promise<ApprovalRow> {
  const [row] = await tx<ApprovalRow[]>`
    insert into approvals (
      kind, project_id, delivery_id, task_id, attempt_id, generation, native_request_ref, plan_revision_id,
      binding_hash, input_commit, title, detail, requested_by_kind, requested_by, allowed_decider_ids, expires_at
    ) values (
      ${a.kind}, ${a.projectId}, ${a.deliveryId ?? null}, ${a.taskId ?? null}, ${a.attemptId ?? null},
      ${a.generation ?? null}, ${a.nativeRequestRef ?? null}, ${a.planRevisionId ?? null}, ${a.bindingHash},
      ${a.inputCommit ?? null}, ${a.title}, ${tx.json((a.detail ?? {}) as never)}, ${a.requestedBy.kind},
      ${a.requestedBy.id ?? null}, ${tx.array(a.allowedDeciderIds)}::uuid[], ${a.expiresAt ?? null}
    )
    returning *
  `
  await appendEvent(tx, {
    stream: projectStream(a.projectId),
    type: 'approval.requested',
    projectId: a.projectId,
    deliveryId: a.deliveryId ?? null,
    taskId: a.taskId ?? null,
    attemptId: a.attemptId ?? null,
    actor: { kind: a.requestedBy.kind, id: a.requestedBy.id ?? null },
    payload: { approvalId: row!.id, kind: a.kind, title: a.title },
  })
  return row!
}

/** Closes pending approvals without a human decision (input changed or authority withdrawn). */
export async function closeApprovals(
  tx: Tx,
  where: { planRevisionId?: string; attemptId?: string; kinds?: ApprovalKind[] },
  status: 'stale' | 'expired',
  reason: string,
): Promise<number> {
  const rows = await tx<{ id: string; projectId: string; kind: string }[]>`
    update approvals set status = ${status}, resolved_at = now(), answer = ${tx.json({ reason } as never)}
    where status = 'pending'
      and (${where.planRevisionId ?? null}::uuid is null or plan_revision_id = ${where.planRevisionId ?? null})
      and (${where.attemptId ?? null}::uuid is null or attempt_id = ${where.attemptId ?? null})
      and (${where.kinds ? tx.array(where.kinds) : null}::text[] is null or kind = any(${where.kinds ? tx.array(where.kinds) : null}::text[]))
    returning id, project_id, kind
  `
  for (const r of rows) {
    await appendEvent(tx, {
      stream: projectStream(r.projectId),
      type: 'approval.closed',
      projectId: r.projectId,
      actor: { kind: 'system' },
      payload: { approvalId: r.id, kind: r.kind, status, reason },
    })
  }
  return rows.length
}

type Outcome = { kind: 'resolved'; approval: ApprovalRow } | { kind: 'closed'; status: 'expired' | 'stale' }

/**
 * Atomic compare-and-set (PDF §13). The row lock serialises concurrent answers: the first
 * authorised answer wins and a later one sees the recorded result. An expired or stale request
 * is closed, never treated as consent.
 */
export async function resolveApproval(
  sql: Sql,
  hooks: ApprovalHookMap,
  actor: RequestActor,
  approvalId: string,
  decision: Decision,
): Promise<ApprovalRow> {
  if (!/^[0-9a-f-]{36}$/i.test(approvalId)) throw notFound('Approval')
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const [row] = await tx<(ApprovalRow & { dbNow: Date })[]>`
      select a.*, now() as db_now from approvals a where id = ${approvalId} for update
    `
    if (!row) throw notFound('Approval')
    const { dbNow, ...approval } = row
    authorize(actor, 'observe', { kind: 'project', projectId: approval.projectId })

    const hook = hooks[approval.kind]
    const current = hook ? await hook.currentBinding(tx, approval) : approval.bindingHash
    const check = checkResolution(approval, {
      deciderId: actor.userId,
      decision,
      now: dbNow,
      currentBindingHash: current ?? '',
    })

    if (!check.ok) {
      switch (check.error.code) {
        case 'not_pending':
          throw conflict('already_resolved', `This request was already ${approval.status}`, { approval })
        case 'not_authorised':
          throw forbidden('You are not an authorised decider for this request')
        case 'invalid_decision':
          throw badRequest(check.error.message)
        case 'expired':
          await closeOne(tx, approval, 'expired', 'expired before it was answered')
          return { kind: 'closed', status: 'expired' }
        case 'stale_binding':
          await closeOne(tx, approval, 'stale', 'the reviewed input changed')
          return { kind: 'closed', status: 'stale' }
      }
    }

    const answer =
      decision.kind === 'answer'
        ? { answer: decision.answer }
        : decision.kind === 'reject'
          ? { reason: decision.reason ?? null }
          : {}
    const [updated] = await tx<ApprovalRow[]>`
      update approvals
      set status = ${check.value}, resolved_by = ${actor.userId}, resolved_at = now(), answer = ${tx.json(answer as never)}
      where id = ${approval.id} and status = 'pending'
      returning *
    `
    await appendEvent(tx, {
      stream: projectStream(approval.projectId),
      type: 'approval.resolved',
      projectId: approval.projectId,
      deliveryId: approval.deliveryId,
      taskId: approval.taskId,
      attemptId: approval.attemptId,
      actor: { kind: 'user', id: actor.userId },
      payload: { approvalId: approval.id, kind: approval.kind, status: check.value, by: actor.user.login },
    })
    await audit(tx, actor.userId, 'approval.resolve', 'approval', approval.id, approval.projectId, {
      kind: approval.kind,
      status: check.value,
    })
    await hook?.onResolved(tx, updated!, decision, actor)
    return { kind: 'resolved', approval: updated! }
  })

  if (outcome.kind === 'closed') {
    const message =
      outcome.status === 'expired'
        ? 'This request expired before it was answered; it was not approved'
        : 'The input this request was bound to has changed; it was not approved'
    throw new HttpError(outcome.status === 'expired' ? 410 : 409, outcome.status, message)
  }
  return outcome.approval
}

async function closeOne(tx: Tx, approval: ApprovalRow, status: 'expired' | 'stale', reason: string) {
  await tx`
    update approvals set status = ${status}, resolved_at = now(), answer = ${tx.json({ reason } as never)}
    where id = ${approval.id} and status = 'pending'
  `
  await appendEvent(tx, {
    stream: projectStream(approval.projectId),
    type: 'approval.closed',
    projectId: approval.projectId,
    deliveryId: approval.deliveryId,
    taskId: approval.taskId,
    attemptId: approval.attemptId,
    actor: { kind: 'system' },
    payload: { approvalId: approval.id, kind: approval.kind, status, reason },
  })
}
