import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Sql } from 'postgres'

export interface MigrationFile {
  version: string
  name: string
  sql: string
  checksum: string
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const files: MigrationFile[] = []
  for (const file of entries) {
    const match = FILE_PATTERN.exec(file)
    if (!match) throw new Error(`Migration file name must look like 0001_name.sql: ${file}`)
    const sql = await readFile(path.join(dir, file), 'utf8')
    files.push({
      version: match[1]!,
      name: match[2]!,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    })
  }
  const versions = new Set<string>()
  for (const f of files) {
    if (versions.has(f.version)) throw new Error(`Duplicate migration version ${f.version}`)
    versions.add(f.version)
  }
  return files
}

/**
 * Applies pending migrations in one transaction under an advisory lock, so concurrent deploys
 * cannot interleave. An edited, already-applied migration is an error rather than a silent skip.
 */
export async function migrate(sql: Sql, dir: string): Promise<MigrationResult> {
  const files = await loadMigrations(dir)
  const result: MigrationResult = { applied: [], skipped: [] }

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('mec.schema_migrations'))`
    await tx`
      create table if not exists schema_migrations (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `
    const rows = await tx<{ version: string; checksum: string }[]>`
      select version, checksum from schema_migrations
    `
    const applied = new Map(rows.map((r) => [r.version, r.checksum]))

    for (const file of files) {
      const existing = applied.get(file.version)
      if (existing !== undefined) {
        if (existing !== file.checksum) {
          throw new Error(`Migration ${file.version}_${file.name} was edited after it was applied`)
        }
        result.skipped.push(file.version)
        continue
      }
      await tx.unsafe(file.sql).simple()
      await tx`
        insert into schema_migrations (version, name, checksum)
        values (${file.version}, ${file.name}, ${file.checksum})
      `
      result.applied.push(file.version)
    }
  })

  return result
}
