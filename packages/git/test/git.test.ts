import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFixtureRepo } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import { addWorktree, assertSafeRef, attemptBranch, commitAll, diffSummary, headSha, RepoCache } from '../src'

const author = { name: 'MEC test', email: 'mec@example.com' }

describe('RepoCache', () => {
  it('clones once, fetches new commits, and resolves branches to SHAs', async () => {
    const remote = createFixtureRepo()
    const cache = new RepoCache(await mkdtemp(path.join(tmpdir(), 'mec-repos-')))
    const first = await cache.resolve(remote.url, 'main')
    expect(first).toMatch(/^[0-9a-f]{40}$/)
    const second = remote.commit({ 'b.txt': 'b' })
    expect(await cache.resolve(remote.url, 'main')).toBe(second)
    expect(await cache.resolve(remote.url, first)).toBe(first)
  })

  it('serialises concurrent syncs of the same clone', async () => {
    const remote = createFixtureRepo()
    const cache = new RepoCache(await mkdtemp(path.join(tmpdir(), 'mec-repos-')))
    const shas = await Promise.all(Array.from({ length: 4 }, () => cache.resolve(remote.url, 'main')))
    expect(new Set(shas).size).toBe(1)
  })
})

describe('worktrees', () => {
  it('creates one worktree per attempt on the pinned base, commits and diffs', async () => {
    const remote = createFixtureRepo()
    const cache = new RepoCache(await mkdtemp(path.join(tmpdir(), 'mec-repos-')))
    const base = await cache.resolve(remote.url, 'main')
    remote.commit({ 'later.txt': 'main moved on' })

    const work = await mkdtemp(path.join(tmpdir(), 'mec-work-'))
    const wt = path.join(work, 'attempt-1')
    const branch = attemptBranch('0123456789abcdef', 'T1', 1)
    await addWorktree(cache.pathFor(remote.url), wt, branch, base)
    expect(await headSha(wt)).toBe(base)
    expect(existsSync(path.join(wt, 'later.txt'))).toBe(false)

    writeFileSync(path.join(wt, 'src/new.js'), 'export const x = 1\n')
    writeFileSync(path.join(wt, 'README.md'), '# changed\n')
    const head = await commitAll(wt, 'T1: change', author)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(await commitAll(wt, 'nothing', author)).toBeNull()

    const diff = await diffSummary(wt, base, head!)
    expect(diff.files.map((f) => f.path).sort()).toEqual(['README.md', 'src/new.js'])
    expect(diff.insertions).toBe(2)
    expect(diff.patch).toContain('+export const x = 1')
  })

  it('reuses an existing worktree on resume', async () => {
    const remote = createFixtureRepo()
    const cache = new RepoCache(await mkdtemp(path.join(tmpdir(), 'mec-repos-')))
    const base = await cache.resolve(remote.url, 'main')
    const wt = path.join(await mkdtemp(path.join(tmpdir(), 'mec-work-')), 'a')
    await addWorktree(cache.pathFor(remote.url), wt, 'mec/x/T1/a1', base)
    writeFileSync(path.join(wt, 'progress.txt'), 'half done')
    await addWorktree(cache.pathFor(remote.url), wt, 'mec/x/T1/a1', base)
    expect(readFileSync(path.join(wt, 'progress.txt'), 'utf8')).toBe('half done')
  })
})

describe('ref safety', () => {
  it('refuses refs that could be read as options or escape the namespace', () => {
    for (const bad of ['-x', '--upload-pack=evil', 'a..b', 'x.lock', 'a b', 'refs/heads/', '']) {
      expect(() => assertSafeRef(bad)).toThrow()
    }
    expect(assertSafeRef('mec/abc/T1/a1')).toBe('mec/abc/T1/a1')
  })
})
