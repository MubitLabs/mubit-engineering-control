/**
 * Numbered SQL migrations with checksums (plan §17, the v1 migration discipline).
 *
 * Every applied migration is recorded in a `migrations` table together with the sha256 of its
 * sql. The runner refuses to open:
 * - a database that carries a migration id this runner lacks (a newer schema), and
 * a migration whose recorded checksum does not match the sql this runner would run,
 * because an applied migration is immutable history.
 *
 * Missing migrations are applied in id order, each inside its own transaction, so a failure
 * leaves no half-applied migration and no record.
 */
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface Migration {
  id: number
  name: string
  sql: string
}

const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`

export function migrate(db: Database.Database, migrations: readonly Migration[]): void {
  db.exec(MIGRATIONS_TABLE_SQL)
  const known = new Map<number, Migration>()
  for (const migration of migrations) {
    if (known.has(migration.id)) {
      throw new Error(`mec: duplicate migration id ${migration.id} (${migration.name})`)
    }
    known.set(migration.id, migration)
  }
  const applied = db
    .prepare<[], { id: number; name: string; checksum: string }>(
      'SELECT id, name, checksum FROM migrations ORDER BY id',
    )
    .all()
  const missing: Migration[] = []
  for (const row of applied) {
    const migration = known.get(row.id)
    if (migration === undefined) {
      throw new Error(
        `mec: database schema is newer than this build: migration ${row.id} (${row.name}) is unknown`,
      )
    }
    if (checksumOf(migration.sql) !== row.checksum) {
      throw new Error(
        `mec: migration ${row.id} (${migration.name}) was applied with a different sql; ` +
          'applied migrations are immutable',
      )
    }
  }
  for (const migration of migrations) {
    if (!applied.some((row) => row.id === migration.id)) missing.push(migration)
  }
  missing.sort((a, b) => a.id - b.id)
  for (const migration of missing) {
    // A savepoint acts as its own transaction when none is open, and nests safely when the
    // caller already holds one (migrate runs during open, before any store work).
    db.exec(`SAVEPOINT mig_${migration.id}`)
    try {
      db.exec(migration.sql)
      db.prepare<[number, string, string, string]>(
        'INSERT INTO migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.id, migration.name, checksumOf(migration.sql), new Date().toISOString())
      db.exec(`RELEASE SAVEPOINT mig_${migration.id}`)
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT mig_${migration.id}`)
      db.exec(`RELEASE SAVEPOINT mig_${migration.id}`)
      throw error
    }
  }
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/** v1: the core tables — json documents, the append-only event log and the effects queue. */
export const MIGRATIONS_v1: readonly Migration[] = [
  {
    id: 1,
    name: 'core tables',
    sql: `
      CREATE TABLE docs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX doc_kind_idx ON docs (kind);

      CREATE TABLE events (
        stream TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        body TEXT,
        PRIMARY KEY (stream, seq)
      );

      CREATE TABLE effects (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, key)
      );
    `,
  },
]
