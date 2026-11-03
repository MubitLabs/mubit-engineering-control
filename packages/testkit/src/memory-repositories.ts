/**
 * An in-memory `Store` double (CONTRACTS §7): the seven repositories, the per-stream event log,
 * the effects queue and `atomic` with nested rollback, so Stream B's unit tests need no SQLite.
 *
 * - `atomic(fn)` takes a savepoint — a deep copy of every tracked document — before running `fn`.
 *   A throw restores that savepoint and rethrows: an inner rollback undoes only the writes of the
 *   inner block, while an outer throw rolls back every level inside it. `commits` counts the
 *   transactions that reached the outermost commit.
 * - `afterCommit(fn)` queues a callback that runs exactly once, when the OUTERMOST transaction
 *   commits, in queue order. A rollback at any level discards everything queued inside it.
 *   Outside a transaction it runs immediately.
 * - `events.append(stream, event)` enforces a gap-free, strictly increasing `seq` per stream: the
 *   next event's seq must be exactly last + 1, starting at 1. Appends inside a rolled-back
 *   transaction vanish with it, so their seq numbers are reusable.
 * - `effects.enqueue` is transactional and coalesces to one row per kind + key, as the contract
 *   says; `handle` records the registration but never drains — a test that needs drained effects
 *   drives the handler itself.
 * - Writes outside `atomic` behave like autocommit; only `atomic` can roll back.
 */
import type {
  DomainEvent,
  EffectJob,
  EffectKind,
  Effects,
  EventStore,
  Json,
  Repository,
  Store,
  StoreDoc,
} from '@mec/contracts'

const clone = <T>(value: T): T => structuredClone(value)

export type RepositoryName =
  | 'workItems'
  | 'tasks'
  | 'attempts'
  | 'messages'
  | 'confirmations'
  | 'slots'
  | 'engines'

export type RepositoriesSnapshot = { [name in RepositoryName]: StoreDoc[] } & {
  events: Record<string, DomainEvent[]>
  effects: EffectJob[]
}

type Savepoint = {
  rows: Record<RepositoryName, Array<[string, StoreDoc]>>
  events: Record<string, DomainEvent[]>
  effects: Array<[string, EffectJob]>
  afterCommit: number
}

/** One table's rows (CONTRACTS §7: get, save, list); upserts by the document's string `id`. */
class MemoryRepository implements Repository<StoreDoc> {
  readonly #rows = new Map<string, StoreDoc>()

  get(id: string): StoreDoc | undefined {
    const row = this.#rows.get(id)
    return row === undefined ? undefined : clone(row)
  }

  save(doc: StoreDoc): void {
    const id = doc.id
    if (typeof id !== 'string') throw new Error('a stored document needs a string id to upsert on')
    this.#rows.set(id, clone(doc))
  }

  list(filter?: Record<string, unknown>): StoreDoc[] {
    if (filter === undefined) return [...this.#rows.values()].map((row) => clone(row))
    return [...this.#rows.values()]
      .filter((row) => Object.keys(filter).every((key) => row[key] === filter[key]))
      .map((row) => clone(row))
  }

  snapshot(): Array<[string, StoreDoc]> {
    return [...this.#rows].map(([id, row]) => [id, clone(row)])
  }

  restore(rows: Array<[string, StoreDoc]>): void {
    this.#rows.clear()
    for (const [id, row] of rows) this.#rows.set(id, row)
  }
}

class MemoryEventLog implements EventStore {
  #streams = new Map<string, DomainEvent[]>()

  append(stream: string, event: DomainEvent): void {
    const events = this.#streams.get(stream)
    const last = events?.at(-1)?.seq ?? 0
    if (event.seq !== last + 1) {
      const reason =
        event.seq <= last
          ? `seq ${event.seq} repeats or goes backwards after ${last}`
          : `seq ${event.seq} leaves a gap after ${last}`
      throw new Error(`events on stream '${stream}' must be gap-free and increasing: ${reason}`)
    }
    this.#streams.set(stream, [...(events ?? []), { ...clone(event), stream }])
  }

  read(stream: string, after?: number): DomainEvent[] {
    const events = this.#streams.get(stream)
    if (events === undefined) return []
    const cursor = after ?? 0
    return events.filter((event) => event.seq > cursor).map((event) => clone(event))
  }

  snapshot(): Record<string, DomainEvent[]> {
    return Object.fromEntries(
      [...this.#streams].map(([stream, events]) => [stream, events.map((event) => clone(event))]),
    )
  }

  restore(streams: Record<string, DomainEvent[]>): void {
    this.#streams = new Map(Object.entries(streams))
  }
}

/** Transactional, coalescing, never drained: a recording double of the effects queue (§7). */
class MemoryEffects implements Effects {
  readonly #rows = new Map<string, EffectJob>()
  readonly #handlers = new Map<
    EffectKind,
    { run: (payload: Json) => Promise<void>; opts: { concurrency: number; ordered?: boolean } }
  >()
  readonly #inAtomic: () => boolean

  constructor(inAtomic: () => boolean) {
    this.#inAtomic = inAtomic
  }

  enqueue(kind: EffectKind, key: string, payload: Json): void {
    if (!this.#inAtomic()) {
      throw new Error('effects.enqueue must run inside Store.atomic (CONTRACTS §7)')
    }
    const id = `${kind}:${key}`
    const existing = this.#rows.get(id)
    this.#rows.set(id, {
      kind,
      key,
      payload: clone(payload),
      attempts: existing?.attempts ?? 0,
      next_run_at: existing?.next_run_at ?? new Date().toISOString(),
      last_error: existing?.last_error,
    })
  }

  handle(
    kind: EffectKind,
    run: (payload: Json) => Promise<void>,
    opts: { concurrency: number; ordered?: boolean },
  ): void {
    this.#handlers.set(kind, { run, opts })
  }

  snapshot(): Array<[string, EffectJob]> {
    return [...this.#rows].map(([id, row]) => [id, clone(row)])
  }

  restore(rows: Array<[string, EffectJob]>): void {
    this.#rows.clear()
    for (const [id, row] of rows) this.#rows.set(id, row)
  }
}

export class MemoryRepositories implements Store {
  /** How many transactions reached their outermost commit. */
  commits = 0

  readonly #repos: Record<RepositoryName, MemoryRepository> = {
    workItems: new MemoryRepository(),
    tasks: new MemoryRepository(),
    attempts: new MemoryRepository(),
    messages: new MemoryRepository(),
    confirmations: new MemoryRepository(),
    slots: new MemoryRepository(),
    engines: new MemoryRepository(),
  }

  readonly #events = new MemoryEventLog()
  readonly #effects = new MemoryEffects(() => this.#depth > 0)

  #depth = 0
  #afterCommitQueue: Array<() => void> = []

  get workItems(): Repository<StoreDoc> {
    return this.#repos.workItems
  }

  get tasks(): Repository<StoreDoc> {
    return this.#repos.tasks
  }

  get attempts(): Repository<StoreDoc> {
    return this.#repos.attempts
  }

  get messages(): Repository<StoreDoc> {
    return this.#repos.messages
  }

  get confirmations(): Repository<StoreDoc> {
    return this.#repos.confirmations
  }

  get slots(): Repository<StoreDoc> {
    return this.#repos.slots
  }

  get engines(): Repository<StoreDoc> {
    return this.#repos.engines
  }

  get events(): EventStore {
    return this.#events
  }

  get effects(): Effects {
    return this.#effects
  }

  atomic<T>(fn: () => T): T {
    const savepoint = this.#capture()
    this.#depth += 1
    let committed = false
    try {
      const result = fn()
      committed = true
      return result
    } finally {
      this.#depth -= 1
      if (!committed) {
        this.#restore(savepoint)
      } else if (this.#depth === 0) {
        this.commits += 1
        const callbacks = this.#afterCommitQueue
        this.#afterCommitQueue = []
        for (const callback of callbacks) callback()
      }
    }
  }

  /** Queues `callback` for the outermost commit; a rollback anywhere on the way out drops it. */
  afterCommit(fn: () => void): void {
    if (this.#depth === 0) {
      fn()
      return
    }
    this.#afterCommitQueue.push(fn)
  }

  /** A deep copy of everything tracked, for assertions; mutating it never touches the store. */
  snapshot(): RepositoriesSnapshot {
    const rows = {} as Record<RepositoryName, StoreDoc[]>
    for (const [name, repo] of Object.entries(this.#repos)) {
      rows[name as RepositoryName] = repo.list()
    }
    return {
      ...rows,
      events: this.#events.snapshot(),
      effects: this.#effects.snapshot().map(([, row]) => row),
    }
  }

  #capture(): Savepoint {
    const rows = {} as Record<RepositoryName, Array<[string, StoreDoc]>>
    for (const [name, repo] of Object.entries(this.#repos)) {
      rows[name as RepositoryName] = repo.snapshot()
    }
    return {
      rows,
      events: this.#events.snapshot(),
      effects: this.#effects.snapshot(),
      afterCommit: this.#afterCommitQueue.length,
    }
  }

  #restore(savepoint: Savepoint): void {
    for (const [name, rows] of Object.entries(savepoint.rows)) {
      this.#repos[name as RepositoryName].restore(rows)
    }
    this.#events.restore(savepoint.events)
    this.#effects.restore(savepoint.effects)
    this.#afterCommitQueue.length = savepoint.afterCommit
  }
}
