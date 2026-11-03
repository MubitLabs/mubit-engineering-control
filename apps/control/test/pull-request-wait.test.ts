import { describe, expect, it } from 'vitest'
import type { GitHubApi } from '../src/features/integration/github'
import { pullRequestWait } from '../src/features/integration/integrator'

const github = { supports: (url: string) => url.startsWith('https://github.com/') } as GitHubApi
const integrated = { state: 'integrating', integrationSha: 'abc', integrationPushedSha: 'abc' }
const gh = 'https://github.com/o/r.git'

describe('pullRequestWait', () => {
  it('says what an integrated delivery is waiting for before its pull request opens', () => {
    expect(
      pullRequestWait(
        { ...integrated, integrationPushedSha: null },
        { hasPullRequest: false, github, cloneUrl: gh },
      ),
    ).toMatch(/not pushed.*MEC_GIT_TOKEN/)
    expect(pullRequestWait(integrated, { hasPullRequest: false, github: null, cloneUrl: gh })).toMatch(
      /GITHUB_TOKEN/,
    )
    expect(pullRequestWait(integrated, { hasPullRequest: false, github, cloneUrl: 'file:///r' })).toMatch(
      /only for github\.com/,
    )
    expect(pullRequestWait(integrated, { hasPullRequest: false, github, cloneUrl: gh })).toBe(
      'Opening the pull request.',
    )
  })

  it('is silent while work is still integrating or once a pull request exists', () => {
    expect(
      pullRequestWait({ ...integrated, state: 'executing' }, { hasPullRequest: false, github, cloneUrl: gh }),
    ).toBeNull()
    expect(pullRequestWait(integrated, { hasPullRequest: true, github: null, cloneUrl: gh })).toBeNull()
  })
})
