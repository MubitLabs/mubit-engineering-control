/**
 * The GitHub REST calls control makes for pull requests (PDF §14). v1 uses a fine-grained token
 * limited to the delivery repositories; a GitHub App replaces it later. Injectable for tests.
 */
export interface PullRequestInfo {
  number: number
  url: string
  headSha: string
  state: 'open' | 'closed'
  merged: boolean
  mergedAt: string | null
}

export interface CheckSummary {
  total: number
  completed: number
  failed: number
  conclusion: 'success' | 'failure' | 'pending' | 'none'
}

export interface GitHubApi {
  /** Whether this repository is hosted where the client can open pull requests. */
  supports(cloneUrl: string): boolean
  createPull(
    cloneUrl: string,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequestInfo>
  getPull(cloneUrl: string, number: number): Promise<PullRequestInfo>
  checks(cloneUrl: string, sha: string): Promise<CheckSummary>
}

export interface RepoRef {
  owner: string
  repo: string
}

/** Owner and name from an https GitHub clone URL; null for anything else. */
export function parseGithubRepo(cloneUrl: string): RepoRef | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(cloneUrl)
  return m ? { owner: m[1]!, repo: m[2]! } : null
}

export function createGitHubApi(token: string): GitHubApi {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mubit-engineering-control',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok)
      throw new Error(
        `GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`,
      )
    return (await res.json()) as T
  }
  type Pull = {
    number: number
    html_url: string
    head: { sha: string }
    state: 'open' | 'closed'
    merged: boolean
    merged_at: string | null
  }
  const toInfo = (p: Pull): PullRequestInfo => ({
    number: p.number,
    url: p.html_url,
    headSha: p.head.sha,
    state: p.state,
    merged: p.merged,
    mergedAt: p.merged_at,
  })
  const ref = (cloneUrl: string): RepoRef => {
    const r = parseGithubRepo(cloneUrl)
    if (!r) throw new Error(`not a GitHub repository: ${cloneUrl}`)
    return r
  }
  return {
    supports: (cloneUrl) => parseGithubRepo(cloneUrl) !== null,
    async createPull(cloneUrl, input) {
      const r = ref(cloneUrl)
      return toInfo(
        await call<Pull>(`/repos/${r.owner}/${r.repo}/pulls`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      )
    },
    async getPull(cloneUrl, number) {
      const r = ref(cloneUrl)
      return toInfo(await call<Pull>(`/repos/${r.owner}/${r.repo}/pulls/${number}`))
    },
    async checks(cloneUrl, sha) {
      const r = ref(cloneUrl)
      const body = await call<{ check_runs: { status: string; conclusion: string | null }[] }>(
        `/repos/${r.owner}/${r.repo}/commits/${sha}/check-runs?per_page=100`,
      )
      const runs = body.check_runs
      const completed = runs.filter((c) => c.status === 'completed')
      const failed = completed.filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''))
      return {
        total: runs.length,
        completed: completed.length,
        failed: failed.length,
        conclusion:
          runs.length === 0
            ? 'none'
            : failed.length
              ? 'failure'
              : completed.length < runs.length
                ? 'pending'
                : 'success',
      }
    },
  }
}
