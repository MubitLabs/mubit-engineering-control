import type { GithubIdentity } from './sessions'

/** The slice of GitHub's OAuth web flow we use. Swappable in tests. */
export interface GithubOAuth {
  authorizeUrl(state: string, redirectUri: string): string
  exchangeCode(code: string, redirectUri: string): Promise<string>
  fetchIdentity(accessToken: string): Promise<GithubIdentity>
  /** True only for an *active* membership of the organisation. */
  isActiveOrgMember(accessToken: string, org: string): Promise<boolean>
}

export function createGithubOAuth(clientId: string, clientSecret: string): GithubOAuth {
  const api = async (path: string, token: string) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mubit-engineering-control',
      },
      signal: AbortSignal.timeout(10_000),
    })

  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL('https://github.com/login/oauth/authorize')
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', 'read:org')
      url.searchParams.set('state', state)
      url.searchParams.set('allow_signup', 'false')
      return url.toString()
    },

    async exchangeCode(code, redirectUri) {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await res.json()) as { access_token?: string; error?: string }
      if (!res.ok || !body.access_token)
        throw new Error(`GitHub token exchange failed: ${body.error ?? res.status}`)
      return body.access_token
    },

    async fetchIdentity(token) {
      const res = await api('/user', token)
      if (!res.ok) throw new Error(`GitHub /user failed: ${res.status}`)
      const u = (await res.json()) as {
        id: number
        login: string
        name: string | null
        avatar_url: string | null
      }
      return { githubId: u.id, login: u.login, name: u.name, avatarUrl: u.avatar_url }
    },

    async isActiveOrgMember(token, org) {
      const res = await api(`/user/memberships/orgs/${encodeURIComponent(org)}`, token)
      if (res.status === 404 || res.status === 403) return false
      if (!res.ok) throw new Error(`GitHub membership check failed: ${res.status}`)
      const m = (await res.json()) as { state?: string }
      return m.state === 'active'
    },
  }
}
