/**
 * Repo and canonical identity (spec §10, §12.1, decisions #10 and #19). A message, and the
 * work it starts, belongs to one registered repository or to none:
 *
 * - **The conversation id is the repoId.** There is no conversation row; messages carry it.
 * - **Absent means Unassigned.** Unassigned work is planned but never launched, and a row
 *   with no repo that already has a plan or has left planning is read-only. Nothing
 *   backfills a legacy row.
 * - **Unknown or crossing is refused before any write.** A reference, a resent message id or
 *   a replayed idempotency key cannot move a request between repositories.
 * - **The pin is written once.** It records what the repository was at admission; editing
 *   the registry changes later admissions, never existing work.
 * - **Planner task ids are local keys.** The store's id is canonical and fresh, so two plans
 *   can both say `task_1`. Within one work item a key reused by a replan is the same task
 *   and keeps its id, history and status; a task whose meaning changes uses a new key.
 */
import { createHash } from 'node:crypto'
import type { Json, Store, StoreDoc } from '@mec/contracts'
import { loadPolicy } from '../../policy/src/policy'

/** Every registered repository doc id starts with this. */
const REPOSITORY_PREFIX = 'repo_'

/** The compiled bundle revision is only known once a turn runs; each plan snapshot records it. */
const UNRESOLVED_PROMPT_REVISION = 'unresolved'

export type RepoAdmissionCode = 'unknown_repo' | 'repo_mismatch'

/** A request refused at admission; the chat route answers it as a 400. */
export class RepoAdmissionError extends Error {
  constructor(
    readonly code: RepoAdmissionCode,
    detail: string,
  ) {
    super(detail)
  }
}

export type RepoPin = {
  repoId: string
  url: string
  profileHash: string
  policyHash: string
  promptRevision: string
}

/** The repo a document belongs to; undefined is Unassigned. */
export function repoOf(doc: StoreDoc | undefined): string | undefined {
  return typeof doc?.repoId === 'string' ? doc.repoId : undefined
}

/** Read-only checks only, so a refusal leaves the store exactly as it was. */
export function assertRepoAdmission(
  store: Store,
  input: { repoId?: string; referencesWorkItem?: string },
): void {
  const { repoId, referencesWorkItem } = input
  if (repoId !== undefined && !isRegistered(store, repoId)) {
    throw new RepoAdmissionError('unknown_repo', `repository ${repoId} is not registered`)
  }
  if (referencesWorkItem === undefined) return
  const work = store.workItems.get(referencesWorkItem)
  if (work !== undefined && repoOf(work) !== repoId) {
    throw new RepoAdmissionError('repo_mismatch', `${referencesWorkItem} belongs to another repository`)
  }
}

function isRegistered(store: Store, repoId: string): boolean {
  return repoId.startsWith(REPOSITORY_PREFIX) && store.engines.get(repoId) !== undefined
}

/** The values a work item is pinned to; the caller saves them once, inside its transaction. */
export function pinRepo(store: Store, repoId: string, policyText: string): RepoPin {
  const repo = store.engines.get(repoId)
  if (repo === undefined || !isRegistered(store, repoId)) {
    throw new RepoAdmissionError('unknown_repo', `repository ${repoId} is not registered`)
  }
  const profile = JSON.stringify({
    bootstrap: repo.bootstrap ?? [],
    checks: repo.checks ?? [],
    trust: repo.trust === true,
  })
  return {
    repoId,
    url: String(repo.url ?? ''),
    profileHash: createHash('sha256').update(profile, 'utf8').digest('hex'),
    policyHash: loadPolicy(policyText).versionHash,
    promptRevision: UNRESOLVED_PROMPT_REVISION,
  }
}

/** The repo fields of a new work item, or nothing when it is Unassigned. */
export function repoFields(store: Store, repoId: string | undefined, policyText: string): StoreDoc {
  if (repoId === undefined) return {}
  return { repoId, pin: pinRepo(store, repoId, policyText) as unknown as Json }
}

/** Unassigned work that already has a plan or has left planning takes no further writes. */
export function isReadOnlyWork(work: StoreDoc, tasks: readonly StoreDoc[]): boolean {
  return repoOf(work) === undefined && (tasks.length > 0 || String(work.state) !== 'planning')
}

/** The id of one immutable plan revision, in the same catch-all as questions and repos. */
export const planSnapshotId = (workItemId: string, revision: number): string =>
  `plan/${workItemId}/${revision}`

export type CanonicalTask<T> = Omit<T, 'localKey'> & {
  taskId: string
  localKey: string
  dependsOn: string[]
  /** The stored task this key already names in this work item (decision #19). */
  prior?: StoreDoc
}

/**
 * Rewrites a validated plan from local keys to canonical ids. Validation has already proved
 * that every dependency names a task in this plan, so the rewrite cannot miss.
 */
export function canonicalizePlan<T extends { taskId: string; dependsOn: readonly string[] }>(
  tasks: readonly T[],
  existing: readonly StoreDoc[],
  mintId: () => string,
): CanonicalTask<T>[] {
  const byKey = new Map(existing.map((doc) => [doc.localKey, doc]))
  const ids = new Map(tasks.map((task) => [task.taskId, String(byKey.get(task.taskId)?.id ?? mintId())]))
  return tasks.map((task) => {
    const prior = byKey.get(task.taskId)
    return {
      ...task,
      taskId: ids.get(task.taskId) as string,
      localKey: task.taskId,
      dependsOn: task.dependsOn.map((dep) => ids.get(dep) as string),
      ...(prior !== undefined && { prior }),
    }
  })
}
