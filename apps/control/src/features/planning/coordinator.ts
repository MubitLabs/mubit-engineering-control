import { AgentKind, FakeStep, Requirement, TaskSpec, type ValidationProfile } from '@mec/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../../config'
import type { Sql, Tx } from '../../db/sql'
import { authorize, requireActor } from '../../http/actor'
import { conflict, notFound, parse } from '../../http/errors'
import { type AttemptRow, claimAttempt } from '../attempts/service'
import { registerControlCall } from '../decisions/calls'
import {
  type DeliveryRow,
  loadDelivery,
  loadRevision,
  openNewRevision,
  type PlanRevisionRow,
  submitRevision,
  updateRevision,
  validateRevision,
} from '../plans/service'
import type { RunnerRegistry } from '../runners/registry'

/** Bounded repair (PDF §8, §9): after this many invalid proposals the plan becomes a human decision. */
export const MAX_PROPOSALS = 4

const StartCoordinator = z.object({
  profileId: z.uuid().optional(),
  runnerId: z.uuid().optional(),
  agentKind: AgentKind.default('claude-code'),
  /** Fake-agent script, for tests and demos without an agent account. */
  script: z.array(FakeStep).max(200).optional(),
})

export function coordinatorPrompt(
  delivery: DeliveryRow,
  rev: PlanRevisionRow,
  repo: { name: string; checks: string[] },
): string {
  return `You are the coordinator for the delivery "${delivery.title}" in repository ${repo.name} (base ${delivery.baseRef}).
You have read-only access to the repository at the pinned base commit. Do not modify files.

Your job: turn the implementation plan below into a task graph for parallel coding agents, without rewriting its intent.
1. Read the repository instructions, package boundaries, test commands and existing interfaces.
2. Extract every requirement and acceptance criterion into a traceable list (ids R1, R2, …).
3. Identify prerequisites (schemas, API contracts, shared types, migration ordering).
4. Split the remaining work into reviewable tasks with bounded file ownership, dependencies and validation.
5. Flag files that several tasks may touch (lockfiles, migrations, generated types, route registries): give each to exactly one task or make one task depend on the other.

Then call the mcp__mec__propose_tasks tool with:
- requirements: [{ "id": "R1", "text": "..." }]
- tasks: [{ "key", "title", "objective", "requirementIds", "deliverables", "acceptanceChecks", "dependsOn", "basePolicy", "ownedPaths", "maxAttempts", "timeBudgetMinutes" }]
Rules: keys use letters, digits, "-" or "_" and must not start with "mec-"; acceptanceChecks must be names from [${repo.checks.join(', ')}];
use basePolicy "contract" only when a task needs an agreed interface rather than the finished implementation, otherwise "integration".
If the tool returns errors, fix exactly those and call it again (at most ${MAX_PROPOSALS} calls in total).
When it confirms submission, stop and give a short summary of the graph and any unresolved decisions.

Implementation plan:
${rev.planMarkdown || '(empty)'}

Constraints:
${rev.constraints || '(none)'}
`
}

export function registerCoordinator(
  app: FastifyInstance,
  deps: { sql: Sql; config: Config; registry: RunnerRegistry },
) {
  const { sql, config, registry } = deps

  /** Start a coordinator attempt for a delivery in planning (Observe mode on the pinned base). */
  app.post<{ Params: { deliveryId: string } }>(
    '/api/deliveries/:deliveryId/coordinate',
    async (req, reply) => {
      const actor = await requireActor(sql, req)
      const body = parse(StartCoordinator, req.body ?? {})
      const result = await sql.begin(async (tx) => {
        const delivery = await loadDelivery(tx, req.params.deliveryId, true)
        authorize(actor, 'edit_plan', {
          kind: 'delivery',
          projectId: delivery.projectId,
          ownerId: delivery.ownerId,
        })

        let runnerId = body.runnerId ?? null
        let agentKind = body.agentKind
        if (body.profileId) {
          const [p] = await tx<
            {
              id: string
              ownerId: string
              runnerId: string
              agentKind: AgentKind
              allowedProjectIds: string[]
              delegateIds: string[]
            }[]
          >`select * from execution_profiles where id = ${body.profileId} and revoked_at is null`
          if (!p) throw notFound('Profile')
          authorize(actor, 'use_profile', {
            kind: 'profile',
            ownerId: p.ownerId,
            delegateIds: p.delegateIds,
            allowedProjectIds: p.allowedProjectIds,
            projectId: delivery.projectId,
          })
          runnerId = p.runnerId
          agentKind = p.agentKind
        }
        if (!runnerId)
          throw conflict('no_runner', 'Choose an execution profile (or a runner for the fake agent)')

        const [latest] = await tx<PlanRevisionRow[]>`
        select * from plan_revisions where delivery_id = ${delivery.id} order by number desc limit 1
      `
        const rev = latest!.state === 'draft' ? latest! : await openNewRevision(tx, delivery, latest!, actor)
        const [repo] = await tx<{ name: string; validationProfile: ValidationProfile }[]>`
        select name, validation_profile from repositories where id = ${delivery.repositoryId}
      `
        const [{ n }] = (await tx`
        select count(*)::int as n from tasks where delivery_id = ${delivery.id} and kind = 'planning'
      `) as unknown as [{ n: number }]
        const key = `mec-plan-${n + 1}`
        const [task] = await tx<{ id: string }[]>`
        insert into tasks (delivery_id, plan_revision_id, key, title, spec, state, owner_id, kind)
        values (${delivery.id}, ${rev.id}, ${key}, ${`Coordinator run ${n + 1}`},
                ${tx.json(TaskSpec.parse({ key: 'coordinator', title: 'Coordinator', objective: 'Propose the task graph', maxAttempts: 1 }) as never)},
                'ready', ${actor.userId}, 'planning')
        returning id
      `
        return claimAttempt(tx, {
          taskId: task!.id,
          runnerId,
          agentKind,
          kind: 'coordinator',
          profileId: body.profileId ?? null,
          inputs: {
            revisionId: rev.id,
            prompt: coordinatorPrompt(delivery, rev, {
              name: repo!.name,
              checks: repo!.validationProfile.checks.map((c) => c.name),
            }),
            ...(body.script ? { script: body.script } : {}),
          },
          actor: { kind: 'user', id: actor.userId },
          leaseMs: config.scheduling.leaseTtlMs,
          capacity: { limits: config.scheduling.limits, connectedIds: registry.connectedIds() },
        })
      })
      return reply.status(result.created ? 201 : 200).send(result)
    },
  )
}

const Proposal = z.object({
  requirements: z.array(Requirement).min(1),
  tasks: z.array(TaskSpec).min(1),
  notes: z.string().optional(),
})

/**
 * The coordinator's only write: propose requirements and tasks for its draft revision. Deterministic
 * validation decides; errors go back for repair; a valid graph is submitted for the delivery owner's
 * approval. The coordinator cannot approve, widen budgets or grant accounts (PDF §25).
 */
registerControlCall('propose_tasks', async (tx: Tx, attempt: AttemptRow, params) => {
  if (attempt.kind !== 'coordinator')
    return { ok: false, final: true, error: 'Only a coordinator may propose tasks' }
  const [{ n }] = (await tx`
    select count(*)::int as n from events
    where attempt_id = ${attempt.id} and type = 'control.call' and payload->>'method' = 'propose_tasks'
  `) as unknown as [{ n: number }]
  const left = MAX_PROPOSALS - n
  if (left < 0) {
    return {
      ok: false,
      final: true,
      error: `Too many invalid proposals; the delivery owner will finish the plan by hand.`,
    }
  }
  const parsed = Proposal.safeParse(params)
  if (!parsed.success) {
    return {
      ok: false,
      attemptsLeft: left,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'proposal'}: ${i.message}`),
    }
  }
  const revisionId = String(attempt.inputs.revisionId ?? '')
  const rev = await loadRevision(tx, revisionId, true)
  if (rev.state !== 'draft') {
    return {
      ok: false,
      final: true,
      error: `Revision ${rev.number} is ${rev.state}; someone else changed it`,
    }
  }
  const delivery = await loadDelivery(tx, rev.deliveryId)
  const content = { planMarkdown: rev.planMarkdown, constraints: rev.constraints, ...parsed.data }
  const validation = await validateRevision(tx, delivery, content)
  const updated = await updateRevision(
    tx,
    rev.id,
    rev.version,
    { requirements: parsed.data.requirements, tasks: parsed.data.tasks },
    { kind: 'agent', id: attempt.id },
  )
  if (!validation.ok) {
    await tx`update plan_revisions set validation = ${tx.json(validation as never)} where id = ${rev.id}`
    return {
      ok: false,
      attemptsLeft: left,
      errors: validation.errors.map((e) => e.message),
      warnings: validation.warnings.map((w) => w.message),
    }
  }
  await submitRevision(tx, rev.id, updated.version, { kind: 'agent', id: attempt.id })
  return {
    ok: true,
    message: `Revision ${rev.number} with ${parsed.data.tasks.length} tasks was submitted for the delivery owner's approval.`,
    warnings: validation.warnings.map((w) => w.message),
    maxParallelism: validation.maxParallelism,
  }
})
