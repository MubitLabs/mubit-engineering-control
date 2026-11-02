import type { Db, Tx } from '../db/sql'

export type ActorKind = 'user' | 'runner' | 'system' | 'agent'

export interface NewEvent {
  stream: string
  type: string
  projectId?: string | null
  deliveryId?: string | null
  taskId?: string | null
  attemptId?: string | null
  actor: { kind: ActorKind; id?: string | null }
  payload?: Record<string, unknown>
  source?: { runnerId: string; eventId: string; sequence: number; generation: number }
  occurredAt?: Date
}

export interface StoredEvent {
  id: number
  stream: string
  seq: number
  type: string
  projectId: string | null
  deliveryId: string | null
  taskId: string | null
  attemptId: string | null
  actorKind: ActorKind
  actorId: string | null
  payload: Record<string, unknown>
  occurredAt: Date
  recordedAt: Date
}

export const projectStream = (projectId: string) => `project:${projectId}`
export const FLEET_STREAM = 'fleet'
export const EVENTS_CHANNEL = 'mec_events'

/**
 * Appends one event. Must run inside the transaction that made the state change it records.
 * The upsert on event_streams takes a row lock, so seq order equals commit order per stream.
 * pg_notify is transactional: listeners hear about the event only after commit.
 */
export async function appendEvent(tx: Tx, e: NewEvent): Promise<{ id: number; seq: number }> {
  const [stream] = await tx<{ lastSeq: number }[]>`
    insert into event_streams (stream, last_seq) values (${e.stream}, 1)
    on conflict (stream) do update set last_seq = event_streams.last_seq + 1
    returning last_seq
  `
  const seq = stream!.lastSeq
  const [row] = await tx<{ id: number }[]>`
    insert into events (
      stream, seq, type, project_id, delivery_id, task_id, attempt_id, actor_kind, actor_id, payload,
      source_runner_id, source_event_id, source_sequence, source_generation, occurred_at
    ) values (
      ${e.stream}, ${seq}, ${e.type}, ${e.projectId ?? null}, ${e.deliveryId ?? null}, ${e.taskId ?? null},
      ${e.attemptId ?? null}, ${e.actor.kind}, ${e.actor.id ?? null}, ${tx.json((e.payload ?? {}) as never)},
      ${e.source?.runnerId ?? null}, ${e.source?.eventId ?? null}, ${e.source?.sequence ?? null},
      ${e.source?.generation ?? null}, ${e.occurredAt ?? new Date()}
    )
    returning id
  `
  await tx`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({ stream: e.stream, seq })})`
  return { id: row!.id, seq }
}

export async function readStream(
  db: Db,
  stream: string,
  afterSeq: number,
  limit = 500,
): Promise<StoredEvent[]> {
  return db<StoredEvent[]>`
    select id, stream, seq, type, project_id, delivery_id, task_id, attempt_id, actor_kind, actor_id,
           payload, occurred_at, recorded_at
    from events
    where stream = ${stream} and seq > ${afterSeq}
    order by seq
    limit ${limit}
  `
}

/** The latest sequence number in a stream (0 if it has no events yet). */
export async function streamHead(db: Db, stream: string): Promise<number> {
  const [row] = await db<{ lastSeq: number }[]>`select last_seq from event_streams where stream = ${stream}`
  return row?.lastSeq ?? 0
}
