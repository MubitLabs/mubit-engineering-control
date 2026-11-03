import { z } from 'zod'
import { IsoTime, Json } from './common'

/*
 * The effects queue (CONTRACTS §7): core turns each decision into a row inside the current
 * transaction, and handlers drain the rows after commit. Stream B registers handlers for
 * launch, deliver and probe; Stream A for relay, note, reply and external.
 */

export const EffectKind = z.enum(['launch', 'deliver', 'relay', 'note', 'reply', 'external', 'probe'])

/** Where a job is: `waiting` is a `Later` deferral, not a failure; `failed` means attempts are exhausted. */
export const EffectState = z.enum(['pending', 'running', 'waiting', 'failed'])

/** The persisted row the queue drains; one per kind + key, coalesced on re-enqueue. */
export const EffectJob = z.strictObject({
  kind: EffectKind,
  key: z.string().min(1),
  payload: Json,
  /** Failed runs so far; a `Later` deferral does not count. */
  attempts: z.int().min(0),
  /** When the queue may next run the job. */
  next_run_at: IsoTime,
  /** Why the last run failed, if it did. */
  last_error: z.string().optional(),
})

/** A handler throws `Later` to defer its job without the queue counting a failure (CONTRACTS §7). */
export class Later extends Error {}

export interface Effects {
  /**
   * Adds a job; must run inside `Store.atomic`. One row per kind + key: enqueuing an existing
   * pair coalesces — the payload is replaced and no second row appears.
   */
  enqueue(kind: EffectKind, key: string, payload: Json): void
  /**
   * Registers the handler that drains jobs of `kind`. `concurrency` is how many jobs of the kind
   * may run at once; `ordered` runs them in enqueue order instead.
   */
  handle(
    kind: EffectKind,
    run: (payload: Json) => Promise<void>,
    opts: { concurrency: number; ordered?: boolean },
  ): void
}

export type EffectKind = z.infer<typeof EffectKind>
export type EffectState = z.infer<typeof EffectState>
export type EffectJob = z.infer<typeof EffectJob>
