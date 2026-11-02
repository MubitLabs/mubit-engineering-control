import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../../db/sql'

export const SESSION_COOKIE = 'mec_session'

export interface SessionUser {
  id: string
  login: string
  name: string | null
  avatarUrl: string | null
  isAdmin: boolean
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export async function createSession(db: Db, userId: string, ttlHours: number): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db`
    insert into sessions (token_hash, user_id, expires_at)
    values (${hashToken(token)}, ${userId}, now() + make_interval(hours => ${ttlHours}))
  `
  return token
}

/** Returns the user for a live session and slides its last-seen time. Disabled users get nothing. */
export async function lookupSession(db: Db, token: string): Promise<SessionUser | null> {
  const [row] = await db<SessionUser[]>`
    with s as (
      update sessions set last_seen_at = now()
      where token_hash = ${hashToken(token)} and expires_at > now()
      returning user_id
    )
    select u.id, u.login, u.name, u.avatar_url, u.is_admin
    from s join users u on u.id = s.user_id
    where u.disabled_at is null
  `
  return row ?? null
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db`delete from sessions where token_hash = ${hashToken(token)}`
}

export interface GithubIdentity {
  githubId: number | null
  login: string
  name: string | null
  avatarUrl: string | null
}

/**
 * Upserts a user by GitHub id, falling back to a placeholder row created by login (when a project
 * owner added them before their first sign-in). Admin status comes only from configuration.
 */
export async function upsertUser(
  db: Db,
  identity: GithubIdentity,
  adminLogins: string[],
): Promise<SessionUser> {
  const isAdmin = adminLogins.includes(identity.login.toLowerCase())
  const [byId] =
    identity.githubId === null
      ? []
      : await db<{ id: string }[]>`select id from users where github_id = ${identity.githubId}`
  const [byLogin] = byId
    ? []
    : await db<{ id: string }[]>`select id from users where lower(login) = lower(${identity.login})`
  const existing = byId ?? byLogin

  const [user] = existing
    ? await db<SessionUser[]>`
        update users set
          github_id = coalesce(${identity.githubId}, github_id), login = ${identity.login},
          name = ${identity.name}, avatar_url = ${identity.avatarUrl},
          is_admin = is_admin or ${isAdmin}, last_login_at = now()
        where id = ${existing.id}
        returning id, login, name, avatar_url, is_admin
      `
    : await db<SessionUser[]>`
        insert into users (github_id, login, name, avatar_url, is_admin, last_login_at)
        values (${identity.githubId}, ${identity.login}, ${identity.name}, ${identity.avatarUrl}, ${isAdmin}, now())
        returning id, login, name, avatar_url, is_admin
      `
  return user!
}
