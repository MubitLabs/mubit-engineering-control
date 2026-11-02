import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMigrations, migrate } from '../src/db/migrate'
import { MIGRATIONS_DIR } from '../src/paths'
import { createTestDb, type TestDb } from './helpers/db'

let db: TestDb | undefined
afterEach(async () => {
  await db?.drop()
  db = undefined
})

describe('migrate', () => {
  it('applies every migration to a fresh database, then is a no-op', async () => {
    db = await createTestDb({ migrate: false })
    const files = await loadMigrations(MIGRATIONS_DIR)
    const first = await migrate(db.sql, MIGRATIONS_DIR)
    expect(first.applied).toEqual(files.map((f) => f.version))

    const second = await migrate(db.sql, MIGRATIONS_DIR)
    expect(second.applied).toEqual([])
    expect(second.skipped).toHaveLength(files.length)
  })

  it('serialises concurrent runs so each migration applies once', async () => {
    db = await createTestDb({ migrate: false })
    const results = await Promise.all([migrate(db.sql, MIGRATIONS_DIR), migrate(db.sql, MIGRATIONS_DIR)])
    const appliedTotal = results.flatMap((r) => r.applied)
    const files = await loadMigrations(MIGRATIONS_DIR)
    expect(appliedTotal.sort()).toEqual(files.map((f) => f.version).sort())
  })

  it('refuses to run when an applied migration was edited', async () => {
    db = await createTestDb({ migrate: false })
    const dir = await mkdtemp(path.join(tmpdir(), 'mec-mig-'))
    await writeFile(path.join(dir, '0001_t.sql'), 'create table t (id int);')
    await migrate(db.sql, dir)
    await writeFile(path.join(dir, '0001_t.sql'), 'create table t (id bigint);')
    await expect(migrate(db.sql, dir)).rejects.toThrow(/edited after it was applied/)
  })

  it('rolls back every migration in the batch when one fails', async () => {
    db = await createTestDb({ migrate: false })
    const dir = await mkdtemp(path.join(tmpdir(), 'mec-mig-'))
    await writeFile(path.join(dir, '0001_ok.sql'), 'create table ok (id int);')
    await writeFile(path.join(dir, '0002_bad.sql'), 'create table broken (id nonsense_type);')
    await expect(migrate(db.sql, dir)).rejects.toThrow()
    const [row] = await db.sql`select to_regclass('ok') as t`
    expect(row?.t).toBeNull()
  })
})
