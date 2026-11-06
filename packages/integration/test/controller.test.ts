// Real git: a bare cache, task branches in it, and the one integration worktree. `@mec/git` is
// injected in production, so this package has no dependency on it; the test reaches it by path.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completeMidMerge, headSha, mergeIntoIntegration, prepareMidMergeRepair } from '../../git/src/index'
import {
  type ControllerDeps,
  type ControllerTask,
  type IntegrationCheck,
  type IntegrationState,
  repairSettled,
  runIntegration,
} from '../src/index'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const IDENTITY = ['-c', 'user.name=MEC', '-c', 'user.email=mec@example.com']
const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

type Rig = {
  cache: string
  worktree: string
  base: string
  deps: ControllerDeps
  ran: string[]
  verdict: { next: IntegrationCheck[] }
  branch: (name: string, file: string, text: string, from?: string) => ControllerTask
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), 'mec-controller-'))
  roots.push(root)
  const seed = join(root, 'seed')
  mkdirSync(seed)
  gitIn(seed, 'init', '--quiet', '-b', 'main')
  writeFileSync(join(seed, 'a.txt'), 'one\n')
  gitIn(seed, 'add', '--all')
  gitIn(seed, 'commit', '--quiet', '-m', 'baseline')
  const cache = join(root, 'cache.git')
  gitIn(root, 'clone', '--quiet', '--bare', seed, cache)
  const base = gitIn(cache, 'rev-parse', 'main')
  const worktree = join(root, 'integration')
  gitIn(cache, 'worktree', 'add', '--quiet', '-b', 'mec/wi/integration', worktree, base)

  const ran: string[] = []
  const verdict = { next: [{ name: 'unit', status: 'passed' }] as IntegrationCheck[] }
  const deps: ControllerDeps = {
    git: {
      head: () => headSha(worktree),
      branchHead: async (branch) => gitIn(cache, 'rev-parse', `refs/heads/${branch}`),
      merge: (branch, message) =>
        mergeIntoIntegration({
          gitDir: cache,
          worktree,
          taskBranch: branch,
          message,
          identity: { name: 'MEC', email: 'mec@example.com' },
        }),
      prepareRepair: (paths) => prepareMidMergeRepair({ sourceWorktree: worktree, conflictPaths: paths }),
    },
    checks: async (sha) => {
      ran.push(sha)
      return verdict.next
    },
  }
  const branch = (name: string, file: string, text: string, from = base): ControllerTask => {
    const path = join(root, `wt-${name}`)
    gitIn(cache, 'worktree', 'add', '--quiet', '-b', `mec/wi/${name}/a1`, path, from)
    writeFileSync(join(path, file), text)
    gitIn(path, 'add', '--all')
    gitIn(path, 'commit', '--quiet', '-m', name)
    return {
      taskId: name,
      dependsOn: [],
      basePolicy: 'integration',
      accepted: true,
      branch: `mec/wi/${name}/a1`,
      head: gitIn(path, 'rev-parse', 'HEAD'),
    }
  }
  return { cache, worktree, base, deps, ran, verdict, branch }
}

const fresh = (head: string): IntegrationState => ({ head, integrated: {} })

describe('runIntegration (§14)', () => {
  it('merges in dependency order and checks the exact merge SHA', async () => {
    const { base, branch, deps, ran } = rig()
    const later = { ...branch('b', 'b.txt', 'b\n'), dependsOn: ['a'] }
    const first = branch('a', 'c.txt', 'a\n')
    const tasks = [later, first]

    const one = await runIntegration(deps, fresh(base), tasks)
    expect(one.effect).toMatchObject({ kind: 'integrated', taskId: 'a' })
    const firstSha = (one.effect as { sha: string }).sha
    expect(firstSha).not.toBe(base)
    expect(ran).toEqual([firstSha])
    expect(Object.keys(one.state.integrated)).toEqual(['a'])

    const two = await runIntegration(deps, one.state, tasks)
    expect(two.effect).toMatchObject({ kind: 'integrated', taskId: 'b' })
    const secondSha = (two.effect as { sha: string }).sha
    expect(ran).toEqual([firstSha, secondSha])
    expect(two.state.combined).toMatchObject({ sha: secondSha, passed: true })

    expect((await runIntegration(deps, two.state, tasks)).effect).toEqual({ kind: 'done' })
  })

  it('merges one task per run', async () => {
    const { base, branch, deps, ran } = rig()
    await runIntegration(deps, fresh(base), [branch('a', 'c.txt', 'a\n'), branch('b', 'b.txt', 'b\n')])
    expect(ran).toHaveLength(1)
  })

  it('refuses a branch that moved past its accepted head', async () => {
    const { base, branch, deps } = rig()
    const task = { ...branch('a', 'c.txt', 'a\n'), head: 'f'.repeat(40) }
    const { effect } = await runIntegration(deps, fresh(base), [task])
    expect(effect).toMatchObject({ kind: 'refused', taskId: 'a' })
  })

  it('conflict leaves both sides and repair has two parents', async () => {
    const { base, branch, deps, ran, worktree } = rig()
    const tasks = [branch('a', 'a.txt', 'left\n'), branch('b', 'a.txt', 'right\n')]
    const one = await runIntegration(deps, fresh(base), tasks)
    const two = await runIntegration(deps, one.state, tasks)
    expect(two.effect).toEqual({ kind: 'conflict', taskId: 'b', conflictedPaths: ['a.txt'] })
    const text = readFileSync(join(worktree, 'a.txt'), 'utf8')
    expect(text).toContain('left')
    expect(text).toContain('right')
    expect(ran).toHaveLength(1)

    const three = await runIntegration(deps, two.state, tasks)
    expect(three.effect).toMatchObject({ kind: 'repair', taskId: 'b', reason: 'conflict' })
    expect((await runIntegration(deps, three.state, tasks)).effect).toMatchObject({ kind: 'wait' })

    writeFileSync(join(worktree, 'a.txt'), 'left and right\n')
    const done = await completeMidMerge({
      worktree,
      name: 'MEC',
      email: 'mec@example.com',
      message: 'mec: repair',
    })
    expect(done.parentCount).toBe(2)
    const four = await runIntegration(deps, repairSettled(three.state), tasks)
    expect(four.effect).toEqual({ kind: 'integrated', taskId: 'b', sha: done.mergeSha })
    expect(four.state.combined).toMatchObject({ sha: done.mergeSha, passed: true })
    expect((await runIntegration(deps, four.state, tasks)).effect).toEqual({ kind: 'done' })
  })

  it('failing combined checks open a repair', async () => {
    const { base, branch, deps, ran, verdict, worktree } = rig()
    const tasks = [branch('a', 'c.txt', 'a\n')]
    verdict.next = [{ name: 'unit', status: 'failed', logTail: 'one red' }]
    const one = await runIntegration(deps, fresh(base), tasks)
    expect(one.effect).toMatchObject({ kind: 'failed', taskId: 'a' })
    expect(one.state.integrated).toEqual({})
    expect(one.state.combined).toMatchObject({ passed: false, sha: ran[0] })

    const two = await runIntegration(deps, one.state, tasks)
    expect(two.effect).toMatchObject({
      kind: 'repair',
      taskId: 'a',
      reason: 'checks_failed',
      failing: [{ name: 'unit', logTail: 'one red' }],
      sha: ran[0],
    })

    // The repair commits on top, and only a pass on its exact head integrates the task.
    writeFileSync(join(worktree, 'd.txt'), 'fixed\n')
    gitIn(worktree, 'add', '--all')
    gitIn(worktree, 'commit', '--quiet', '-m', 'repair')
    verdict.next = [{ name: 'unit', status: 'passed' }]
    const three = await runIntegration(deps, repairSettled(two.state), tasks)
    const repaired = gitIn(worktree, 'rev-parse', 'HEAD')
    expect(three.effect).toEqual({ kind: 'integrated', taskId: 'a', sha: repaired })
    expect(three.state.integrated.a).toBe(repaired)
  })

  it('an error is no pass and opens no repair', async () => {
    const { base, branch, deps, verdict } = rig()
    verdict.next = [{ name: 'unit', status: 'error', logTail: 'could not start' }]
    const { effect, state } = await runIntegration(deps, fresh(base), [branch('a', 'c.txt', 'a\n')])
    expect(effect).toMatchObject({ kind: 'refused', taskId: 'a' })
    expect(state.integrated).toEqual({})
  })

  it('moved head invalidates combined checks', async () => {
    const { base, branch, deps, ran, verdict, worktree } = rig()
    const tasks = [branch('a', 'c.txt', 'a\n')]
    const one = await runIntegration(deps, fresh(base), tasks)
    const green = one.state.combined?.sha

    writeFileSync(join(worktree, 'human.txt'), 'by hand\n')
    gitIn(worktree, 'add', '--all')
    gitIn(worktree, 'commit', '--quiet', '-m', 'a commit nobody asked for')
    const moved = gitIn(worktree, 'rev-parse', 'HEAD')
    verdict.next = [{ name: 'unit', status: 'failed', logTail: 'red now' }]

    const two = await runIntegration(deps, one.state, tasks)
    expect(ran).toEqual([green, moved])
    expect(two.state.combined).toMatchObject({ sha: moved, passed: false })
    expect(two.effect).toMatchObject({ kind: 'failed', taskId: 'a' })
  })

  it('a head that moves during the checks voids their verdict', async () => {
    const { base, branch, deps, worktree } = rig()
    const tasks = [branch('a', 'c.txt', 'a\n')]
    const checks = deps.checks
    const racing: ControllerDeps = {
      ...deps,
      checks: async (sha) => {
        writeFileSync(join(worktree, 'race.txt'), 'x\n')
        gitIn(worktree, 'add', '--all')
        gitIn(worktree, 'commit', '--quiet', '-m', 'race')
        return checks(sha)
      },
    }
    const { effect, state } = await runIntegration(racing, fresh(base), tasks)
    expect(effect).toMatchObject({ kind: 'wait' })
    expect(state.combined).toBeUndefined()
    expect(state.integrated).toEqual({})
  })
})
