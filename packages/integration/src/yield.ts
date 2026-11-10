/**
 * Yield-to-duplicate check, plan §14: before asking to open a PR, the release agent looks
 * for a human branch or PR that already contains the work item's change (the same commits
 * or the same diff). If one exists it reports `dropped` with a pointer and MEC opens
 * nothing. Related work that does not contain the change is not a reason to yield, and an
 * empty change set must not match everything.
 *
 * So a branch yields only when it carries our head's commits, or when, for every file we
 * change, its content is ours: the same blob, or the same deletion. Touching the same paths
 * with other content is other work (live, 10 November 2026: two different sites that both
 * add `index.html` and `style.css`), and a path the other side does not show is not proof.
 */

/** One changed path and its blob at the head that carries the change; null where it deletes the path. */
export type ChangedFile = { path: string; blob: string | null }

/**
 * What another branch or PR shows: its blob for each path it changes (null where it removes
 * one), and whether its head already contains ours (the same commits).
 */
export type BranchFiles = { name: string; files: readonly ChangedFile[]; containsHead?: boolean }

export type YieldDecision = { yield: boolean; branch?: string }

export function yieldToDuplicate(input: {
  changedFiles: readonly ChangedFile[]
  existingBranches: readonly BranchFiles[]
}): YieldDecision {
  if (input.changedFiles.length === 0) return { yield: false }
  for (const branch of input.existingBranches) {
    if (branch.containsHead === true) return { yield: true, branch: branch.name }
    const theirs = new Map(branch.files.map((file) => [file.path, file.blob]))
    const same = input.changedFiles.every(
      (file) => theirs.has(file.path) && theirs.get(file.path) === file.blob,
    )
    if (same) return { yield: true, branch: branch.name }
  }
  return { yield: false }
}
