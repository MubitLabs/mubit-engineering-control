import type { Machine } from '@mec/domain'
import type { Tx } from '../db/sql'
import { type ActorKind, appendEvent, projectStream } from '../events/append'
import { conflict, HttpError } from '../http/errors'

type StatefulTable = 'deliveries' | 'plan_revisions' | 'tasks' | 'attempts'

const ENTITY: Record<StatefulTable, string> = {
  deliveries: 'delivery',
  plan_revisions: 'plan',
  tasks: 'task',
  attempts: 'attempt',
}

export interface TransitionSpec<S extends string, E extends string> {
  table: StatefulTable
  machine: Machine<S, E>
  id: string
  from: S
  event: E
  /** Extra columns to set (camelCase keys). */
  set?: Record<string, unknown>
  projectId: string
  deliveryId?: string | null
  taskId?: string | null
  attemptId?: string | null
  actor: { kind: ActorKind; id?: string | null }
  payload?: Record<string, unknown>
}

/**
 * The one way state changes are written: validate with the domain machine, compare-and-set on the
 * expected current state, and append the event in the same transaction.
 */
export async function transition<S extends string, E extends string>(
  tx: Tx,
  spec: TransitionSpec<S, E>,
): Promise<S> {
  const next = spec.machine.transition(spec.from, spec.event)
  if (!next.ok) throw new HttpError(409, 'invalid_transition', next.error.message)
  const to = next.value
  const columns = { ...(spec.set ?? {}), state: to }
  const rows = await tx`
    update ${tx(spec.table)} set ${tx(columns)}, updated_at = now()
    where id = ${spec.id} and state = ${spec.from}
    returning id
  `
  if (rows.length === 0) {
    throw conflict('state_changed', `${ENTITY[spec.table]} ${spec.id} is no longer '${spec.from}'`)
  }
  await appendEvent(tx, {
    stream: projectStream(spec.projectId),
    type: `${ENTITY[spec.table]}.state_changed`,
    projectId: spec.projectId,
    deliveryId: spec.deliveryId ?? null,
    taskId: spec.taskId ?? null,
    attemptId: spec.attemptId ?? null,
    actor: spec.actor,
    payload: { id: spec.id, from: spec.from, to, event: spec.event, ...(spec.payload ?? {}) },
  })
  return to
}
