import { migrate } from './db/migrate'
import { createSql } from './db/sql'
import { MIGRATIONS_DIR } from './paths'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const sql = createSql(url, { max: 1 })
try {
  const result = await migrate(sql, MIGRATIONS_DIR)
  console.log(`migrations applied: [${result.applied.join(', ')}] already present: ${result.skipped.length}`)
} finally {
  await sql.end()
}
