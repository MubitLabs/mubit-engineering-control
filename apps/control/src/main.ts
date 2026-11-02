import { buildApp } from './app'
import { loadConfig } from './config'
import { migrate } from './db/migrate'
import { createSql } from './db/sql'
import { EventBus } from './events/bus'
import { MIGRATIONS_DIR } from './paths'

const config = loadConfig()
const sql = createSql(config.databaseUrl, { max: 15 })
if (config.migrateOnStart) await migrate(sql, MIGRATIONS_DIR)

const bus = new EventBus(sql)
await bus.start()
const app = await buildApp({ sql, bus, config })

let stopping = false
const shutdown = async (signal: string) => {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'shutting down')
  await app.close()
  await bus.stop()
  await sql.end({ timeout: 5 })
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ host: config.host, port: config.port })
