/**
 * Mid-merge conflict repair (plan §14): a conflicting integration merge is repaired by an
 * agent working IN the integration worktree, where both sides of every conflicted path are
 * already on disk — nothing is re-derived, preferred or discarded silently.
 * prepareMidMergeRepair checks those preconditions and refuses anything else;
 * completeMidMerge commits the resolution and proves it is a real merge commit with two
 * parents, so a repair can never masquerade as an ordinary commit.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { git, gitLines } from './exec'
import { isMidMerge } from './merge'
import { headSha } from './worktrees'

export type PrepareMidMergeRepairOptions = {
  sourceWorktree: string
  conflictPaths: readonly string[]
}

export type PrepareMidMergeRepairResult = { ok: true } | { ok: false; reason: string }

export async function prepareMidMergeRepair(
  opts: PrepareMidMergeRepairOptions,
): Promise<PrepareMidMergeRepairResult> {
  if (!(await isMidMerge(opts.sourceWorktree))) {
    return { ok: false, reason: `worktree is not mid-merge: ${JSON.stringify(opts.sourceWorktree)}` }
  }
  const missing = opts.conflictPaths.filter((path) => !existsSync(join(opts.sourceWorktree, path)))
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `conflicted path(s) missing from the worktree: ${missing
        .map((path) => JSON.stringify(path))
        .join(', ')}`,
    }
  }
  return { ok: true }
}

export type CompleteMidMergeOptions = {
  worktree: string
  name: string
  email: string
  message: string
}

export type CompleteMidMergeResult = { mergeSha: string; parentCount: number }

export async function completeMidMerge(opts: CompleteMidMergeOptions): Promise<CompleteMidMergeResult> {
  if (!(await isMidMerge(opts.worktree))) {
    throw new Error(`worktree is not mid-merge: ${JSON.stringify(opts.worktree)}`)
  }
  await git(['add', '--all'], { cwd: opts.worktree })
  await git(
    [
      '-c',
      `user.name=${opts.name}`,
      '-c',
      `user.email=${opts.email}`,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      opts.message,
    ],
    { cwd: opts.worktree },
  )
  const parents = await gitLines(['rev-parse', 'HEAD^@'], { cwd: opts.worktree })
  if (parents.length !== 2) {
    throw new Error('mid-merge commit must have two parents')
  }
  return { mergeSha: await headSha(opts.worktree), parentCount: parents.length }
}
