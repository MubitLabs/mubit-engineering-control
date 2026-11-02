import { randomBytes } from 'node:crypto'
import { createSql } from './db/sql'
import { hashRunnerToken } from './features/runners/gateway'

/**
 * Operator commands run on the control host (they need DATABASE_URL, i.e. host access):
 *
 *   node dist/admin.js invite --owner <github-login> --label <text>   single-use runner invitation
 */
const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}
const sql = createSql(url, { max: 1 })

try {
  if (args[0] === 'invite') {
    const owner = opt('--owner')
    const label = opt('--label') ?? 'runner'
    if (!owner) throw new Error('--owner <github-login> is required')
    const [user] = await sql<{ id: string }[]>`
      insert into users (login) values (${owner})
      on conflict (lower(login)) do update set login = users.login
      returning id
    `
    const token = `mec_inv_${randomBytes(24).toString('base64url')}`
    await sql`
      insert into runner_invites (token_hash, owner_id, label, created_by, expires_at)
      values (${hashRunnerToken(token)}, ${user!.id}, ${label}, ${user!.id}, now() + interval '1 hour')
    `
    console.log(token)
  } else {
    console.error('usage: admin.js invite --owner <github-login> --label <text>')
    process.exitCode = 2
  }
} finally {
  await sql.end()
}
