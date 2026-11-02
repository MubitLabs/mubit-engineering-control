import postgres from 'postgres'
import { migrate } from './db/migrate'
import { MIGRATIONS_DIR } from './paths'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
try {
  const result = await migrate(sql, MIGRATIONS_DIR)
  console.log(`migrations applied: [${result.applied.join(', ')}] already present: ${result.skipped.length}`)
} finally {
  await sql.end()
}
