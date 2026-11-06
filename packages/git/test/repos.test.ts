// Defect 5b (M2.1): a second `ensure` must not take `mec/*` task branches away, the cached
// default-branch tip is what a work item pins, and `.mec/` is invisible to `git add` in a
// worktree of the bare cache and is caught in history when it is forced in anyway.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { git } from '../src/exec'
import { cachedDefaultTip, excludeFromWorktree, historyTouches, RepoCache } from '../src/repos'
import { headSha, Worktrees } from '../src/worktrees'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-git-cache-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const IDENT = [
  '-c',
  'user.name=Mec Fixture',
  '-c',
  'user.email=mec@example.com',
  '-c',
  'commit.gpgsign=false',
]

async function commit(repo: string, name: string, message: string): Promise<string> {
  writeFileSync(join(repo, name), `${message}\n`)
  await git(['add', '--all'], { cwd: repo })
  await git([...IDENT, 'commit', '--quiet', '-m', message], { cwd: repo })
  return headSha(repo)
}

async function source(name: string): Promise<{ src: string; url: string; first: string }> {
  const src = join(root, name)
  await git(['init', '--quiet', '-b', 'main', src])
  return { src, url: `file://${src}`, first: await commit(src, 'a.txt', 'baseline') }
}

describe('RepoCache and task branches', () => {
  it('second ensure keeps mec branches', async () => {
    const { src, url, first } = await source('src-keep')
    const cache = RepoCache.open(join(root, 'cache-keep'))
    const { gitDir } = await cache.ensure(url)
    const worktree = join(root, 'wt-keep')
    await new Worktrees(gitDir).add({
      path: worktree,
      branch: 'mec/wi/task/a1',
      baseSha: first,
      createBranch: true,
    })
    const taskHead = await commit(worktree, 'task.txt', 'task work')
    await commit(src, 'b.txt', 'upstream moved')

    await cache.ensure(url)

    const kept = await git(['rev-parse', '--verify', 'refs/heads/mec/wi/task/a1'], { cwd: gitDir })
    expect(kept.stdout.trim()).toBe(taskHead)
    expect(await headSha(worktree)).toBe(taskHead)
  })

  it('the default tip follows the remote on every ensure, from the first one on', async () => {
    const { src, url, first } = await source('src-tip')
    const cache = RepoCache.open(join(root, 'cache-tip'))
    const { gitDir } = await cache.ensure(url)
    expect(await cachedDefaultTip(gitDir)).toBe(first)

    const moved = await commit(src, 'b.txt', 'upstream moved')
    await cache.ensure(url)
    expect(await cachedDefaultTip(gitDir)).toBe(moved)
  })

  it('.mec is ignored in a worktree, and history that holds it is caught', async () => {
    const { url, first } = await source('src-mec')
    const cache = RepoCache.open(join(root, 'cache-mec'))
    const { gitDir } = await cache.ensure(url)
    const worktree = join(root, 'wt-mec')
    await new Worktrees(gitDir).add({
      path: worktree,
      branch: 'mec/wi/task/a2',
      baseSha: first,
      createBranch: true,
    })

    await excludeFromWorktree(worktree, '.mec/*')
    await excludeFromWorktree(worktree, '.mec/*')
    mkdirSync(join(worktree, '.mec'))
    writeFileSync(join(worktree, '.mec', 'mcp.json'), '{}\n')
    writeFileSync(join(worktree, 'plain.txt'), 'x\n')
    const status = await git(['status', '--porcelain'], { cwd: worktree })
    expect(status.stdout).toContain('plain.txt')
    expect(status.stdout).not.toContain('.mec')
    expect(await historyTouches(worktree, first, await headSha(worktree), '.mec')).toBe(false)

    // A forced add goes past the exclude, and a later delete does not take it out of history.
    await git(['add', '-f', '.mec/mcp.json'], { cwd: worktree })
    await git([...IDENT, 'commit', '--quiet', '-m', 'forced'], { cwd: worktree })
    await git(['rm', '--quiet', '-f', '.mec/mcp.json'], { cwd: worktree })
    await git([...IDENT, 'commit', '--quiet', '-m', 'hidden again'], { cwd: worktree })
    expect(await historyTouches(worktree, first, await headSha(worktree), '.mec')).toBe(true)
  })
})
