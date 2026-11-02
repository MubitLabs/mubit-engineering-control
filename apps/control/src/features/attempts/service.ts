import { randomUUID } from 'node:crypto'
import { type AgentKind, type RunnerEventEnvelope, RunnerEventType, type TaskSpec } from '@mec/contracts'
import {
  ACTIVE_ATTEMPT_STATES,
  type AttemptEvent,
  type AttemptState,
  attemptMachine,
  type Blocker,
  deliveryMachine,
  LEASE_DEFAULTS,
  type TaskState,
  taskMachine,
} from '@mec/domain'
import { type Db, isUniqueViolation, type Tx } from '../../db/sql'
import { type ActorKind, appendEvent, projectStream } from '../../events/append'
import { conflict, notFound } from '../../http/errors'
import { enqueueCommand } from '../../outbox/commands'
import { transition } from '../state'
import { refreshReadiness } from '../tasks/readiness'

export interface AttemptRow {
  id: string
  projectId: string
  deliveryId: string
  taskId: string
  number: number
  kind: 'implement' | 'repair' | 'coordinator' | 'integration'
  state: AttemptState
  agentKind: AgentKind
  runnerId: string | null
  generation: number
  leaseExpiresAt: Date | null
  nativeSessionRef: string | null
  baseSha: string | null
  branch: string | null
  headSha: string | null
  inputs: Record<string, unknown>
  result: Record<string, unknown> | null
  blocker: Blocker | null
  lastSequence: number
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export interface TaskRow {
  id: string
  deliveryId: string
  key: string
  title: string
  spec: TaskSpec
  state: TaskState
  attemptsUsed: number
  ownerId: string | null
  blocker: Blocker | null
}

type Actor = { kind: ActorKind; id?: string | null }

export async function loadAttempt(db: Db, id: string, lock = false): Promise<AttemptRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Attempt')
  const [row] = lock
    ? await db<AttemptRow[]>`select * from attempts where id = ${id} for update`
    : await db<AttemptRow[]>`select * from attempts where id = ${id}`
  if (!row) throw notFound('Attempt')
  return row
}

export interface ClaimInput {
  taskId: string
  runnerId: string
  agentKind: AgentKind
  kind?: AttemptRow['kind']
  inputs: Record<string, unknown>
  actor: Actor
  leaseMs?: number
}

/**
 * The atomic claim (PDF §11): attempt row, lease, active slot and the dispatch command commit
 * together. A duplicate dispatch returns the existing attempt instead of starting a second one.
 */
export async function claimAttempt(
  tx: Tx,
  input: ClaimInput,
): Promise<{ attempt: AttemptRow; created: boolean }> {
  const [task] = await tx<(TaskRow & { projectId: string; deliveryState: string })[]>`
    select t.*, d.project_id, d.state as delivery_state
    from tasks t join deliveries d on d.id = t.delivery_id
    where t.id = ${input.taskId}
    for update of t
  `
  if (!task) throw notFound('Task')
  const [active] = await tx<AttemptRow[]>`
    select * from attempts where task_id = ${task.id} and state = any(${tx.array([...ACTIVE_ATTEMPT_STATES])})
  `
  if (active) return { attempt: active, created: false }
  if (task.state !== 'ready') throw conflict('task_not_ready', `Task ${task.key} is ${task.state}, not ready`)

  const [counter] = await tx<{ next: number }[]>`
    select coalesce(max(number), 0) + 1 as next from attempts where task_id = ${task.id}
  `
  let attempt: AttemptRow
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<AttemptRow[]>`
      insert into attempts (project_id, delivery_id, task_id, number, kind, agent_kind, inputs, created_by)
      values (${task.projectId}, ${task.deliveryId}, ${task.id}, ${counter!.next}, ${input.kind ?? 'implement'},
              ${input.agentKind}, ${tx.json(input.inputs as never)},
              ${input.actor.kind === 'user' ? (input.actor.id ?? null) : null})
      returning *
    `,
    )
    attempt = row!
  } catch (e) {
    if (isUniqueViolation(e)) {
      const [existing] = await tx<AttemptRow[]>`
        select * from attempts where task_id = ${task.id} and state = any(${tx.array([...ACTIVE_ATTEMPT_STATES])})
      `
      if (existing) return { attempt: existing, created: false }
    }
    throw e
  }

  const ctx = { projectId: task.projectId, deliveryId: task.deliveryId, taskId: task.id }
  await appendEvent(tx, {
    stream: projectStream(task.projectId),
    type: 'attempt.created',
    ...ctx,
    attemptId: attempt.id,
    actor: input.actor,
    payload: {
      number: attempt.number,
      agentKind: input.agentKind,
      runnerId: input.runnerId,
      kind: attempt.kind,
    },
  })
  const generation = 1
  await transition(tx, {
    table: 'attempts',
    machine: attemptMachine,
    id: attempt.id,
    from: 'queued',
    event: 'lease_granted',
    set: {
      runnerId: input.runnerId,
      generation,
      leaseExpiresAt: new Date(Date.now() + (input.leaseMs ?? LEASE_DEFAULTS.ttlMs)),
    },
    ...ctx,
    attemptId: attempt.id,
    actor: input.actor,
    payload: { runnerId: input.runnerId, generation },
  })
  await transition(tx, {
    table: 'tasks',
    machine: taskMachine,
    id: task.id,
    from: 'ready',
    event: 'attempt_started',
    set: { attemptsUsed: task.attemptsUsed + 1, blocker: null },
    ...ctx,
    actor: input.actor,
    payload: { attemptId: attempt.id },
  })
  if (task.deliveryState === 'approved') {
    await transition(tx, {
      table: 'deliveries',
      machine: deliveryMachine,
      id: task.deliveryId,
      from: 'approved',
      event: 'work_started',
      projectId: task.projectId,
      deliveryId: task.deliveryId,
      actor: input.actor,
    })
  }
  await enqueueCommand(tx, input.runnerId, {
    commandId: `${attempt.id}:g${generation}:start`,
    type: 'start',
    attemptId: attempt.id,
    generation,
    payload: {
      agentKind: input.agentKind,
      kind: attempt.kind,
      taskKey: task.key,
      taskTitle: task.title,
      spec: task.spec,
      inputs: input.inputs,
    },
  })
  return { attempt: await loadAttempt(tx, attempt.id), created: true }
}

/** Queues a control command (interrupt, cancel, message) for the attempt's current generation. */
export async function commandAttempt(
  tx: Tx,
  attempt: AttemptRow,
  type: 'interrupt' | 'cancel' | 'message',
  payload: Record<string, unknown>,
  actor: Actor,
): Promise<string> {
  if (!attempt.runnerId) throw conflict('not_dispatched', 'The attempt has no runner')
  const commandId = `${attempt.id}:g${attempt.generation}:${type}:${randomUUID()}`
  await enqueueCommand(tx, attempt.runnerId, {
    commandId,
    type,
    attemptId: attempt.id,
    generation: attempt.generation,
    payload,
  })
  await appendEvent(tx, {
    stream: projectStream(attempt.projectId),
    type: `attempt.${type}_requested`,
    projectId: attempt.projectId,
    deliveryId: attempt.deliveryId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    actor,
    payload: { commandId, ...payload },
  })
  return commandId
}

// ── Applying runner lifecycle events ───────────────────────────────────────────────────────

const LIFECYCLE: Record<string, (payload: Record<string, unknown>) => AttemptEvent> = {
  [RunnerEventType.preparing]: () => 'runner_accepted',
  [RunnerEventType.started]: () => 'agent_started',
  [RunnerEventType.inputRequested]: () => 'input_requested',
  [RunnerEventType.inputResolved]: () => 'input_resolved',
  [RunnerEventType.finished]: () => 'agent_finished',
  [RunnerEventType.checksStarted]: () => 'checks_started',
  [RunnerEventType.checksCompleted]: (p) => (p.passed === true ? 'checks_passed' : 'checks_failed'),
  [RunnerEventType.interrupted]: () => 'interrupt_confirmed',
  [RunnerEventType.quotaExhausted]: () => 'quota_exhausted',
  [RunnerEventType.authRequired]: () => 'auth_expired',
  [RunnerEventType.failed]: () => 'error',
  [RunnerEventType.cancelled]: () => 'cancel',
}

export function isLifecycleEvent(type: string): boolean {
  return type in LIFECYCLE
}

/**
 * Moves the attempt (and its task) according to a runner lifecycle event. Called only for events
 * from the current generation. A transition that does not fit the current state is ignored: the
 * evidence is already in the log, and the authoritative state is not corrupted.
 */
export async function applyLifecycle(
  tx: Tx,
  attempt: AttemptRow,
  env: RunnerEventEnvelope,
): Promise<AttemptState> {
  const toEvent = LIFECYCLE[env.type]
  if (!toEvent) return attempt.state
  let event = toEvent(env.payload)
  // A runner reporting that the process stopped is how a stalled attempt is reconciled.
  if (attempt.state === 'stalled' && event === 'interrupt_confirmed') event = 'runner_reconciled_stopped'
  const check = attemptMachine.transition(attempt.state, event)
  if (!check.ok) return attempt.state

  const set: Record<string, unknown> = {}
  const p = env.payload
  if (event === 'agent_started') set.startedAt = attempt.startedAt ?? new Date(env.occurredAt)
  if (typeof p.nativeSessionRef === 'string') set.nativeSessionRef = p.nativeSessionRef
  if (typeof p.headSha === 'string') set.headSha = p.headSha
  if (typeof p.baseSha === 'string') set.baseSha = p.baseSha
  if (typeof p.branch === 'string') set.branch = p.branch
  if (attemptMachine.terminal.includes(check.value)) {
    set.finishedAt = new Date(env.occurredAt)
    set.leaseExpiresAt = null
    set.result = tx.json(p as never)
  }
  if (check.value === 'quota_wait' || check.value === 'auth_required') {
    const blocker: Blocker = {
      kind: check.value === 'quota_wait' ? 'quota' : 'auth',
      detail: String(p.detail ?? p.reason ?? check.value),
      refs: [],
    }
    set.blocker = tx.json(blocker as never)
  }

  const to = await transition(tx, {
    table: 'attempts',
    machine: attemptMachine,
    id: attempt.id,
    from: attempt.state,
    event,
    set,
    projectId: attempt.projectId,
    deliveryId: attempt.deliveryId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    actor: { kind: 'runner', id: attempt.runnerId },
    payload: { generation: env.generation },
  })
  await followTask(tx, { ...attempt, state: to }, to)
  return to
}

/** Task consequences of an attempt reaching a terminal or parked state. */
export async function followTask(tx: Tx, attempt: AttemptRow, to: AttemptState): Promise<void> {
  const [task] = await tx<TaskRow[]>`select * from tasks where id = ${attempt.taskId} for update`
  if (!task || task.state !== 'active') return
  const ctx = {
    projectId: attempt.projectId,
    deliveryId: attempt.deliveryId,
    taskId: task.id,
    actor: { kind: 'system' as const },
    payload: { attemptId: attempt.id },
  }
  if (to === 'succeeded') {
    await transition(tx, {
      table: 'tasks',
      machine: taskMachine,
      id: task.id,
      from: 'active',
      event: 'attempt_succeeded',
      ...ctx,
    })
  } else if (to === 'checks_failed' || to === 'failed' || to === 'cancelled') {
    const retryable = task.attemptsUsed < (task.spec.maxAttempts ?? 2)
    await transition(tx, {
      table: 'tasks',
      machine: taskMachine,
      id: task.id,
      from: 'active',
      event: retryable ? 'attempt_failed_retryable' : 'attempt_failed_final',
      set: {
        blocker: retryable
          ? null
          : tx.json({
              kind: 'decision',
              detail: 'All attempts used; a person must retry or cancel',
              refs: [],
            } as never),
      },
      ...ctx,
    })
    if (retryable) await refreshReadiness(tx, { id: attempt.deliveryId, projectId: attempt.projectId })
  } else if (to === 'quota_wait' || to === 'auth_required') {
    const blocker: Blocker = {
      kind: to === 'quota_wait' ? 'quota' : 'auth',
      detail:
        to === 'quota_wait'
          ? 'Agent quota exhausted; work preserved'
          : 'Agent sign-in required; work preserved',
      refs: [attempt.id],
    }
    await tx`update tasks set blocker = ${tx.json(blocker as never)}, updated_at = now() where id = ${task.id}`
  }
}
