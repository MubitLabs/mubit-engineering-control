/**
 * Yield-to-duplicate check, plan §14: before asking to open a PR, the release agent looks
 * for a human branch or PR that already contains the work item's change (the same commits
 * or the same diff). If one exists it reports `dropped` with a pointer and MEC opens
 * nothing. Related work that does not contain the change is not a reason to yield, and an
 * empty change set must not match everything — so only a branch containing every changed
 * file yields.
 */
export type BranchFiles = { name: string; files: readonly string[] }

export type YieldDecision = { yield: boolean; branch?: string }

export function yieldToDuplicate(input: {
  changedFiles: readonly string[]
  existingBranches: readonly BranchFiles[]
}): YieldDecision {
  if (input.changedFiles.length === 0) return { yield: false }
  for (const branch of input.existingBranches) {
    const owned = new Set(branch.files)
    if (input.changedFiles.every((path) => owned.has(path))) {
      return { yield: true, branch: branch.name }
    }
  }
  return { yield: false }
}
