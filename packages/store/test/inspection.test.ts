import type { DomainEvent } from '@mec/contracts'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CursorError, decodeCursor, encodeCursor, InspectionReads } from '../src/inspection'
import { MIGRATIONS_v1, migrate } from '../src/migrations'
import { SqliteStore } from '../src/store'

let db: Database.Database
let store: SqliteStore
let reads: InspectionReads

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db, MIGRATIONS_v1)
  store = new SqliteStore(db, { now: () => new Date('2026-11-05T10:00:00.000Z') })
  reads = new InspectionReads(db)
})

afterEach(() => db.close())

const seedTasks = (n: number, repoOf: (i: number) => string | undefined = () => undefined): void => {
  store.atomic(() => {
    for (let i = 1; i <= n; i++) {
      const repoId = repoOf(i)
      store.tasks.save({
        id: `task_${i}`,
        workItemId: `wi_${i % 3}`,
        ...(repoId !== undefined && { repoId }),
        status: 'ready',
      })
    }
  })
}

const drain = (limit: number, opts: Parameters<InspectionReads['pageDocs']>[1] = {}): string[] => {
  const seen: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 1000; guard++) {
    const page = reads.pageDocs('task', { ...opts, limit, cursor })
    seen.push(...page.rows.map((r) => String(r.doc.id)))
    cursor = page.nextCursor
    if (cursor === null) break
  }
  return seen
}

function encodeBad(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

describe('InspectionReads.pageDocs', () => {
  it('no row is skipped or repeated across pages', () => {
    seedTasks(23)
    const seen = drain(5)
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    expect(seen[0]).toBe('task_1')
    expect(seen[22]).toBe('task_23')
  })

  it('pages are stable across inserts and equal timestamps', () => {
    // The injected clock gives every row the same updated_at; paging must not depend on it.
    seedTasks(10)
    const first = reads.pageDocs('task', { limit: 4 })
    expect(first.rows.map((r) => r.doc.id)).toEqual(['task_1', 'task_2', 'task_3', 'task_4'])
    store.atomic(() => {
      store.tasks.save({ id: 'task_new', workItemId: 'wi_x', status: 'ready' })
      // An in-place update keeps the row's position.
      store.tasks.save({ id: 'task_2', workItemId: 'wi_1', status: 'done' })
    })
    const rest: string[] = []
    let cursor = first.nextCursor
    while (cursor !== null) {
      const page = reads.pageDocs('task', { limit: 4, cursor })
      rest.push(...page.rows.map((r) => String(r.doc.id)))
      cursor = page.nextCursor
    }
    expect(rest).toEqual(['task_5', 'task_6', 'task_7', 'task_8', 'task_9', 'task_10', 'task_new'])
  })

  it('filters by an equals predicate and a missing field is null', () => {
    seedTasks(9, (i) => (i % 3 === 0 ? 'repo_a' : i % 3 === 1 ? 'repo_b' : undefined))
    expect(drain(2, { equals: { repoId: 'repo_a' } })).toEqual(['task_3', 'task_6', 'task_9'])
    expect(drain(2, { equals: { repoId: null } })).toEqual(['task_2', 'task_5', 'task_8'])
  })

  it('a byte cap ends the page with a valid cursor', () => {
    store.atomic(() => {
      for (let i = 1; i <= 6; i++) store.tasks.save({ id: `task_${i}`, pad: 'x'.repeat(1000) })
    })
    const page = reads.pageDocs('task', { limit: 100, maxBytes: 2500 })
    expect(page.rows.length).toBeGreaterThanOrEqual(1)
    expect(page.rows.length).toBeLessThan(6)
    expect(page.nextCursor).not.toBeNull()
    const seen = page.rows.map((r) => r.doc.id)
    let cursor = page.nextCursor
    while (cursor !== null) {
      const next = reads.pageDocs('task', { limit: 100, maxBytes: 2500, cursor })
      seen.push(...next.rows.map((r) => r.doc.id))
      cursor = next.nextCursor
    }
    expect(seen).toEqual(['task_1', 'task_2', 'task_3', 'task_4', 'task_5', 'task_6'])
  })

  it('one row larger than the cap is still served', () => {
    store.atomic(() => store.tasks.save({ id: 'task_1', pad: 'x'.repeat(5000) }))
    const page = reads.pageDocs('task', { limit: 10, maxBytes: 100 })
    expect(page.rows).toHaveLength(1)
    expect(page.nextCursor).toBeNull()
  })

  it('malformed cursor is refused', () => {
    seedTasks(3)
    const bad = [
      '',
      'not base64 !!',
      encodeBad({ v: 2, r: 1 }),
      encodeBad({ v: 1, r: -1 }),
      encodeBad({ v: 1, r: 1.5 }),
      encodeBad({ v: 1 }),
      encodeBad('x'),
      'e30',
    ]
    for (const cursor of bad) {
      expect(() => reads.pageDocs('task', { cursor }), cursor).toThrow(CursorError)
      expect(() => decodeCursor(cursor), cursor).toThrow(CursorError)
    }
    expect(decodeCursor(encodeCursor(7))).toBe(7)
  })

  it('a limit outside 1..100 is refused', () => {
    for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
      expect(() => reads.pageDocs('task', { limit }), String(limit)).toThrow(RangeError)
    }
  })

  it('refuses a field name that is not a plain identifier', () => {
    expect(() => reads.pageDocs('task', { equals: { "a') OR 1=1 --": 'x' } })).toThrow(RangeError)
  })

  it('keyset read uses doc_kind_idx', () => {
    const plan = reads.explainPageDocs('task', { equals: { repoId: 'repo_a' } }).join('\n')
    expect(plan).toMatch(/SEARCH docs USING INDEX doc_kind_idx \(kind=\? AND rowid>\?\)/)
    expect(plan).not.toMatch(/SCAN docs/)
  })

  it('a large history reads at most one page of rows', () => {
    seedTasks(2000)
    let parsed = 0
    const page = reads.pageDocs('task', {
      limit: 10,
      onRow: () => {
        parsed += 1
      },
    })
    expect(page.rows).toHaveLength(10)
    expect(parsed).toBeLessThanOrEqual(11)
  })
})

describe('InspectionReads newest-first and nested fields', () => {
  it('pages newest first with a keyset, none skipped or repeated', () => {
    seedTasks(7)
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: ReturnType<InspectionReads['pageDocs']> = reads.pageDocs('task', {
        limit: 3,
        order: 'desc',
        cursor,
      })
      seen.push(...page.rows.map((r) => String(r.doc.id)))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(seen).toEqual(['task_7', 'task_6', 'task_5', 'task_4', 'task_3', 'task_2', 'task_1'])
  })

  it('newest-first reads also use doc_kind_idx', () => {
    const plan = reads.explainPageDocs('task', { order: 'desc' }).join('\n')
    expect(plan).toMatch(/SEARCH docs USING INDEX doc_kind_idx \(kind=\? AND rowid<\?\)/)
  })

  it('matches a nested field by dotted path', () => {
    store.atomic(() => {
      store.workItems.save({ id: 'wi_1', mandate: { id: 'mandate_1' } })
      store.workItems.save({ id: 'wi_2', mandate: { id: 'mandate_2' } })
    })
    expect(reads.docsByField('work_item', 'mandate.id', ['mandate_2']).map((d) => d.id)).toEqual(['wi_2'])
  })

  it('getDoc answers only for the kind asked', () => {
    store.atomic(() => store.messages.save({ id: 'msg_1', text: 'hi' }))
    expect(reads.getDoc('message', 'msg_1')?.text).toBe('hi')
    expect(reads.getDoc('work_item', 'msg_1')).toBeUndefined()
    expect(reads.getDoc('message', 'nope')).toBeUndefined()
  })

  it('searches text fields case-insensitively and escapes wildcards', () => {
    store.atomic(() => {
      store.messages.save({ id: 'msg_1', text: 'Fix the Login page' })
      store.messages.save({ id: 'msg_2', text: '100% done' })
      store.messages.save({ id: 'msg_3', text: 'other' })
    })
    expect(reads.searchDocs('message', ['text'], 'login', { limit: 10 }).map((d) => d.id)).toEqual(['msg_1'])
    expect(reads.searchDocs('message', ['text'], '%', { limit: 10 }).map((d) => d.id)).toEqual(['msg_2'])
    expect(reads.searchDocs('message', ['text'], '_', { limit: 10 })).toEqual([])
  })
})

describe('InspectionReads helpers', () => {
  it('docsByField returns only the named values and groups counts by status', () => {
    seedTasks(9)
    const docs = reads.docsByField('task', 'workItemId', ['wi_1'])
    expect(docs.map((d) => d.id)).toEqual(['task_1', 'task_4', 'task_7'])
    expect(reads.countByField('task', 'workItemId', 'status', ['wi_1', 'wi_2'])).toEqual({
      wi_1: { ready: 3 },
      wi_2: { ready: 3 },
    })
    expect(reads.docsByField('task', 'workItemId', [])).toEqual([])
  })

  it('pages events by seq and reads cursors and last times in one call', () => {
    const ev = (stream: string, seq: number): DomainEvent => ({
      stream,
      seq,
      at: `2026-11-05T10:00:0${seq}.000Z`,
      type: 't',
      body: { seq },
    })
    for (let i = 1; i <= 5; i++) store.events.append('work:a', ev('work:a', i))
    store.events.append('work:b', ev('work:b', 1))
    const page = reads.pageEvents('work:a', { after: 1, limit: 2 })
    expect(page.rows.map((r) => r.seq)).toEqual([2, 3])
    expect(page.nextCursor).toBe(encodeCursor(3))
    expect(reads.pageEvents('work:a', { after: 4, limit: 2 }).nextCursor).toBeNull()
    expect(reads.cursors(['work:a', 'work:b', 'work:none'])).toEqual({
      'work:a': 5,
      'work:b': 1,
      'work:none': 0,
    })
    expect(reads.lastEventAt(['work:a', 'work:none'])).toEqual({ 'work:a': '2026-11-05T10:00:05.000Z' })
  })

  it('runs reads inside one consistent snapshot', () => {
    seedTasks(3)
    const [a, b] = reads.consistent(() => [
      reads.pageDocs('task', {}).rows.length,
      reads.pageDocs('task', {}).rows.length,
    ])
    expect(a).toBe(3)
    expect(b).toBe(3)
  })
})
