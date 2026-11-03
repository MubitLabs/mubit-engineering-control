// RepoCache (plan §14): one bare clone per URL under a sha256-derived key, cloned once
// under concurrency, refreshed with a forced pruning fetch; Worktrees materialise
// checkouts from that clone at a pinned 40-hex base, and commitAll/diffSummary/headSha
// report what happened in them. Everything runs against the real git binary with
// fixture repositories built in tmpdirs and file:// remotes; tests that mutate a source
// repo get their own fixture so ordering never changes an expectation.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git } from '../src/exec'
import { RepoCache } from '../src/repos'
import { commitAll, diffSummary, headSha, Worktrees } from '../src/worktrees'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-git-repos-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

// Fixture commits carry their own identity and never sign, whatever the host config says.
const IDENT = [
  '-c',
  'user.name=Mec Fixture',
  '-c',
  'user.email=mec@example.com',
  '-c',
  'commit.gpgsign=false',
]

async function commitFile(repo: string, name: string, content: string, message: string): Promise<string> {
  writeFileSync(join(repo, name), content)
  await git(['add', '--all'], { cwd: repo })
  await git([...IDENT, 'commit', '--quiet', '-m', message], { cwd: repo })
  return headSha(repo)
}

async function makeSourceRepo(dir: string): Promise<string> {
  await git(['init', '--quiet', '-b', 'main', dir])
  await commitFile(dir, 'a.txt', 'one\ntwo\nthree\n', 'baseline')
  return dir
}

const SRC = join(root, 'src')
const url = `file://${SRC}`

beforeAll(async () => {
  await makeSourceRepo(SRC)
})

describe('RepoCache', () => {
  it('clones bare under a sha256-derived key and is stable across ensure calls', async () => {
    const cache = RepoCache.open(join(root, 'cache'))
    const expectedKey = createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 12)

    const first = await cache.ensure(url)
    expect(first.repoKey).toBe(expectedKey)
    expect(first.gitDir).toBe(join(root, 'cache', `${expectedKey}.git`))
    expect(existsSync(join(first.gitDir, 'HEAD'))).toBe(true)

    const again = await cache.ensure(url)
    expect(again).toEqual(first)
  })

  it('shares one clone between concurrent ensure calls for the same URL', async () => {
    const cache = RepoCache.open(join(root, 'cache-concurrent'))
    const results = await Promise.all([cache.ensure(url), cache.ensure(url), cache.ensure(url)])
    expect(new Set(results.map((r) => r.gitDir)).size).toBe(1)
    expect(existsSync(join(results[0].gitDir, 'HEAD'))).toBe(true)
  })

  it('fetches new commits on re-ensure', async () => {
    const src = await makeSourceRepo(join(root, 'src-refresh'))
    const refreshUrl = `file://${src}`
    const cache = RepoCache.open(join(root, 'cache-refresh'))
    const { gitDir } = await cache.ensure(refreshUrl)

    const before = await headSha(src)
    const after = await commitFile(src, 'b.txt', 'added later\n', 'second')
    expect(after).not.toBe(before)

    const refreshed = await cache.ensure(refreshUrl)
    expect(refreshed.gitDir).toBe(gitDir)
    expect((await git(['rev-parse', 'refs/heads/main'], { cwd: gitDir })).stdout.trim()).toBe(after)
  })

  it('prunes branches the remote deleted', async () => {
    const src = await makeSourceRepo(join(root, 'src-prune'))
    const pruneUrl = `file://${src}`
    const cache = RepoCache.open(join(root, 'cache-prune'))
    const { gitDir } = await cache.ensure(pruneUrl)

    await git(['branch', 'feature'], { cwd: src })
    await cache.ensure(pruneUrl)
    const present = await git(['rev-parse', '--verify', 'refs/heads/feature'], {
      cwd: gitDir,
      allowFailure: true,
    })
    expect(present.code).toBe(0)

    await git(['branch', '-D', 'feature'], { cwd: src })
    await cache.ensure(pruneUrl)
    const gone = await git(['rev-parse', '--verify', 'refs/heads/feature'], {
      cwd: gitDir,
      allowFailure: true,
    })
    expect(gone.code).not.toBe(0)
  })

  it('refuses URLs that are neither https:// nor file://', async () => {
    const cache = RepoCache.open(join(root, 'cache-refuse'))
    await expect(cache.ensure('ssh://git@github.com/mubit/x.git')).rejects.toThrow(
      /unsupported repository URL/,
    )
    await expect(cache.ensure('http://example.com/x.git')).rejects.toThrow(/unsupported repository URL/)
    await expect(cache.ensure('/local/path/x.git')).rejects.toThrow(/unsupported repository URL/)
  })
})

describe('Worktrees', () => {
  const cache = RepoCache.open(join(root, 'cache-wt'))
  let gitDir = ''
  let base = ''

  beforeAll(async () => {
    const ensured = await cache.ensure(url)
    gitDir = ensured.gitDir
    base = await headSha(SRC)
  })

  it('adds a worktree on a -B branch pinned to the base SHA', async () => {
    const path = join(root, 'wt-branch')
    await new Worktrees(gitDir).add({ path, branch: 'mec/attempts/1', baseSha: base, createBranch: true })
    expect(await headSha(path)).toBe(base)
    expect((await git(['rev-parse', 'refs/heads/mec/attempts/1'], { cwd: gitDir })).stdout.trim()).toBe(base)
  })

  it('resumes: an existing worktree at the path is left alone', async () => {
    const path = join(root, 'wt-resume')
    const worktrees = new Worktrees(gitDir)
    await worktrees.add({ path, branch: 'mec/attempts/2', baseSha: base, createBranch: true })
    writeFileSync(join(path, 'uncommitted.txt'), 'kept\n')
    await worktrees.add({ path, branch: 'mec/attempts/2', baseSha: base, createBranch: true })
    expect(existsSync(join(path, 'uncommitted.txt'))).toBe(true)
    expect((await git(['status', '--porcelain'], { cwd: path })).stdout).toContain('uncommitted.txt')
  })

  it('checks out detached when createBranch is not set', async () => {
    const path = join(root, 'wt-detached')
    await new Worktrees(gitDir).add({ path, branch: 'mec/unused', baseSha: base })
    expect(await headSha(path)).toBe(base)
    const branch = await git(['branch', '--show-current'], { cwd: path })
    expect(branch.stdout.trim()).toBe('')
    expect((await git(['branch', '--list', 'mec/unused'], { cwd: gitDir })).stdout.trim()).toBe('')
  })

  it('rejects a base SHA that is not full 40-hex and an unsafe branch name', async () => {
    const worktrees = new Worktrees(gitDir)
    await expect(
      worktrees.add({
        path: join(root, 'wt-bad-sha'),
        branch: 'mec/bad',
        baseSha: 'deadbeef',
        createBranch: true,
      }),
    ).rejects.toThrow(/not a full commit SHA/)
    await expect(
      worktrees.add({
        path: join(root, 'wt-bad-branch'),
        branch: '--force',
        baseSha: base,
        createBranch: true,
      }),
    ).rejects.toThrow(/unsafe git ref/)
  })

  it('commitAll commits with the -c identity and returns null on a clean tree', async () => {
    const path = join(root, 'wt-commit')
    await new Worktrees(gitDir).add({ path, branch: 'mec/attempts/3', baseSha: base, createBranch: true })
    expect(
      await commitAll(path, 'nothing to do', { name: 'Ada Lovelace', email: 'ada@example.com' }),
    ).toBeNull()

    writeFileSync(join(path, 'b.txt'), 'x\ny\n')
    const sha = await commitAll(path, 'add b', { name: 'Ada Lovelace', email: 'ada@example.com' })
    expect(sha).not.toBeNull()
    expect(sha).not.toBe(base)
    const author = await git(['log', '-1', '--format=%an <%ae>'], { cwd: path })
    expect(author.stdout.trim()).toBe('Ada Lovelace <ada@example.com>')
    expect(await commitAll(path, 'clean now', { name: 'Ada', email: 'ada@example.com' })).toBeNull()
  })

  it('diffSummary aggregates numstat between two SHAs in the bare cache', async () => {
    const path = join(root, 'wt-diff')
    const worktrees = new Worktrees(gitDir)
    await worktrees.add({ path, branch: 'mec/attempts/4', baseSha: base, createBranch: true })

    writeFileSync(join(path, 'b.txt'), 'x\ny\n')
    const first = (await commitAll(path, 'add b', { name: 'Ada', email: 'ada@example.com' })) ?? ''
    expect(await diffSummary(gitDir, base, first)).toEqual({ files: 1, insertions: 2, deletions: 0 })

    writeFileSync(join(path, 'a.txt'), 'ONE\ntwo\nTHREE\n')
    const second = (await commitAll(path, 'retitle a', { name: 'Ada', email: 'ada@example.com' })) ?? ''
    expect(await diffSummary(gitDir, base, second)).toEqual({ files: 2, insertions: 4, deletions: 2 })
  })

  it('diffSummary validates both SHAs', async () => {
    await expect(diffSummary(gitDir, 'nothex', 'alsohex')).rejects.toThrow(/not a full commit SHA/)
  })

  it('removes a worktree, forcing when it holds untracked files', async () => {
    const clean = join(root, 'wt-remove-clean')
    const worktrees = new Worktrees(gitDir)
    await worktrees.add({ path: clean, branch: 'mec/attempts/5', baseSha: base, createBranch: true })
    await worktrees.remove(clean)
    expect(existsSync(clean)).toBe(false)

    const dirty = join(root, 'wt-remove-dirty')
    await worktrees.add({ path: dirty, branch: 'mec/attempts/6', baseSha: base, createBranch: true })
    writeFileSync(join(dirty, 'leftover.txt'), 'untracked\n')
    await worktrees.remove(dirty, true)
    expect(existsSync(dirty)).toBe(false)
  })
})
