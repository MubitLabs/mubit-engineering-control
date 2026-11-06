/**
 * The integration controller, spec §14: one integration worktree per work item, one task per run,
 * and combined checks on the exact merge SHA. `nextIntegrationStep` picks the step; this runs it
 * through injected git and check functions and hands back the next state, which the caller saves.
 * A task is `integrated` only once checks pass on its merge SHA, never because the merge worked.
 *
 * - **A failure stops the queue.** There is one worktree, and it is mid-merge or red, so nothing
 *   else merges into it until the repair ends.
 * - **A head that moved has no verdict.** Whatever moved it, the combined checks run again on the
 *   head that is there now, and a pass that a move overtook is thrown away.
 * - **`done` is the queue's word, not the work's.** It also covers "nothing was accepted". Only
 *   `workResult` says the work is complete.
 */
import { type IntegrationTask, nextIntegrationStep } from './queue'

export type IntegrationCheck = { name: string; status: 'passed' | 'failed' | 'error'; logTail?: string }

export type IntegrationFailure = {
  taskId: string
  reason: 'conflict' | 'checks_failed'
  conflictedPaths?: string[]
  /** The commit the checks failed on. */
  sha?: string
  failing?: { name: string; logTail: string }[]
  /** A repair is open, so the worktree is the repair's. */
  repairing: boolean
}

export type IntegrationState = {
  /** The head the last run left. Anything else in the worktree is a move. */
  head: string
  /** Task id to the commit its checks passed on. */
  integrated: Record<string, string>
  combined?: { sha: string; passed: boolean; checks: IntegrationCheck[] }
  failed?: IntegrationFailure
  /** A repair ended: this task integrates when checks pass on the head it left. */
  verifying?: string
}

export type ControllerTask = {
  taskId: string
  dependsOn: readonly string[]
  basePolicy: 'integration' | 'contract'
  accepted: boolean
  branch: string
  /** The accepted head: what was tested, so what merges. */
  head: string
}

type MergeOutcome = { outcome: 'merged'; mergeSha: string } | { outcome: 'conflict'; conflictedPaths: string[] }

export type ControllerDeps = {
  git: {
    head(): Promise<string>
    branchHead(branch: string): Promise<string | undefined>
    merge(branch: string, message: string): Promise<MergeOutcome>
    prepareRepair(paths: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }>
  }
  checks(sha: string): Promise<IntegrationCheck[]>
}

export type IntegrationEffect =
  | { kind: 'wait'; reason: string }
  | { kind: 'integrated'; taskId: string; sha: string }
  | { kind: 'conflict'; taskId: string; conflictedPaths: string[] }
  | { kind: 'failed'; taskId: string; sha: string }
  | ({ kind: 'repair' } & Omit<IntegrationFailure, 'repairing'>)
  /** Combined checks passed on a head nobody merged. */
  | { kind: 'moved'; sha: string }
  /** A person must act; no repair answers this. */
  | { kind: 'refused'; taskId?: string; reason: string }
  | { kind: 'done' }

export type IntegrationRun = { state: IntegrationState; effect: IntegrationEffect }

/** Dependencies first, plan order otherwise: `nextIntegrationStep` takes its array as the order. */
export function dependencyOrder<T extends { taskId: string; dependsOn: readonly string[] }>(
  tasks: readonly T[],
): T[] {
  const left = new Map(tasks.map((task) => [task.taskId, task]))
  const ordered: T[] = []
  while (left.size > 0) {
    const free = [...left.values()].find((task) => !task.dependsOn.some((dep) => left.has(dep)))
    // The plan validator refuses cycles, so this holds only for a row it never saw.
    const next = free ?? ([...left.values()][0] as T)
    ordered.push(next)
    left.delete(next.taskId)
  }
  return ordered
}

const failingOf = (checks: readonly IntegrationCheck[]): { name: string; logTail: string }[] =>
  checks
    .filter((check) => check.status === 'failed')
    .map((check) => ({ name: check.name, logTail: check.logTail ?? '' }))

/** Checks on `sha`, kept only if the head is still `sha`. Otherwise the next run starts over. */
async function checksOn(
  deps: ControllerDeps,
  sha: string,
): Promise<{ checks: IntegrationCheck[]; passed: boolean } | undefined> {
  const checks = await deps.checks(sha)
  if ((await deps.git.head()) !== sha) return undefined
  return { checks, passed: checks.every((check) => check.status === 'passed') }
}

function verdictFor(
  state: IntegrationState,
  taskId: string | undefined,
  sha: string,
  checks: IntegrationCheck[],
  passed: boolean,
): IntegrationRun {
  const { verifying: _verifying, failed: _failed, ...rest } = state
  const next: IntegrationState = { ...rest, head: sha, combined: { sha, passed, checks } }
  if (passed) {
    if (taskId === undefined) return { state: next, effect: { kind: 'moved', sha } }
    return {
      state: { ...next, integrated: { ...next.integrated, [taskId]: sha } },
      effect: { kind: 'integrated', taskId, sha },
    }
  }
  if (taskId === undefined) return { state: next, effect: { kind: 'refused', reason: `checks failed on ${sha}` } }
  const failing = failingOf(checks)
  if (failing.length === 0) {
    const names = checks.filter((check) => check.status === 'error').map((check) => check.name)
    return {
      state: next,
      effect: { kind: 'refused', taskId, reason: `could not run ${names.join(', ')} on ${sha}` },
    }
  }
  const failed: IntegrationFailure = { taskId, reason: 'checks_failed', sha, failing, repairing: false }
  return { state: { ...next, failed }, effect: { kind: 'failed', taskId, sha } }
}

/** The worktree's head is not the one recorded, or a repair just ended: check what is there. */
async function verifyHead(deps: ControllerDeps, state: IntegrationState, sha: string): Promise<IntegrationRun> {
  const verdict = await checksOn(deps, sha)
  if (verdict === undefined) return { state, effect: { kind: 'wait', reason: 'the head moved again' } }
  const taskId = state.verifying ?? Object.keys(state.integrated).at(-1)
  const run = verdictFor(state, taskId, sha, verdict.checks, verdict.passed)
  if (state.verifying !== undefined || !verdict.passed) return run
  // A pass on a move integrates nothing new: who integrated where stays as it was.
  return { state: { ...run.state, integrated: state.integrated }, effect: { kind: 'moved', sha } }
}

async function merge(
  deps: ControllerDeps,
  state: IntegrationState,
  task: ControllerTask,
): Promise<IntegrationRun> {
  const { taskId } = task
  const tip = await deps.git.branchHead(task.branch)
  if (tip !== task.head) {
    return { state, effect: { kind: 'refused', taskId, reason: `${task.branch} is not on ${task.head}` } }
  }
  const merged = await deps.git.merge(task.branch, `mec: integrate ${taskId}`)
  if (merged.outcome === 'conflict') {
    const { conflictedPaths } = merged
    const failed: IntegrationFailure = { taskId, reason: 'conflict', conflictedPaths, repairing: false }
    return { state: { ...state, failed }, effect: { kind: 'conflict', taskId, conflictedPaths } }
  }
  const verdict = await checksOn(deps, merged.mergeSha)
  if (verdict === undefined) {
    return { state: { ...state, verifying: taskId }, effect: { kind: 'wait', reason: 'the head moved' } }
  }
  return verdictFor(state, taskId, merged.mergeSha, verdict.checks, verdict.passed)
}

async function openRepair(deps: ControllerDeps, state: IntegrationState): Promise<IntegrationRun> {
  const failed = state.failed as IntegrationFailure
  if (failed.reason === 'conflict') {
    const ready = await deps.git.prepareRepair(failed.conflictedPaths ?? [])
    if (!ready.ok) return { state, effect: { kind: 'refused', taskId: failed.taskId, reason: ready.reason } }
  }
  const { repairing: _repairing, ...facts } = failed
  return { state: { ...state, failed: { ...failed, repairing: true } }, effect: { kind: 'repair', ...facts } }
}

/** One step. Save the state it returns, and act on the effect, in one transaction. */
export async function runIntegration(
  deps: ControllerDeps,
  state: IntegrationState,
  tasks: readonly ControllerTask[],
): Promise<IntegrationRun> {
  const { failed } = state
  if (failed?.repairing === true) return { state, effect: { kind: 'wait', reason: 'a repair is open' } }
  if (failed === undefined) {
    const actual = await deps.git.head()
    if (actual !== state.head || state.verifying !== undefined) return verifyHead(deps, state, actual)
  }

  const snapshot: IntegrationTask[] = dependencyOrder(tasks).map((task) => {
    const sha = state.integrated[task.taskId]
    const mine = failed?.taskId === task.taskId
    return {
      taskId: task.taskId,
      dependsOn: [...task.dependsOn],
      basePolicy: task.basePolicy,
      accepted: task.accepted,
      integrated: sha !== undefined && !mine,
      mergeFailed: mine,
      ...(mine && failed?.conflictedPaths !== undefined && { conflictedPaths: failed.conflictedPaths }),
      ...(sha !== undefined && { integratedSha: sha }),
    }
  })
  // The queue would let a later task overtake a failed one; one worktree cannot.
  const step = nextIntegrationStep(
    failed === undefined ? snapshot : snapshot.filter((task) => task.integrated || task.mergeFailed),
  )
  if (step.action === 'repair') return openRepair(deps, state)
  if (step.action === 'wait') return { state, effect: { kind: 'wait', reason: step.reason } }
  if (step.action === 'done') return { state, effect: { kind: 'done' } }
  return merge(deps, state, tasks.find((task) => task.taskId === step.taskId) as ControllerTask)
}

/** The repair is over, its commit is in the worktree, and the next run checks that exact head. */
export function repairSettled(state: IntegrationState): IntegrationState {
  const { failed, ...rest } = state
  return failed === undefined ? state : { ...rest, verifying: failed.taskId }
}
