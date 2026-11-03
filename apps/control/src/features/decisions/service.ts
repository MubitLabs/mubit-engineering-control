import { createHash } from 'node:crypto'
import type { RunnerEventEnvelope } from '@mec/contracts'
import { canonicalJson } from '@mec/domain'
import { defaultDeciders } from '@mec/policy'
import type { Tx } from '../../db/sql'
import { enqueueCommand } from '../../outbox/commands'
import { type ApprovalHooks, type ApprovalRow, closeApprovals, createApproval } from '../approvals/service'
import type { AttemptRow } from '../attempts/service'

export const DECISION_TTL_MINUTES = 60

export function decisionBinding(a: {
  attemptId: string
  generation: number
  nativeRequestRef: string
  kind: string
  toolName?: unknown
  input?: unknown
  question?: unknown
}): string {
  return createHash('sha256').update(canonicalJson(a)).digest('hex')
}

/**
 * An agent asked a question or requested a tool (PDF §7 approval bridge). One native request maps to
 * one durable approval, bound to the exact attempt generation and input, decided by the people who
 * own that responsibility: the account owner for tool use, the delivery and task owners for questions.
 */
export async function openDecision(tx: Tx, attempt: AttemptRow, env: RunnerEventEnvelope): Promise<void> {
  const p = env.payload
  const kind = p.kind === 'question' ? 'question' : 'tool'
  const nativeRequestRef = String(p.nativeRequestRef ?? env.eventId)
  const [ctx] = await tx<
    {
      deliveryOwnerId: string
      taskOwnerId: string | null
      taskKey: string
      runnerName: string
      runnerOwnerId: string
      profileOwnerId: string | null
      profileOwnerLogin: string | null
      runnerOwnerLogin: string
      delegateIds: string[] | null
      profileLabel: string | null
    }[]
  >`
    select d.owner_id as delivery_owner_id, t.owner_id as task_owner_id, t.key as task_key,
           r.name as runner_name, r.owner_id as runner_owner_id, ro.login as runner_owner_login,
           p.owner_id as profile_owner_id, po.login as profile_owner_login, p.delegate_ids, p.label as profile_label
    from attempts a
    join tasks t on t.id = a.task_id
    join deliveries d on d.id = a.delivery_id
    join runners r on r.id = a.runner_id
    join users ro on ro.id = r.owner_id
    left join execution_profiles p on p.id = a.profile_id
    left join users po on po.id = p.owner_id
    where a.id = ${attempt.id}
  `
  if (!ctx) return
  const accountOwner = ctx.profileOwnerId ?? ctx.runnerOwnerId
  const deciders = defaultDeciders(kind, {
    deliveryOwnerId: ctx.deliveryOwnerId,
    taskOwnerId: ctx.taskOwnerId,
    profileOwnerId: accountOwner,
    profileDelegateIds: ctx.delegateIds ?? [],
  })
  const command = typeof p.command === 'string' ? p.command : null
  const toolName = typeof p.toolName === 'string' ? p.toolName : null
  const question = typeof p.question === 'string' ? p.question : null
  const requester = `${attempt.agentKind}${ctx.profileLabel ? ` (${ctx.profileLabel})` : ''} on ${ctx.runnerName}`

  await createApproval(tx, {
    kind,
    projectId: attempt.projectId,
    deliveryId: attempt.deliveryId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    generation: env.generation,
    nativeRequestRef,
    bindingHash: decisionBinding({
      attemptId: attempt.id,
      generation: env.generation,
      nativeRequestRef,
      kind,
      toolName,
      input: p.input ?? null,
      question,
    }),
    inputCommit: attempt.baseSha,
    title:
      kind === 'question'
        ? `${ctx.taskKey}: ${(question ?? 'Question').slice(0, 140)}`
        : command
          ? `${ctx.taskKey} wants to run: ${command.slice(0, 120)}`
          : `${ctx.taskKey} wants to use ${toolName ?? 'a tool'}`,
    detail: {
      question,
      options: Array.isArray(p.options) ? p.options : undefined,
      toolName,
      input: p.input ?? undefined,
      command,
      requester,
      profileOwner: ctx.profileOwnerLogin ?? ctx.runnerOwnerLogin,
      consequence:
        kind === 'question'
          ? 'The agent is waiting for this answer and will continue with it.'
          : `Approving lets the agent run this once in the task workspace on ${ctx.runnerName}, using ${ctx.profileOwnerLogin ?? ctx.runnerOwnerLogin}'s account.`,
    },
    requestedBy: { kind: 'agent', id: attempt.id },
    allowedDeciderIds: deciders,
    expiresAt: new Date(Date.now() + DECISION_TTL_MINUTES * 60_000),
  })
}

async function sendDecision(tx: Tx, approval: ApprovalRow, decision: Record<string, unknown>): Promise<void> {
  if (!approval.attemptId || !approval.nativeRequestRef) return
  const [attempt] = await tx<{ runnerId: string | null; generation: number }[]>`
    select runner_id, generation from attempts where id = ${approval.attemptId}
  `
  if (!attempt?.runnerId || attempt.generation !== approval.generation) return
  await enqueueCommand(tx, attempt.runnerId, {
    commandId: `${approval.attemptId}:g${attempt.generation}:decision:${approval.id}`,
    type: 'resolve_decision',
    attemptId: approval.attemptId,
    generation: attempt.generation,
    payload: { nativeRequestRef: approval.nativeRequestRef, approvalId: approval.id, decision },
  })
}

/**
 * Tool and question approvals stay bound to the exact attempt generation that asked: a resumed or
 * replaced attempt makes them stale, so a late click cannot authorise a different process.
 */
export const decisionHooks: ApprovalHooks = {
  async currentBinding(tx, approval) {
    if (!approval.attemptId) return null
    const [attempt] = await tx<{ generation: number; state: string }[]>`
      select generation, state from attempts where id = ${approval.attemptId}
    `
    if (!attempt || attempt.generation !== approval.generation) return null
    if (!['running', 'awaiting_input', 'stalled'].includes(attempt.state)) return null
    return approval.bindingHash
  },
  async onResolved(tx, approval, decision) {
    await sendDecision(
      tx,
      approval,
      decision.kind === 'answer'
        ? { kind: 'answer', answer: decision.answer }
        : decision.kind === 'approve'
          ? { kind: 'approve' }
          : { kind: 'reject', reason: decision.reason ?? 'rejected' },
    )
  },
}

/** An expired request is answered `closed` — the agent continues without it, never with consent. */
export async function onDecisionExpired(tx: Tx, approvalId: string): Promise<void> {
  const [approval] = await tx<ApprovalRow[]>`select * from approvals where id = ${approvalId}`
  if (!approval || (approval.kind !== 'tool' && approval.kind !== 'question')) return
  await sendDecision(tx, approval, { kind: 'closed', reason: 'the request expired unanswered' })
}

/** The process that asked is gone; its open requests can no longer be answered. */
export async function closeAttemptDecisions(tx: Tx, attemptId: string, reason: string): Promise<void> {
  await closeApprovals(tx, { attemptId, kinds: ['tool', 'question'] }, 'stale', reason)
}
