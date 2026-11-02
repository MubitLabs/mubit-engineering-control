import {
  ACTIVE_ATTEMPT_STATES,
  type Candidate,
  type Limits,
  type Load,
  planDispatches,
  type RunnerSlot,
} from '@mec/domain'
import type { Db, Tx } from '../../db/sql'
import { conflict } from '../../http/errors'

/** Serialises every claim so limit checks and slot reservations cannot interleave. */
export async function dispatchLock(tx: Tx): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext('mec.dispatch'))`
}

export async function dispatchPaused(db: Db): Promise<boolean> {
  const [row] = await db<{ value: { dispatchPaused?: boolean } }[]>`
    select value from settings where key = 'dispatch'
  `
  return row?.value.dispatchPaused === true
}

/** Current load: every attempt holding a slot, including stalled ones awaiting reconciliation. */
export async function currentLoad(db: Db): Promise<Load> {
  const rows = await db<{ deliveryId: string; ownerId: string; profileId: string | null }[]>`
    select a.delivery_id, r.owner_id, t.spec->>'executionProfileId' as profile_id
    from attempts a
    join runners r on r.id = a.runner_id
    join tasks t on t.id = a.task_id
    where a.state = any(${db.array([...ACTIVE_ATTEMPT_STATES])})
  `
  const count = (key: (r: (typeof rows)[number]) => string | null) => {
    const out: Record<string, number> = {}
    for (const r of rows) {
      const k = key(r)
      if (k) out[k] = (out[k] ?? 0) + 1
    }
    return out
  }
  return {
    total: rows.length,
    byEmployee: count((r) => r.ownerId),
    byDelivery: count((r) => r.deliveryId),
    byProfile: count((r) => r.profileId),
  }
}

/** Runners that can take work: connected, not draining, not revoked. */
export async function runnerSlots(db: Db, connectedIds: string[]): Promise<RunnerSlot[]> {
  if (connectedIds.length === 0) return []
  const rows = await db<
    {
      id: string
      name: string
      ownerId: string
      capacity: { maxAttempts?: number }
      agents: { kind: string; available: boolean }[]
      active: number
    }[]
  >`
    select r.id, r.name, r.owner_id, r.capacity, r.agents,
      (select count(*)::int from attempts a where a.runner_id = r.id
         and a.state = any(${db.array([...ACTIVE_ATTEMPT_STATES])})) as active
    from runners r
    where r.id = any(${db.array(connectedIds)}::uuid[]) and not r.draining and r.revoked_at is null
  `
  return rows.map((r) => ({
    runnerId: r.id,
    name: r.name,
    ownerId: r.ownerId,
    active: r.active,
    capacity: r.capacity.maxAttempts ?? 1,
    agentKinds: r.agents.filter((a) => a.available).map((a) => a.kind),
  }))
}

/**
 * Re-checks one claim against the live snapshot inside the claim transaction (under the
 * dispatch lock). Throws 409 with the limit that would be exceeded.
 */
export async function assertCapacity(
  tx: Tx,
  candidate: Candidate,
  runnerId: string,
  connectedIds: string[],
  limits: Limits,
): Promise<void> {
  const slots = (await runnerSlots(tx, connectedIds)).filter((r) => r.runnerId === runnerId)
  const plan = planDispatches([{ ...candidate, runnerId }], slots, await currentLoad(tx), limits)
  const held = plan.held[0]
  if (held) throw conflict('capacity', `Cannot start now: ${held.detail}`, { limit: held.limit })
}
