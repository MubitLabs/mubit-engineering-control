import { z } from 'zod'
import { IsoTime, Json } from './common'
import type { Effects } from './effects'

/*
 * The persistence seam between the streams (CONTRACTS §7). Stream A implements it over SQLite;
 * `MemoryRepositories` (packages/testkit) mirrors the ordering and nested rollback so Stream B's
 * unit tests need no SQLite. The interface is synchronous on purpose.
 */

/** The append-only row behind `events`; `seq` is gap-free from 1 within a stream, so readers can resume by seq. */
export const DomainEvent = z.strictObject({
  stream: z.string().min(1),
  /** Gap-free from 1 per stream: `append` writes exactly last + 1, never a gap or a regression. */
  seq: z.int().min(1),
  at: IsoTime,
  type: z.string().min(1),
  body: Json,
})

/**
 * One table's rows (CONTRACTS §7: get, save, list). Filters stay loose on purpose —
 * `Record<string, unknown>` — until `packages/domain` lands typed queries.
 */
export interface Repository<T> {
  /** `undefined` when the id does not exist; the API layer answers that with `missing` (§8). */
  get(id: string): T | undefined
  save(doc: T): void
  list(filter?: Record<string, unknown>): T[]
}

/** Every stored row is a JSON document until `packages/domain` lands typed rows. */
export type StoreDoc = Record<string, Json>

export interface EventStore {
  /** Writes `event` as the stream's next `seq`; a gap or a regression throws. */
  append(stream: string, event: DomainEvent): void
  /** Reads the stream in `seq` order; with `after`, only events with a greater `seq`. */
  read(stream: string, after?: number): DomainEvent[]
}

export interface Store {
  /**
   * Runs `fn` in one transaction. Nested `atomic` calls join the outermost transaction: a throw
   * unwinds every write since that transaction began (nested rollback) and propagates; a return
   * commits. Register release-time side effects with `afterCommit` — they run only on commit.
   */
  atomic<T>(fn: () => T): T
  /** Runs `fn` after the outermost `atomic` commits; dropped on rollback. Call it inside a transaction. */
  afterCommit(fn: () => void): void
  workItems: Repository<StoreDoc>
  tasks: Repository<StoreDoc>
  attempts: Repository<StoreDoc>
  messages: Repository<StoreDoc>
  confirmations: Repository<StoreDoc>
  slots: Repository<StoreDoc>
  engines: Repository<StoreDoc>
  events: EventStore
  effects: Effects
}

export type DomainEvent = z.infer<typeof DomainEvent>
