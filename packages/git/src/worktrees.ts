import { existsSync } from 'node:fs'
import { assertSafeRef, assertSha, git } from './exec'

/** Branch per attempt (PDF §14): stable identifiers, never free text. */
export function attemptBranch(deliveryId: string, taskKey: string, attemptNumber: number): string {
  return assertSafeRef(`mec/${deliveryId.slice(0, 8)}/${taskKey}/a${attemptNumber}`)
}

export function integrationBranch(deliveryId: string): string {
  return assertSafeRef(`mec/${deliveryId.slice(0, 8)}/integration`)
}

/** Adds a worktree on a new branch at the pinned base. Reuses an existing one (resume). */
export async function addWorktree(
  clone: string,
  workdir: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  if (existsSync(`${workdir}/.git`)) return
  await git(['worktree', 'prune'], { cwd: clone })
  await git(['worktree', 'add', '--force', '-B', assertSafeRef(branch), '--', workdir, assertSha(baseSha)], {
    cwd: clone,
  })
}

export async function removeWorktree(clone: string, workdir: string): Promise<void> {
  await git(['worktree', 'remove', '--force', '--', workdir], { cwd: clone }).catch(() => undefined)
}

export interface Submodule {
  path: string
  sha: string
}

/**
 * Initialises submodules recursively and records their SHAs. Fails with a clear message when
 * required content is unavailable (PDF §14, §34) rather than leaving a partial checkout.
 */
export async function initSubmodules(workdir: string, env: Record<string, string>): Promise<Submodule[]> {
  if (!existsSync(`${workdir}/.gitmodules`)) return []
  try {
    await git(['submodule', 'update', '--init', '--recursive', '--quiet'], {
      cwd: workdir,
      env,
      timeoutMs: 600_000,
    })
  } catch (e) {
    throw new Error(
      `submodules could not be fetched; check repository access for this runner: ${(e as Error).message}`,
    )
  }
  const status = await git(['submodule', 'status', '--recursive'], { cwd: workdir })
  return status
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, p] = l.replace(/^[-+U ]/, '').split(/\s+/)
      return { path: p ?? '', sha: sha ?? '' }
    })
}

export async function headSha(workdir: string): Promise<string> {
  return assertSha((await git(['rev-parse', 'HEAD'], { cwd: workdir })).trim())
}

/** Stages everything and commits if anything changed. Returns the new HEAD, or null if clean. */
export async function commitAll(
  workdir: string,
  message: string,
  author: { name: string; email: string },
): Promise<string | null> {
  await git(['add', '--all'], { cwd: workdir })
  const staged = await git(['diff', '--cached', '--name-only'], { cwd: workdir })
  if (!staged.trim()) return null
  await git(['commit', '--quiet', '--no-verify', '-m', message], {
    cwd: workdir,
    env: {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    },
  })
  return headSha(workdir)
}

export interface DiffSummary {
  baseSha: string
  headSha: string
  files: { path: string; insertions: number; deletions: number }[]
  insertions: number
  deletions: number
  /** Unified diff, truncated to `maxPatchBytes`. */
  patch: string
  truncated: boolean
}

export async function diffSummary(
  workdir: string,
  baseSha: string,
  head: string,
  maxPatchBytes = 2_000_000,
): Promise<DiffSummary> {
  const range = `${assertSha(baseSha)}..${assertSha(head)}`
  const numstat = await git(['diff', '--numstat', range], { cwd: workdir })
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ins, del, ...p] = l.split('\t')
      return { path: p.join('\t'), insertions: Number(ins) || 0, deletions: Number(del) || 0 }
    })
  const fullPatch = await git(['diff', '--no-color', range], { cwd: workdir })
  const truncated = Buffer.byteLength(fullPatch) > maxPatchBytes
  return {
    baseSha,
    headSha: head,
    files,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    patch: truncated ? Buffer.from(fullPatch).subarray(0, maxPatchBytes).toString() : fullPatch,
    truncated,
  }
}

/** Pushes a branch with credentials supplied through the environment (never on the command line). */
export async function pushBranch(
  workdir: string,
  branch: string,
  env: Record<string, string>,
): Promise<void> {
  const ref = assertSafeRef(branch)
  await git(['push', '--quiet', '--force-with-lease', 'origin', `HEAD:refs/heads/${ref}`], {
    cwd: workdir,
    env,
    timeoutMs: 300_000,
  })
}
