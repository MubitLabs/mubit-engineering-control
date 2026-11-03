import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import type { GithubOAuth } from '../src/features/auth/github'
import { createTestApp, type TestApp } from './helpers/app'

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

function fakeGithub(members: Record<string, boolean>): GithubOAuth {
  return {
    authorizeUrl: (state, redirect) =>
      `https://github.example/authorize?state=${state}&redirect_uri=${redirect}`,
    exchangeCode: async (code) => `token-for-${code}`,
    fetchIdentity: async (token) => {
      const login = token.replace('token-for-', '')
      return { githubId: login.length * 1000, login, name: login, avatarUrl: null }
    },
    isActiveOrgMember: async (token) => members[token.replace('token-for-', '')] === true,
  }
}

async function githubLogin(app: TestApp['app'], code: string) {
  const start = await app.inject({ method: 'GET', url: '/auth/github/login' })
  const state = start.cookies.find((c) => c.name === 'mec_oauth_state')!.value
  return app.inject({
    method: 'GET',
    url: `/auth/github/callback?code=${code}&state=${state}`,
    headers: { cookie: `mec_oauth_state=${state}` },
  })
}

describe('authentication', () => {
  it('rejects API calls without a session', async () => {
    t = await createTestApp()
    const res = await t.anonymous().get('/api/projects')
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('unauthorized')
  })

  it('accepts a dev session and reports the user', async () => {
    t = await createTestApp()
    const admin = await t.login('admin')
    const me = (await admin.get('/api/me')).json()
    expect(me.user).toMatchObject({ login: 'admin', isAdmin: true })
  })

  it('logs out by deleting the session', async () => {
    t = await createTestApp()
    const c = await t.login('mia')
    await c.post('/auth/logout')
    expect((await c.get('/api/me')).statusCode).toBe(401)
  })

  it('refuses cross-origin writes', async () => {
    t = await createTestApp()
    const admin = await t.login('admin')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: admin.cookie, origin: 'https://evil.example' },
      payload: { slug: 'x', name: 'x' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses to start dev auth on a public interface', () => {
    const env = { DATABASE_URL: 'postgres://x', AUTH_MODE: 'dev' }
    expect(() => loadConfig({ ...env, HOST: '0.0.0.0' })).toThrow(/loopback/)
    expect(() => loadConfig({ ...env, PUBLIC_URL: 'https://mec.example.com' })).toThrow(/loopback/)
    expect(loadConfig(env).authMode).toBe('dev')
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).authMode).toBe('github')
  })
})

describe('GitHub OAuth', () => {
  it('starts with sign-in disabled until the OAuth app is configured', async () => {
    t = await createTestApp({ config: { authMode: 'github' } })
    const res = await t.app.inject({ method: 'GET', url: '/auth/github/login' })
    expect(res.headers.location).toBe('/login?error=not_configured')
    expect(
      (await t.app.inject({ method: 'POST', url: '/auth/dev/login', payload: { login: 'a' } })).statusCode,
    ).toBe(404)
  })

  it('signs in active org members and discards the GitHub token', async () => {
    t = await createTestApp({ github: fakeGithub({ admin: true }) })
    const res = await githubLogin(t.app, 'admin')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    const session = res.cookies.find((c) => c.name === 'mec_session')!
    expect(session.httpOnly).toBe(true)
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `mec_session=${session.value}` },
    })
    expect(me.json().user).toMatchObject({ login: 'admin', isAdmin: true })
    const columns = await t.db
      .sql`select column_name from information_schema.columns where table_name = 'users'`
    expect(columns.map((c) => c.columnName)).not.toContain('access_token')
  })

  it('rejects non-members without creating a session', async () => {
    t = await createTestApp({ github: fakeGithub({ admin: true }) })
    const res = await githubLogin(t.app, 'stranger')
    expect(res.headers.location).toBe('/login?error=not_member')
    expect(res.cookies.find((c) => c.name === 'mec_session')).toBeUndefined()
    expect((await t.db.sql`select count(*)::int as n from users`)[0]!.n).toBe(0)
  })

  it('signs in listed logins whose org membership cannot be confirmed, and no one else', async () => {
    t = await createTestApp({ github: fakeGithub({}), config: { allowedLogins: ['e1daru'] } })
    expect((await githubLogin(t.app, 'E1daru')).headers.location).toBe('/')
    expect((await githubLogin(t.app, 'stranger')).headers.location).toBe('/login?error=not_member')
    const users = await t.db.sql`select login from users`
    expect(users.map((u) => u.login)).toEqual(['E1daru'])
  })

  it('returns to the page the user asked for, and only to a path on this site', async () => {
    t = await createTestApp({ github: fakeGithub({ admin: true }) })
    const land = async (next: string) => {
      const start = await t!.app.inject({
        method: 'GET',
        url: `/auth/github/login?next=${encodeURIComponent(next)}`,
      })
      const cookie = start.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      const state = start.cookies.find((c) => c.name === 'mec_oauth_state')!.value
      const res = await t!.app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=admin&state=${state}`,
        headers: { cookie },
      })
      return res.headers.location
    }
    expect(await land('/projects/p1/tasks/t1?x=1')).toBe('/projects/p1/tasks/t1?x=1')
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)'])
      expect(await land(evil)).toBe('/')
  })

  it('rejects a callback whose state does not match the cookie', async () => {
    t = await createTestApp({ github: fakeGithub({ admin: true }) })
    await t.app.inject({ method: 'GET', url: '/auth/github/login' })
    const res = await t.app.inject({
      method: 'GET',
      url: '/auth/github/callback?code=admin&state=forged',
      headers: { cookie: 'mec_oauth_state=real' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('has no dev login when GitHub auth is on', async () => {
    t = await createTestApp({ github: fakeGithub({}) })
    const res = await t.app.inject({ method: 'POST', url: '/auth/dev/login', payload: { login: 'admin' } })
    expect(res.statusCode).toBe(404)
  })
})
