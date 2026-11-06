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
import { type BootstrapOutput, unstageBootstrapOutput } from './bootstrap-output'
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
  /** What the bootstrap left here: a merge commit carries it no more than a task commit does. */
  keepOut?: BootstrapOutput
}

export type CompleteMidMergeResult = { mergeSha: string; parentCount: number }

export async function completeMidMerge(opts: CompleteMidMergeOptions): Promise<CompleteMidMergeResult> {
  if (!(await isMidMerge(opts.worktree))) {
    throw new Error(`worktree is not mid-merge: ${JSON.stringify(opts.worktree)}`)
  }
  await git(['add', '--all'], { cwd: opts.worktree })
  if (opts.keepOut !== undefined) {
    // What the merge itself brings is the task's, whatever bytes the bootstrap left on that path.
    const brought = new Set(
      await gitLines(['diff', '--name-only', '--no-renames', 'HEAD...MERGE_HEAD'], { cwd: opts.worktree }),
    )
    const paths = opts.keepOut.paths.filter((path) => !brought.has(path))
    if (paths.length > 0) {
      const head = await headSha(opts.worktree)
      await unstageBootstrapOutput(opts.worktree, { head, paths })
    }
  }
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
