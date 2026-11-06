// What a bootstrap leaves in a worktree, against real git: it stays out of a task commit until
// someone changes it, and it never stands in a merge's way.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapOutput, clearMergePath, dirtyFiles, recordBootstrapOutput } from '../src/bootstrap-output'
import { completeMidMerge } from '../src/conflict'
import { mergeIntoIntegration } from '../src/merge'
import { commitAll } from '../src/worktrees'

const ID = { name: 'T', email: 't@example.com' }
const LOCK = 'package-lock.json'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** A cache and one linked worktree, as every attempt has. */
function worktree(): { path: string; cache: string } {
  const root = mkdtempSync(join(tmpdir(), 'mec-bootstrap-'))
  roots.push(root)
  const seed = join(root, 'seed')
  mkdirSync(seed)
  gitIn(seed, 'init', '--quiet', '-b', 'main')
  writeFileSync(join(seed, 'a.txt'), 'one\n')
  writeFileSync(join(seed, 'tracked.lock'), 'v1\n')
  gitIn(seed, 'add', '--all')
  gitIn(seed, 'commit', '--quiet', '-m', 'baseline')
  const cache = join(root, 'cache.git')
  gitIn(root, 'clone', '--quiet', '--bare', seed, cache)
  const path = join(root, 'wt')
  gitIn(cache, 'worktree', 'add', '--quiet', '-b', 'mec/task', path, 'main')
  return { path, cache }
}

/** One bootstrap: `write` is what it does to the tree. */
async function bootstrap(path: string, write: () => void): Promise<void> {
  const before = await dirtyFiles(path)
  write()
  await recordBootstrapOutput(path, before)
}

const commit = async (path: string): Promise<string | null> =>
  commitAll(path, 'm', ID, await bootstrapOutput(path))
const committed = (path: string): string[] =>
  gitIn(path, 'show', '--name-only', '--format=', 'HEAD').split('\n')
const inHead = (path: string): string[] => gitIn(path, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')

describe('a task commit (§14)', () => {
  it('leaves out what the bootstrap wrote and keeps it on disk', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    writeFileSync(join(path, 'work.txt'), 'work\n')
    expect(await commit(path)).not.toBeNull()
    expect(committed(path)).toEqual(['work.txt'])
    expect(readFileSync(join(path, LOCK), 'utf8')).toBe('{}\n')
  })

  it('is no commit at all when the bootstrap wrote the only change', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    const head = gitIn(path, 'rev-parse', 'HEAD')
    expect(await commit(path)).toBeNull()
    expect(gitIn(path, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('carries a file the specialist changed after the bootstrap', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    writeFileSync(join(path, LOCK), '{"chosen":true}\n')
    await commit(path)
    expect(committed(path)).toEqual([LOCK])
  })

  it('takes back what a specialist staged without changing it', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    writeFileSync(join(path, 'work.txt'), 'work\n')
    gitIn(path, 'add', '--all')
    await commit(path)
    expect(committed(path)).toEqual(['work.txt'])
  })

  it('takes back what a specialist committed without changing it', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    writeFileSync(join(path, 'work.txt'), 'work\n')
    gitIn(path, 'add', '--all')
    gitIn(path, 'commit', '--quiet', '-m', 'the specialist commits everything')
    expect(inHead(path)).toContain(LOCK)
    await commit(path)
    expect(inHead(path)).not.toContain(LOCK)
    expect(inHead(path)).toContain('work.txt')
  })

  it('leaves a tracked file the bootstrap rewrote as the base had it', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, 'tracked.lock'), 'v2\n'))
    writeFileSync(join(path, 'work.txt'), 'work\n')
    await commit(path)
    expect(committed(path)).toEqual(['work.txt'])
    expect(gitIn(path, 'show', 'HEAD:tracked.lock')).toBe('v1')
  })

  it('takes a name with glob characters as that name and nothing wider', async () => {
    const { path } = worktree()
    mkdirSync(join(path, 'app'))
    await bootstrap(path, () => writeFileSync(join(path, 'app/[id].txt'), 'made\n'))
    writeFileSync(join(path, 'app/i.txt'), 'work\n')
    await commit(path)
    expect(committed(path)).toEqual(['app/i.txt'])
  })

  it('keeps out a symlink and a whole unignored tree', async () => {
    const { path } = worktree()
    await bootstrap(path, () => {
      mkdirSync(join(path, 'node_modules/.bin'), { recursive: true })
      writeFileSync(join(path, 'node_modules/dep.js'), 'x\n')
      symlinkSync('nowhere', join(path, 'node_modules/.bin/dep'))
    })
    writeFileSync(join(path, 'work.txt'), 'work\n')
    await commit(path)
    expect(committed(path)).toEqual(['work.txt'])
  })

  it('never carries .mec, with or without a record', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    mkdirSync(join(path, '.mec'))
    writeFileSync(join(path, '.mec/mcp.json'), '{}')
    writeFileSync(join(path, 'work.txt'), 'work\n')
    await commit(path)
    expect(committed(path)).toEqual(['work.txt'])
  })

  it('excludes nothing in a worktree with no record, as an older build left it', async () => {
    const { path } = worktree()
    writeFileSync(join(path, LOCK), '{}\n')
    expect(await bootstrapOutput(path)).toBeUndefined()
    await commit(path)
    expect(committed(path)).toEqual([LOCK])
  })
})

describe('a later bootstrap on the same worktree', () => {
  it('keeps its claim on a file it rewrites with the same bytes', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    writeFileSync(join(path, 'work.txt'), 'work\n')
    await commit(path)
    expect(committed(path)).toEqual(['work.txt'])
  })

  it('claims nothing an interrupted specialist left dirty', async () => {
    const { path } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    writeFileSync(join(path, 'draft.txt'), 'unfinished\n')
    await bootstrap(path, () => undefined)
    await commit(path)
    expect(committed(path)).toEqual(['draft.txt'])
  })
})

describe('making room for a merge (§14)', () => {
  /** A branch that adds or changes `file`, and the worktree the merge lands in. */
  function merging(file: string, text: string): { path: string; cache: string } {
    const { path, cache } = worktree()
    const task = `${path}-task`
    gitIn(cache, 'worktree', 'add', '--quiet', '-b', 'mec/brought', task, 'main')
    mkdirSync(join(task, file, '..'), { recursive: true })
    writeFileSync(join(task, file), text)
    gitIn(task, 'add', '--all')
    gitIn(task, 'commit', '--quiet', '-m', 'brought')
    return { path, cache }
  }
  const merge = (path: string, cache: string) =>
    mergeIntoIntegration({
      gitDir: cache,
      worktree: path,
      taskBranch: 'mec/brought',
      message: 'm',
      identity: ID,
    })

  it('clears an untracked file the branch brings, and the merge takes the branch side', async () => {
    const { path, cache } = merging(LOCK, 'theirs\n')
    writeFileSync(join(path, LOCK), 'bootstrap\n')
    expect(await clearMergePath({ worktree: path, taskBranch: 'mec/brought' })).toEqual([LOCK])
    expect((await merge(path, cache)).outcome).toBe('merged')
    expect(gitIn(path, 'show', `HEAD:${LOCK}`)).toBe('theirs')
  })

  it('restores a tracked file the bootstrap rewrote', async () => {
    const { path, cache } = merging('tracked.lock', 'theirs\n')
    writeFileSync(join(path, 'tracked.lock'), 'bootstrap\n')
    await clearMergePath({ worktree: path, taskBranch: 'mec/brought' })
    expect((await merge(path, cache)).outcome).toBe('merged')
    expect(readFileSync(join(path, 'tracked.lock'), 'utf8')).toBe('theirs\n')
  })

  it('clears a file where the branch brings a directory, and the other way round', async () => {
    const one = merging('vendor/dep.js', 'theirs\n')
    writeFileSync(join(one.path, 'vendor'), 'bootstrap\n')
    await clearMergePath({ worktree: one.path, taskBranch: 'mec/brought' })
    expect((await merge(one.path, one.cache)).outcome).toBe('merged')

    const other = merging('vendor', 'theirs\n')
    mkdirSync(join(other.path, 'vendor'))
    writeFileSync(join(other.path, 'vendor/dep.js'), 'bootstrap\n')
    await clearMergePath({ worktree: other.path, taskBranch: 'mec/brought' })
    expect((await merge(other.path, other.cache)).outcome).toBe('merged')
  })

  it('leaves alone every path the merge does not bring', async () => {
    const { path } = merging(LOCK, 'theirs\n')
    writeFileSync(join(path, 'unrelated.txt'), 'kept\n')
    mkdirSync(join(path, 'node_modules'))
    writeFileSync(join(path, 'node_modules/dep.js'), 'kept\n')
    expect(await clearMergePath({ worktree: path, taskBranch: 'mec/brought' })).toEqual([])
    expect(existsSync(join(path, 'unrelated.txt'))).toBe(true)
    expect(existsSync(join(path, 'node_modules/dep.js'))).toBe(true)
  })

  it("touches nothing mid-merge: both sides are the repair agent's", async () => {
    const { path, cache } = merging('a.txt', 'theirs\n')
    writeFileSync(join(path, 'a.txt'), 'ours\n')
    gitIn(path, 'add', '--all')
    gitIn(path, 'commit', '--quiet', '-m', 'ours')
    expect((await merge(path, cache)).outcome).toBe('conflict')
    expect(await clearMergePath({ worktree: path, taskBranch: 'mec/brought' })).toEqual([])
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toContain('theirs')
  })
})

describe('a repair finishing a merge (§14)', () => {
  it('commits two parents without what the bootstrap left, and keeps what the merge brought', async () => {
    const { path, cache } = worktree()
    await bootstrap(path, () => {
      writeFileSync(join(path, LOCK), '{}\n')
      writeFileSync(join(path, 'same.txt'), 'same\n')
    })
    const task = `${path}-task`
    gitIn(cache, 'worktree', 'add', '--quiet', '-b', 'mec/brought', task, 'main')
    writeFileSync(join(task, 'a.txt'), 'theirs\n')
    gitIn(task, 'add', '--all')
    gitIn(task, 'commit', '--quiet', '-m', 'theirs')
    writeFileSync(join(path, 'a.txt'), 'ours\n')
    gitIn(path, 'add', 'a.txt')
    gitIn(path, 'commit', '--quiet', '-m', 'ours')
    await mergeIntoIntegration({
      gitDir: cache,
      worktree: path,
      taskBranch: 'mec/brought',
      message: 'm',
      identity: ID,
    })
    writeFileSync(join(path, 'a.txt'), 'both\n')
    const keepOut = await bootstrapOutput(path)
    const done = await completeMidMerge({ worktree: path, message: 'm', ...ID, ...(keepOut && { keepOut }) })
    expect(done.parentCount).toBe(2)
    expect(inHead(path)).not.toContain(LOCK)
    expect(gitIn(path, 'show', 'HEAD:a.txt')).toBe('both')
  })

  it("does not drop a path the merge brought with the bootstrap's own bytes", async () => {
    const { path, cache } = worktree()
    await bootstrap(path, () => writeFileSync(join(path, LOCK), '{}\n'))
    const task = `${path}-task`
    gitIn(cache, 'worktree', 'add', '--quiet', '-b', 'mec/brought', task, 'main')
    writeFileSync(join(task, 'a.txt'), 'theirs\n')
    writeFileSync(join(task, LOCK), '{}\n')
    gitIn(task, 'add', '--all')
    gitIn(task, 'commit', '--quiet', '-m', 'theirs')
    writeFileSync(join(path, 'a.txt'), 'ours\n')
    gitIn(path, 'add', 'a.txt')
    gitIn(path, 'commit', '--quiet', '-m', 'ours')
    await clearMergePath({ worktree: path, taskBranch: 'mec/brought' })
    await mergeIntoIntegration({
      gitDir: cache,
      worktree: path,
      taskBranch: 'mec/brought',
      message: 'm',
      identity: ID,
    })
    writeFileSync(join(path, 'a.txt'), 'both\n')
    const keepOut = await bootstrapOutput(path)
    await completeMidMerge({ worktree: path, message: 'm', ...ID, ...(keepOut && { keepOut }) })
    expect(inHead(path)).toContain(LOCK)
  })
})

describe('a refused merge', () => {
  it("names git's own reason and the file", async () => {
    const { path, cache } = worktree()
    const task = `${path}-task`
    gitIn(cache, 'worktree', 'add', '--quiet', '-b', 'mec/brought', task, 'main')
    writeFileSync(join(task, LOCK), 'theirs\n')
    gitIn(task, 'add', '--all')
    gitIn(task, 'commit', '--quiet', '-m', 'brought')
    writeFileSync(join(path, LOCK), 'bootstrap\n')
    chmodSync(join(path, LOCK), 0o644)
    await expect(
      mergeIntoIntegration({ gitDir: cache, worktree: path, taskBranch: 'mec/brought', message: 'm' }),
    ).rejects.toThrow(/would be overwritten by merge[\s\S]*package-lock\.json/)
  })
})
