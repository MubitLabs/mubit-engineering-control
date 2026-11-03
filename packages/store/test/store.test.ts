import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DomainEvent } from '@mec/contracts'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_v1, migrate } from '../src/migrations'
import { EventSequenceError, SqliteStore } from '../src/store'

let dir: string
let db: Database.Database
let store: SqliteStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mec-store-'))
  db = new Database(join(dir, 'state.db'))
  migrate(db, MIGRATIONS_v1)
  store = new SqliteStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function event(stream: string, seq: number, type = 'work_item.opened'): DomainEvent {
  return { stream, seq, at: new Date().toISOString(), type, body: { seq } }
}

describe('sqlite store', () => {
  it('opens in WAL with foreign keys on', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('an inner throw rolls back only the inner savepoint', () => {
    store.atomic(() => {
      store.workItems.save({ id: 'wi_1', state: 'open' })
      let innerThrew = false
      try {
        store.atomic(() => {
          store.workItems.save({ id: 'wi_2', state: 'open' })
          throw new Error('inner boom')
        })
      } catch {
        innerThrew = true
      }
      expect(innerThrew).toBe(true)
      // The inner scope's write is gone; the outer scope's write survives the inner rollback.
      expect(store.workItems.get('wi_2')).toBeUndefined()
      expect(store.workItems.get('wi_1')).toEqual({ id: 'wi_1', state: 'open' })
    })
    expect(store.workItems.get('wi_1')).toBeDefined()
    expect(store.workItems.list()).toHaveLength(1)
  })

  it('an outer throw rolls back everything, inner commits included', () => {
    expect(() =>
      store.atomic(() => {
        store.workItems.save({ id: 'wi_1', state: 'open' })
        store.atomic(() => store.workItems.save({ id: 'wi_2', state: 'open' }))
        store.events.append('work:wi_1', event('work:wi_1', 1))
        throw new Error('outer boom')
      }),
    ).toThrow('outer boom')
    expect(store.workItems.get('wi_1')).toBeUndefined()
    expect(store.workItems.get('wi_2')).toBeUndefined()
    expect(store.events.read('work:wi_1')).toEqual([])
  })

  it('afterCommit runs only on the outermost commit', () => {
    const fired: string[] = []
    store.atomic(() => {
      store.afterCommit(() => fired.push('outer'))
      store.atomic(() => store.afterCommit(() => fired.push('inner')))
      // An inner release is not a commit: nothing has fired yet.
      expect(fired).toEqual([])
    })
    expect(fired).toEqual(['outer', 'inner'])
  })

  it('a rolled-back scope discards the afterCommit callbacks registered inside it', () => {
    const fired: string[] = []
    store.atomic(() => {
      store.afterCommit(() => fired.push('outer'))
      try {
        store.atomic(() => {
          store.afterCommit(() => fired.push('inner-lost'))
          throw new Error('inner boom')
        })
      } catch {
        // The inner rollback is handled here; the outer scope continues and commits.
      }
    })
    expect(fired).toEqual(['outer'])
    expect(() =>
      store.atomic(() => {
        store.afterCommit(() => fired.push('outer-lost'))
        throw new Error('outer boom')
      }),
    ).toThrow('outer boom')
    expect(fired).toEqual(['outer'])
  })

  it('afterCommit outside any transaction runs at once', () => {
    const fired: string[] = []
    store.afterCommit(() => fired.push('now'))
    expect(fired).toEqual(['now'])
  })

  it('repositories upsert, get and list with a shallow-equality filter', () => {
    expect(store.workItems.get('wi_none')).toBeUndefined()
    store.workItems.save({ id: 'wi_1', state: 'open', engine: 'claude' })
    store.workItems.save({ id: 'wi_2', state: 'working', engine: 'claude' })
    store.workItems.save({ id: 'wi_3', state: 'open', engine: 'codex' })
    store.workItems.save({ id: 'wi_1', state: 'held', engine: 'claude' }) // upsert

    expect(store.workItems.get('wi_1')).toEqual({ id: 'wi_1', state: 'held', engine: 'claude' })
    expect(store.workItems.list().map((doc) => doc.id)).toEqual(['wi_1', 'wi_2', 'wi_3'])
    expect(store.workItems.list({ state: 'open' }).map((doc) => doc.id)).toEqual(['wi_3'])
    expect(store.workItems.list({ state: 'open', engine: 'codex' })).toHaveLength(1)
    expect(store.workItems.list({ state: 'nope' })).toEqual([])

    // Each repository sees only its own kind.
    expect(store.tasks.list()).toEqual([])
    store.tasks.save({ id: 'task_1', state: 'open' })
    expect(store.workItems.list()).toHaveLength(3)
    expect(store.tasks.list({ state: 'open' })).toHaveLength(1)
  })

  it('events are gap-free per stream and read back whole, stream included', () => {
    store.events.append('work:wi_1', event('work:wi_1', 1))
    store.events.append('work:wi_1', event('work:wi_1', 2))
    expect(() => store.events.append('work:wi_1', event('work:wi_1', 4))).toThrow(EventSequenceError)
    expect(() => store.events.append('work:wi_1', event('work:wi_1', 2))).toThrow(EventSequenceError)
    store.events.append('work:wi_1', event('work:wi_1', 3, 'work_item.closed'))

    expect(store.events.read('work:wi_1').map((e) => e.seq)).toEqual([1, 2, 3])
    expect(store.events.read('work:wi_1', 1).map((e) => e.seq)).toEqual([2, 3])
    expect(store.events.read('work:wi_1', 3)).toEqual([])
    expect(store.events.read('work:wi_1', 2).map((e) => e.type)).toEqual(['work_item.closed'])
    expect(store.events.read('work:wi_1')[0]).toEqual({
      stream: 'work:wi_1',
      seq: 1,
      at: expect.any(String),
      type: 'work_item.opened',
      body: { seq: 1 },
    })

    // Streams are independent: each starts its own gap-free sequence at 1.
    store.events.append('slot:eng_1', event('slot:eng_1', 1, 'slot.probed'))
    expect(store.events.read('slot:eng_1')).toHaveLength(1)
  })

  it('a failed append leaves the stream untouched, so the seq can be retried', () => {
    store.events.append('work:wi_1', event('work:wi_1', 1))
    expect(() =>
      store.atomic(() => {
        store.events.append('work:wi_1', event('work:wi_1', 2))
        store.events.append('work:wi_1', event('work:wi_1', 4)) // Refused inside the same transaction.
        throw new Error('never reached')
      }),
    ).toThrow(EventSequenceError)
    expect(store.events.read('work:wi_1').map((e) => e.seq)).toEqual([1])
    store.events.append('work:wi_1', event('work:wi_1', 2))
    expect(store.events.read('work:wi_1').map((e) => e.seq)).toEqual([1, 2])
  })

  it('effects enqueue joins the caller transaction', () => {
    expect(() =>
      store.atomic(() => {
        store.effects.enqueue('relay', 'wi_1', { wake: true })
        throw new Error('outer boom')
      }),
    ).toThrow('outer boom')
    expect(store.effects.snapshot('relay', 'wi_1')).toBeUndefined()

    store.atomic(() => store.effects.enqueue('relay', 'wi_1', { wake: true }))
    expect(store.effects.snapshot('relay', 'wi_1')?.payload).toEqual({ wake: true })
  })
})
