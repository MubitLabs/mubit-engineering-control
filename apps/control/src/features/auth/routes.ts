import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Config } from '../../config'
import type { Sql } from '../../db/sql'
import { requireActor } from '../../http/actor'
import { HttpError, parse } from '../../http/errors'
import type { GithubOAuth } from './github'
import { createSession, deleteSession, lookupSession, SESSION_COOKIE, upsertUser } from './sessions'

const STATE_COOKIE = 'mec_oauth_state'

export function registerAuth(
  app: FastifyInstance,
  deps: { sql: Sql; config: Config; github: GithubOAuth | null },
) {
  const { sql, config, github } = deps
  const secure = config.publicUrl.startsWith('https://')
  const redirectUri = `${config.publicUrl}/auth/github/callback`

  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE]
    req.user = token ? await lookupSession(sql, token) : null
  })

  // Cross-site requests carrying our cookie are refused (SameSite=Lax already blocks most).
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const origin = req.headers.origin
    if (origin && origin !== new URL(config.publicUrl).origin) {
      throw new HttpError(403, 'bad_origin', 'Cross-origin request refused')
    }
  })

  const startSession = async (reply: FastifyReply, userId: string) => {
    const token = await createSession(sql, userId, config.sessionTtlHours)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: config.sessionTtlHours * 3600,
    })
  }

  app.get('/auth/github/login', async (_req, reply) => {
    if (!github) return reply.redirect('/login?error=not_configured')
    const state = randomBytes(16).toString('base64url')
    reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/auth',
      maxAge: 600,
    })
    return reply.redirect(github.authorizeUrl(state, redirectUri))
  })

  app.get('/auth/github/callback', async (req, reply) => {
    if (!github) throw new HttpError(404, 'not_found', 'GitHub login is not configured')
    const q = parse(z.object({ code: z.string().min(1), state: z.string().min(1) }), req.query)
    const expected = req.cookies[STATE_COOKIE]
    reply.clearCookie(STATE_COOKIE, { path: '/auth' })
    if (!expected || expected !== q.state)
      throw new HttpError(400, 'bad_state', 'Login expired, please try again')

    // The GitHub token is used only for these checks and never stored.
    const token = await github.exchangeCode(q.code, redirectUri)
    const identity = await github.fetchIdentity(token)
    const allowed =
      config.allowedLogins.includes(identity.login.toLowerCase()) ||
      (await github.isActiveOrgMember(token, config.github.org))
    if (!allowed) {
      req.log.warn({ login: identity.login }, 'login refused: not an org member')
      return reply.redirect('/login?error=not_member')
    }
    const user = await upsertUser(sql, identity, config.adminLogins)
    await startSession(reply, user.id)
    return reply.redirect('/')
  })

  if (config.authMode === 'dev') {
    // Local development and tests only: config refuses dev mode unless bound to loopback.
    app.post('/auth/dev/login', async (req, reply) => {
      const body = parse(z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/) }), req.body)
      const user = await upsertUser(
        sql,
        { githubId: null, login: body.login, name: body.login, avatarUrl: null },
        config.adminLogins,
      )
      await startSession(reply, user.id)
      return { user }
    })
  }

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) await deleteSession(sql, token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/me', async (req) => {
    const actor = await requireActor(sql, req)
    return { user: actor.user, projectRoles: actor.projectRoles, authMode: config.authMode }
  })

  app.get('/api/auth/config', async () => ({
    authMode: config.authMode,
    org: config.github.org,
    githubConfigured: github !== null,
  }))
}
