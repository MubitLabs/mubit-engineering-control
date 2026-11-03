// Integration queue (plan §14): accepted tasks merge into the work item's integration
// worktree as explicit --no-ff merge commits, checks run on the exact resulting SHA, and a
// conflict leaves the worktree mid-merge with both sides on disk for a repair agent —
// nothing is aborted or resolved silently, and completing a repair must produce a real
// two-parent merge commit. Everything runs against the real git binary with a fixture
// source repo behind a file:// remote, one bare cache, and one integration worktree (and
// branch) per test, so ordering never changes an expectation.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { completeMidMerge, prepareMidMergeRepair } from '../src/conflict'
import { git } from '../src/exec'
import { isMidMerge, mergeIntoIntegration } from '../src/merge'
import { RepoCache } from '../src/repos'
import { commitAll, headSha, Worktrees } from '../src/worktrees'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-git-merge-'))
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
const FIXTURE_IDENT = { name: 'Mec Fixture', email: 'mec@example.com' }

const CLEAN_BRANCH = 'mec/tasks/clean'
const CONFLICT_BRANCH = 'mec/tasks/conflicter'

async function commitFile(repo: string, name: string, content: string, message: string): Promise<string> {
  writeFileSync(join(repo, name), content)
  await git(['add', '--all'], { cwd: repo })
  await git([...IDENT, 'commit', '--quiet', '-m', message], { cwd: repo })
  return headSha(repo)
}

/** A source repo on `main` whose pinned base carries `a.txt` and `conflict.txt`. */
async function makeSourceRepo(dir: string): Promise<void> {
  await git(['init', '--quiet', '-b', 'main', dir])
  await commitFile(dir, 'a.txt', 'one\ntwo\nthree\n', 'baseline a')
  await commitFile(dir, 'conflict.txt', 'base\n', 'baseline conflict')

  // Two task branches off that same base: one touches nothing main needs, one must clash.
  await git(['checkout', '--quiet', '-b', CLEAN_BRANCH], { cwd: dir })
  await commitFile(dir, 'b.txt', 'clean task\n', 'clean task')
  await git(['checkout', '--quiet', 'main'], { cwd: dir })

  await git(['checkout', '--quiet', '-b', CONFLICT_BRANCH], { cwd: dir })
  await commitFile(dir, 'conflict.txt', 'task side\n', 'conflicting task')
  await git(['checkout', '--quiet', 'main'], { cwd: dir })
}

const SRC = join(root, 'src')

let gitDir = ''
let base = ''

beforeAll(async () => {
  await makeSourceRepo(SRC)
  const cache = RepoCache.open(join(root, 'cache'))
  ;({ gitDir } = await cache.ensure(`file://${SRC}`))
  base = await headSha(SRC)
})

/** One integration worktree per test, on its own branch at the pinned base. */
async function addIntegrationWorktree(branch: string): Promise<string> {
  const path = join(root, branch.replaceAll('/', '-'))
  await new Worktrees(gitDir).add({ path, branch, baseSha: base, createBranch: true })
  // MEC's merge and repair commits need an identity and plain conflict markers, whatever
  // the host's global config says.
  await git(['config', 'user.name', FIXTURE_IDENT.name], { cwd: path })
  await git(['config', 'user.email', FIXTURE_IDENT.email], { cwd: path })
  await git(['config', 'commit.gpgsign', 'false'], { cwd: path })
  await git(['config', 'merge.conflictStyle', 'merge'], { cwd: path })
  return path
}

/** An integration worktree whose own commit to `conflict.txt` clashes with the task branch. */
async function conflictedIntegration(branch: string): Promise<string> {
  const path = await addIntegrationWorktree(branch)
  writeFileSync(join(path, 'conflict.txt'), 'integration side\n')
  await commitAll(path, 'integration side changes conflict', FIXTURE_IDENT)
  const result = await mergeIntoIntegration({
    gitDir,
    worktree: path,
    taskBranch: CONFLICT_BRANCH,
    message: 'merge conflicting task',
  })
  if (result.outcome === 'merged') throw new Error(`expected a conflict, merged as ${result.mergeSha}`)
  expect(result.conflictedPaths).toEqual(['conflict.txt'])
  return path
}

async function parentLines(sha: string, cwd: string): Promise<string[]> {
  const { stdout } = await git(['cat-file', '-p', sha], { cwd })
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length).trim())
}

describe('mergeIntoIntegration', () => {
  it('merges a task with an explicit two-parent commit and advances the integration branch', async () => {
    const path = await addIntegrationWorktree('mec/it/clean')
    const result = await mergeIntoIntegration({
      gitDir,
      worktree: path,
      taskBranch: CLEAN_BRANCH,
      message: 'merge clean task',
    })
    if (result.outcome === 'conflict') {
      throw new Error(`expected a merge, conflicted on: ${result.conflictedPaths.join(', ')}`)
    }
    expect(result.mergeSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await parentLines(result.mergeSha, gitDir)).toHaveLength(2)
    expect(await isMidMerge(path)).toBe(false)
    // The integration branch in the cache points at the exact SHA the checks must run on.
    const branchHead = await git(['rev-parse', 'refs/heads/mec/it/clean'], { cwd: gitDir })
    expect(branchHead.stdout.trim()).toBe(result.mergeSha)
  })

  it('reports the conflicted path and leaves the worktree mid-merge with both sides', async () => {
    const path = await conflictedIntegration('mec/it/conflict')

    expect(await isMidMerge(path)).toBe(true)
    // MERGE_HEAD is the task side; HEAD carries the integration side — both are in the tree.
    const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: path })
    const taskHead = await git(['rev-parse', `refs/heads/${CONFLICT_BRANCH}`], { cwd: gitDir })
    expect(mergeHead.code).toBe(0)
    expect(mergeHead.stdout.trim()).toBe(taskHead.stdout.trim())
    const status = await git(['status', '--porcelain'], { cwd: path })
    expect(status.stdout).toContain('UU conflict.txt')
    const conflicted = readFileSync(join(path, 'conflict.txt'), 'utf8')
    expect(conflicted).toContain('<<<<<<<')
    expect(conflicted).toContain('integration side')
    expect(conflicted).toContain('task side')
  })

  it('refuses a task branch the cache does not know', async () => {
    const path = await addIntegrationWorktree('mec/it/unknown')
    await expect(
      mergeIntoIntegration({ gitDir, worktree: path, taskBranch: 'mec/tasks/missing', message: 'nope' }),
    ).rejects.toThrow(/task branch not found/)
  })
})

describe('mid-merge repair', () => {
  it('prepares, resolves in the worktree and completes with a two-parent merge commit', async () => {
    const path = await conflictedIntegration('mec/it/repair')

    expect(await prepareMidMergeRepair({ sourceWorktree: path, conflictPaths: ['conflict.txt'] })).toEqual({
      ok: true,
    })

    // The repair agent works IN the worktree and writes the resolution by hand.
    writeFileSync(join(path, 'conflict.txt'), 'resolved by repair agent\n')
    const done = await completeMidMerge({
      worktree: path,
      name: 'Repair Agent',
      email: 'repair@example.com',
      message: 'merge conflicting task (resolved)',
    })
    expect(done.parentCount).toBe(2)
    expect(await parentLines(done.mergeSha, gitDir)).toHaveLength(2)
    expect(await isMidMerge(path)).toBe(false)
    expect(readFileSync(join(path, 'conflict.txt'), 'utf8')).toBe('resolved by repair agent\n')
    const author = await git(['log', '-1', '--format=%an <%ae>'], { cwd: path })
    expect(author.stdout.trim()).toBe('Repair Agent <repair@example.com>')
  })

  it('completeMidMerge refuses a worktree that is not mid-merge', async () => {
    const path = await addIntegrationWorktree('mec/it/not-mid-merge')
    await expect(
      completeMidMerge({
        worktree: path,
        name: 'Repair Agent',
        email: 'repair@example.com',
        message: 'nope',
      }),
    ).rejects.toThrow(/not mid-merge/)
  })

  it('prepareMidMergeRepair refuses a clean worktree and a mid-merge worktree missing a path', async () => {
    const clean = await addIntegrationWorktree('mec/it/clean-prep')
    const cleanResult = await prepareMidMergeRepair({ sourceWorktree: clean, conflictPaths: ['a.txt'] })
    expect(cleanResult.ok).toBe(false)
    if (cleanResult.ok) throw new Error('expected a refusal')
    expect(cleanResult.reason).toMatch(/not mid-merge/)

    const conflicted = await conflictedIntegration('mec/it/repair-missing')
    const missing = await prepareMidMergeRepair({
      sourceWorktree: conflicted,
      conflictPaths: ['conflict.txt', 'not-there.txt'],
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected a refusal')
    expect(missing.reason).toMatch(/missing/)

    // The refused preparation left the merge exactly as it was.
    expect(await isMidMerge(conflicted)).toBe(true)
  })
})
