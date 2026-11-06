/**
 * Integration queue merges (plan §14): accepted tasks merge into the work item's single
 * integration worktree in dependency order, each as an explicit `--no-ff` merge commit so
 * the integration checks run on the exact resulting SHA. A conflict is never resolved or
 * aborted behind the caller's back: the worktree stays mid-merge with both sides on disk
 * for the repair agent (conflict.ts), and the conflicted paths are reported instead.
 */
import { GitError, git, gitLines } from './exec'
import { assertSafeRef, headSha } from './worktrees'

export type MergeIntoIntegrationOptions = {
  /** Bare cache the worktrees hang off; the task branch is resolved here before merging. */
  gitDir: string
  worktree: string
  taskBranch: string
  message: string
  /** Supplied through `-c`, as `commitAll` does: a bare cache has no identity of its own. */
  identity?: { name: string; email: string }
}

export type MergeIntoIntegrationResult =
  | { outcome: 'merged'; mergeSha: string }
  | { outcome: 'conflict'; conflictedPaths: string[] }

export async function mergeIntoIntegration(
  opts: MergeIntoIntegrationOptions,
): Promise<MergeIntoIntegrationResult> {
  const branch = assertSafeRef(opts.taskBranch)
  const known = await git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`], {
    cwd: opts.gitDir,
    allowFailure: true,
  })
  if (known.code !== 0) {
    throw new Error(`task branch not found in the repository cache: ${JSON.stringify(branch)}`)
  }

  const identity =
    opts.identity === undefined
      ? []
      : ['-c', `user.name=${opts.identity.name}`, '-c', `user.email=${opts.identity.email}`]
  const merged = await git([...identity, 'merge', '--no-ff', '--no-edit', '-m', opts.message, branch], {
    cwd: opts.worktree,
    allowFailure: true,
  })
  if (merged.code === 0) {
    return { outcome: 'merged', mergeSha: await headSha(opts.worktree) }
  }

  // A conflict leaves MERGE_HEAD behind; a refusal (unreachable object, dirty tree, …) does
  // not. Only the first is a conflict — anything else is reported as the failure it is,
  // because silently discarding either side is exactly what §14 forbids.
  if (!(await isMidMerge(opts.worktree))) {
    throw new GitError(
      'merge failed without leaving a merge in progress',
      ['merge', '--no-ff', '--no-edit', '-m', opts.message, branch],
      merged,
    )
  }
  const conflictedPaths = await gitLines(['diff', '--name-only', '--diff-filter=U'], {
    cwd: opts.worktree,
  })
  return { outcome: 'conflict', conflictedPaths }
}

/** True while a merge started in `worktree` awaits its completing commit. */
export async function isMidMerge(worktree: string): Promise<boolean> {
  const probe = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
    cwd: worktree,
    allowFailure: true,
  })
  return probe.code === 0
}
