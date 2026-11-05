import { describe, expect, it } from 'vitest'
import type { RepositoryEntry } from '../src/api'
import { classicKey, classicTarget, repositoryName } from '../src/repo-target'

const repo = (id: string): RepositoryEntry => ({
  id,
  url: `https://example.test/${id}`,
  bootstrap: [],
  checks: [],
  trust: true,
})
const repos = [repo('repo_a'), repo('repo_b')]

describe('classicTarget', () => {
  it('reply work repo wins', () => {
    expect(classicTarget(repos, { repoId: 'repo_b' }, 'repo_a')).toBe('repo_b')
  })

  it('a stored repo is next', () => {
    expect(classicTarget(repos, undefined, 'repo_b')).toBe('repo_b')
  })

  it('one repo needs no choice', () => {
    expect(classicTarget([repo('repo_a')], undefined, null)).toBe('repo_a')
  })

  it('many repos with none stored gives none', () => {
    expect(classicTarget(repos, undefined, null)).toBeNull()
  })

  it('a stored repo that is gone is no target', () => {
    expect(classicTarget(repos, undefined, 'repo_gone')).toBeNull()
  })

  it('no repos gives none', () => {
    expect(classicTarget([], undefined, 'repo_a')).toBeNull()
  })
})

describe('classicKey', () => {
  const mint = () => 'fresh'

  it('the same payload keeps its key, so a retry is idempotent', () => {
    const held = { key: 'k1', payload: 'p' }
    expect(classicKey(held, 'p', mint)).toBe(held)
  })

  it('an edited payload gets a new key, or the server answers 409 forever', () => {
    expect(classicKey({ key: 'k1', payload: 'p' }, 'q', mint)).toEqual({ key: 'fresh', payload: 'q' })
  })
})

describe('repositoryName', () => {
  it.each([
    ['https://github.com/acme/console.git', 'console'],
    ['github.com/acme/console', 'console'],
    ['/Users/me/code/thing/', 'thing'],
  ])('%s reads as %s', (url, name) => {
    expect(repositoryName(url)).toBe(name)
  })
})
