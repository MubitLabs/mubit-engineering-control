import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Migration } from '../src/migrations'
import { checksumOf, MIGRATIONS_v1, migrate } from '../src/migrations'

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mec-migrations-'))
  db = new Database(join(dir, 'state.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function appliedRows(): Array<{ id: number; name: string; checksum: string }> {
  return db.prepare('SELECT id, name, checksum FROM migrations ORDER BY id').all() as Array<{
    id: number
    name: string
    checksum: string
  }>
}

describe('migrations', () => {
  it('applies MIGRATIONS_v1 to a fresh database and records id, name and checksum', () => {
    migrate(db, MIGRATIONS_v1)
    const objects = db
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE name IN ('docs', 'doc_kind_idx', 'events', 'effects')",
      )
      .all() as Array<{ name: string; type: string }>
    const names = new Map(objects.map((o) => [o.name, o.type]))
    expect(names.get('docs')).toBe('table')
    expect(names.get('doc_kind_idx')).toBe('index')
    expect(names.get('events')).toBe('table')
    expect(names.get('effects')).toBe('table')

    expect(appliedRows()).toEqual([
      { id: 1, name: 'core tables', checksum: checksumOf(MIGRATIONS_v1[0]!.sql) },
    ])
    // The v1 effects table carries the queue columns the runner expects.
    const columns = (db.prepare('PRAGMA table_info(effects)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(columns).toEqual([
      'kind',
      'key',
      'state',
      'payload',
      'attempts',
      'next_run_at',
      'last_error',
      'updated_at',
    ])
  })

  it('a second run is a no-op', () => {
    migrate(db, MIGRATIONS_v1)
    const before = appliedRows()
    expect(() => migrate(db, MIGRATIONS_v1)).not.toThrow()
    expect(appliedRows()).toEqual(before)
  })

  it('refuses a database with a migration the runner lacks (newer schema)', () => {
    migrate(db, MIGRATIONS_v1)
    db.prepare('INSERT INTO migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
      99,
      'from the future',
      '0'.repeat(64),
      new Date().toISOString(),
    )
    expect(() => migrate(db, MIGRATIONS_v1)).toThrow(/newer|unknown/)
  })

  it('refuses an applied migration whose sql was edited (checksum mismatch)', () => {
    migrate(db, MIGRATIONS_v1)
    const edited: readonly Migration[] = MIGRATIONS_v1.map((m) => ({ ...m, sql: `${m.sql}\n-- edited` }))
    expect(() => migrate(db, edited)).toThrow(/immutable|different sql/)
  })

  it('applies a missing migration alongside applied ones', () => {
    migrate(db, MIGRATIONS_v1)
    const extra: readonly Migration[] = [
      ...MIGRATIONS_v1,
      { id: 2, name: 'receipts', sql: 'CREATE TABLE receipts (id TEXT PRIMARY KEY)' },
    ]
    migrate(db, extra)
    expect(appliedRows().map((r) => r.id)).toEqual([1, 2])
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE name = 'receipts'").get() as { name: string }).name,
    ).toBe('receipts')
    // The added migration is now applied; running the same list again changes nothing.
    const once = appliedRows()
    migrate(db, extra)
    expect(appliedRows()).toEqual(once)
  })

  it('a failing migration rolls back whole and leaves no record', () => {
    const broken: readonly Migration[] = [
      { id: 1, name: 'broken', sql: 'CREATE TABLE half (x); CREATE TABLE certainly not valid;' },
    ]
    expect(() => migrate(db, broken)).toThrow()
    expect(appliedRows()).toEqual([])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined()
  })

  it('refuses a list with duplicate ids', () => {
    const duplicate: readonly Migration[] = [
      { id: 1, name: 'one', sql: 'CREATE TABLE one (x)' },
      { id: 1, name: 'one again', sql: 'CREATE TABLE one_again (x)' },
    ]
    expect(() => migrate(db, duplicate)).toThrow(/duplicate migration id 1/)
  })
})
