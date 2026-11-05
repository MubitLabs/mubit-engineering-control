import type { RepositoryEntry } from './api'

/** The classic composer's remembered repository. */
export const CLASSIC_REPO_KEY = 'mec-classic-repo'

/**
 * Where a classic message lands: a reply's work names its own repository, then the stored
 * choice, then the only repository. Anything else is no target, and the composer asks.
 */
export function classicTarget(
  repositories: readonly Pick<RepositoryEntry, 'id'>[],
  replyWork: { repoId?: string } | undefined,
  stored: string | null,
): string | null {
  if (replyWork?.repoId !== undefined) return replyWork.repoId
  if (repositories.some((repo) => repo.id === stored)) return stored
  return repositories.length === 1 ? (repositories[0]?.id ?? null) : null
}

export type HeldKey = { key: string; payload: string }

/**
 * A retry keeps its key, and any edit needs a new one: the server answers an edited payload
 * under an old key with 409, which no retry would ever get past.
 */
export function classicKey(held: HeldKey, payload: string, mint: () => string): HeldKey {
  return held.payload === payload ? held : { key: mint(), payload }
}

/** `RepositoryEntry` has no name, so the last path segment reads as one. */
export function repositoryName(url: string): string {
  const segment = url.replace(/\/+$/, '').split('/').at(-1) ?? ''
  return segment.replace(/\.git$/, '') || url
}
