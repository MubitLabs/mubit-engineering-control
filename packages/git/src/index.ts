export type { BootstrapOutput, DirtyFiles } from './bootstrap-output'
export {
  bootstrapOutput,
  clearMergePath,
  dirtyFiles,
  recordBootstrapOutput,
} from './bootstrap-output'
export type {
  CompleteMidMergeOptions,
  CompleteMidMergeResult,
  PrepareMidMergeRepairOptions,
  PrepareMidMergeRepairResult,
} from './conflict'
export { completeMidMerge, prepareMidMergeRepair } from './conflict'
export type { GitOptions, GitResult } from './exec'
export { GitError, git, gitLines } from './exec'
export type { MergeIntoIntegrationOptions, MergeIntoIntegrationResult } from './merge'
export { isMidMerge, mergeIntoIntegration } from './merge'
export type { EnsureResult } from './repos'
export { cachedDefaultTip, excludeFromWorktree, historyTouches, RepoCache } from './repos'
export type { DiffSummary, WorktreeAddOptions } from './worktrees'
export {
  assertSafeRef,
  assertSha,
  commitAll,
  diffSummary,
  headSha,
  Worktrees,
  worktreeAdminDir,
} from './worktrees'
