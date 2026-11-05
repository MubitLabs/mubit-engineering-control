/**
 * The SQLite store (CONTRACTS §7, plan §17): one writer, WAL, and everything a command touches
 * inside one transaction. Documents live in the `docs` table as json keyed by id with a `kind`
 * column per collection; the `events` table is the append-only, gap-free-per-stream source of
 * truth; the `effects` table is the queue (see effects-queue.ts).
 *
 * `atomic` nests through savepoints sp_0…sp_n: an inner throw rolls back to its savepoint only,
 * an outer throw rolls back everything, and the outermost release commits. Callbacks registered
 * with `afterCommit` run after that outermost commit — and only then; a rollback discards the
 * callbacks registered inside the aborted scope.
 */

import type { DomainEvent, EventStore, Json, Repository, Store, StoreDoc } from '@mec/contracts'
import type Database from 'better-sqlite3'
import { EffectsQueue } from './effects-queue'

/** A stream seq that leaves a gap or repeats what the stream already holds. */
export class EventSequenceError extends Error {}

/** A save naming an id another collection already holds; it would replace that row's json. */
export class DocKindCollisionError extends Error {}

export interface SqliteStoreOptions {
  now?: () => Date
}

/** The `docs.kind` value backing each repository; the §0 id prefixes name the same collections. */
const DOC_KINDS = {
  workItems: 'work_item',
  tasks: 'task',
  attempts: 'attempt',
  messages: 'message',
  confirmations: 'confirmation',
  slots: 'slot',
  engines: 'engine',
} as const

export class SqliteStore implements Store {
  readonly workItems: Repository<StoreDoc>
  readonly tasks: Repository<StoreDoc>
  readonly attempts: Repository<StoreDoc>
  readonly messages: Repository<StoreDoc>
  readonly confirmations: Repository<StoreDoc>
  readonly slots: Repository<StoreDoc>
  readonly engines: Repository<StoreDoc>
  readonly events: EventStore
  readonly effects: EffectsQueue

  private depth = 0
  private afterCommitQueue: Array<() => void> = []

  constructor(
    readonly db: Database.Database,
    opts?: SqliteStoreOptions,
  ) {
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    const now = opts?.now ?? (() => new Date())
    this.workItems = new DocsRepository(this.db, DOC_KINDS.workItems, now)
    this.tasks = new DocsRepository(this.db, DOC_KINDS.tasks, now)
    this.attempts = new DocsRepository(this.db, DOC_KINDS.attempts, now)
    this.messages = new DocsRepository(this.db, DOC_KINDS.messages, now)
    this.confirmations = new DocsRepository(this.db, DOC_KINDS.confirmations, now)
    this.slots = new DocsRepository(this.db, DOC_KINDS.slots, now)
    this.engines = new DocsRepository(this.db, DOC_KINDS.engines, now)
    this.events = new SqliteEventLog(this)
    this.effects = new EffectsQueue(this.db, { now })
  }

  /**
   * Runs `fn` inside savepoint `sp_<depth>`: nesting composes, an inner throw rolls back only the
   * inner scope, and releasing the outermost savepoint commits. When no transaction was opened
   * outside the store, that release makes the writes durable and the afterCommit queue flushes.
   */
  atomic<T>(fn: () => T): T {
    const level = this.depth
    const queueBase = this.afterCommitQueue.length
    this.db.exec(`SAVEPOINT sp_${level}`)
    this.depth += 1
    let result: T
    try {
      result = fn()
    } catch (error) {
      this.depth -= 1
      this.afterCommitQueue.length = queueBase // Discard callbacks registered in the aborted scope.
      this.db.exec(`ROLLBACK TO SAVEPOINT sp_${level}`)
      this.db.exec(`RELEASE SAVEPOINT sp_${level}`)
      throw error
    }
    this.depth -= 1
    this.db.exec(`RELEASE SAVEPOINT sp_${level}`)
    if (level === 0 && !this.db.inTransaction) this.flushAfterCommit()
    return result
  }

  /**
   * Runs `fn` once the outermost atomic commits. Inside `atomic` a rollback discards it; outside
   * any store transaction the preceding writes already autocommitted, so it runs at once.
   */
  afterCommit(fn: () => void): void {
    if (this.depth === 0) {
      fn()
      return
    }
    this.afterCommitQueue.push(fn)
  }

  private flushAfterCommit(): void {
    const callbacks = this.afterCommitQueue
    this.afterCommitQueue = []
    for (const callback of callbacks) callback()
  }
}

class DocsRepository implements Repository<StoreDoc> {
  private readonly upsert: Database.Statement<[string, string, string, string], unknown>
  private readonly byId: Database.Statement<[string], { json: string }>
  private readonly byKind: Database.Statement<[string], { json: string }>

  constructor(
    db: Database.Database,
    private readonly kind: string,
    private readonly now: () => Date,
  ) {
    this.upsert = db.prepare(
      `INSERT INTO docs (id, kind, json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
       WHERE docs.kind = excluded.kind`,
    )
    this.byId = db.prepare('SELECT json FROM docs WHERE id = ?')
    this.byKind = db.prepare('SELECT json FROM docs WHERE kind = ? ORDER BY rowid')
  }

  get(id: string): StoreDoc | undefined {
    const row = this.byId.get(id)
    return row === undefined ? undefined : (JSON.parse(row.json) as StoreDoc)
  }

  save(doc: StoreDoc): void {
    const id = doc.id
    if (typeof id !== 'string') throw new Error('mec: a stored document must carry a string id')
    const { changes } = this.upsert.run(id, this.kind, JSON.stringify(doc), this.now().toISOString())
    if (changes === 0) throw new DocKindCollisionError(`mec: ${id} is already stored as another kind`)
  }

  list(filter?: Record<string, unknown>): StoreDoc[] {
    const docs = this.byKind.all(this.kind).map((row) => JSON.parse(row.json) as StoreDoc)
    if (filter === undefined) return docs
    return docs.filter((doc) => shallowMatch(doc, filter))
  }
}

/** Shallow equality over the parsed json: every top-level filter field must match exactly. */
function shallowMatch(doc: StoreDoc, filter: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    if (doc[field] !== expected) return false
  }
  return true
}

interface EventRow {
  stream: string
  seq: number
  at: string
  type: string
  body: string | null
}

class SqliteEventLog implements EventStore {
  private readonly insert: Database.Statement<[string, number, string, string, string], unknown>
  private readonly maxSeq: Database.Statement<[string], { seq: number | null }>
  private readonly afterSeq: Database.Statement<[string, number], EventRow>
  constructor(private readonly store: SqliteStore) {
    this.insert = store.db.prepare('INSERT INTO events (stream, seq, at, type, body) VALUES (?, ?, ?, ?, ?)')
    this.maxSeq = store.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE stream = ?')
    this.afterSeq = store.db.prepare(
      'SELECT stream, seq, at, type, body FROM events WHERE stream = ? AND seq > ? ORDER BY seq',
    )
  }

  /**
   * Gap-free per stream: `seq` must be exactly last + 1, checked and written in one
   * transaction. The full event shape — stream included — is persisted, keyed by the stream
   * argument, and `read` hands it back whole.
   */
  append(stream: string, event: DomainEvent): void {
    this.store.atomic(() => {
      const last = this.maxSeq.get(stream)?.seq ?? 0
      if (event.seq !== last + 1) {
        throw new EventSequenceError(`mec: stream ${stream} expects seq ${last + 1} but got ${event.seq}`)
      }
      this.insert.run(stream, event.seq, event.at, event.type, JSON.stringify(event.body))
    })
  }

  read(stream: string, after?: number): DomainEvent[] {
    return this.afterSeq.all(stream, after ?? 0).map((row) => ({
      stream: row.stream,
      seq: row.seq,
      at: row.at,
      type: row.type,
      body: (row.body === null ? null : JSON.parse(row.body)) as Json,
    }))
  }
}
