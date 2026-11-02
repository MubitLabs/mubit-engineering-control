import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { migrate } from '../../src/db/migrate'
import { createSql, type Sql } from '../../src/db/sql'
import { MIGRATIONS_DIR } from '../../src/paths'

export interface TestDb {
  sql: Sql
  url: string
  drop(): Promise<void>
}

function adminUrl(): string {
  const url = process.env.MEC_TEST_DATABASE_URL
  if (!url) throw new Error('MEC_TEST_DATABASE_URL is not set')
  return url
}

/** Creates an isolated, empty database. Pass `{ migrate: false }` to skip migrations. */
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const base = adminUrl()
  const admin = postgres(base, { max: 1, onnotice: () => {} })
  const name = `mec_test_${randomBytes(6).toString('hex')}`
  await admin.unsafe(`create database ${name}`)
  await admin.end()

  const url = new URL(base)
  url.pathname = `/${name}`
  const sql = createSql(url.toString(), { max: 10 })
  if (opts.migrate !== false) await migrate(sql, MIGRATIONS_DIR)

  return {
    sql,
    url: url.toString(),
    async drop() {
      await sql.end({ timeout: 1 })
      const cleanup = postgres(base, { max: 1, onnotice: () => {} })
      await cleanup.unsafe(`drop database if exists ${name} with (force)`)
      await cleanup.end()
    },
  }
}
