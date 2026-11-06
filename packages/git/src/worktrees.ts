/**
 * Per-attempt worktrees (plan §14): each attempt checks out of the shared bare cache at a
 * pinned base, on its own branch when one is created for it. SHAs are validated as full
 * 40-hex commits and branch names against a conservative allowlist, so neither can be
 * read as an option once it reaches argv.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { git } from './exec'

export type WorktreeAddOptions = {
  path: string
  branch: string
  baseSha: string
  /** Create (or reset) `branch` at the base with -B; otherwise check out detached. */
  createBranch?: boolean
}

export type DiffSummary = { files: number; insertions: number; deletions: number }

/** A ref or branch that is safe to pass as an argument (cannot be read as an option). */
export function assertSafeRef(ref: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/.test(ref) ||
    ref.includes('..') ||
    ref.endsWith('.lock') ||
    ref.endsWith('/')
  ) {
    throw new Error(`unsafe git ref: ${JSON.stringify(ref)}`)
  }
  return ref
}

export function assertSha(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`not a full commit SHA: ${JSON.stringify(sha)}`)
  }
  return sha
}

export class Worktrees {
  constructor(private readonly gitDir: string) {}

  /**
   * Materialises a worktree at the pinned base. An existing worktree at the path is left
   * exactly as it is (resume), so a retried attempt never loses work.
   */
  async add(opts: WorktreeAddOptions): Promise<void> {
    const branch = assertSafeRef(opts.branch)
    const baseSha = assertSha(opts.baseSha)
    if (existsSync(join(opts.path, '.git'))) return
    await git(['worktree', 'prune'], { cwd: this.gitDir })
    const target = opts.createBranch === true ? ['-B', branch] : ['--detach']
    await git(['worktree', 'add', '--force', ...target, '--', opts.path, baseSha], { cwd: this.gitDir })
  }

  /** Best-effort removal: a cleanup path must not mask the failure that triggered it. */
  async remove(path: string, force = false): Promise<void> {
    await git(['worktree', 'remove', ...(force ? ['--force'] : []), '--', path], { cwd: this.gitDir }).catch(
      () => undefined,
    )
  }
}

/**
 * The admin directory a linked worktree's `.git` file names, real path. Undefined for anything but
 * one plain pointer to a directory that exists. A worker can rewrite this file, and git follows
 * it, config and hooks included, so a host-side git call asks here first.
 */
export function worktreeAdminDir(path: string): string | undefined {
  const pointer = join(path, '.git')
  if (lstatSync(pointer, { throwIfNoEntry: false })?.isFile() !== true) return undefined
  const target = /^gitdir: (.+)\n?$/.exec(readFileSync(pointer, 'utf8'))?.[1]
  if (target === undefined) return undefined
  try {
    return realpathSync(resolve(path, target))
  } catch {
    return undefined
  }
}

export async function headSha(path: string): Promise<string> {
  const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: path })
  return assertSha(stdout.trim())
}

/**
 * Stages everything and commits if anything changed, with the identity supplied through
 * `-c` rather than any config file. Returns the new HEAD, or null when the tree was clean.
 *
 * H4 lesson (3 Nov 2026): the attempt-control directory `.mec/` (engine settings, MCP
 * config with the attempt-scoped bearer token, gitconfig) lives INSIDE the worktree —
 * `git add --all` staged it into a task branch and H3 pushed it to GitHub before the
 * Codex reviewer caught the class. The pathspec exclusion makes this seam incapable of
 * committing attempt artifacts, whatever the caller does.
 */
export async function commitAll(
  path: string,
  message: string,
  opts: { name: string; email: string },
): Promise<string | null> {
  // The same pathspec governs both checks: a tree whose only changes sit in .mec/ is
  // CLEAN to this seam (nothing stageable), so it returns null instead of attempting
  // a commit that would exit "nothing to commit".
  const status = await git(['status', '--porcelain', '--', ':!.mec'], { cwd: path })
  if (!status.stdout.trim()) return null
  await git(['add', '--all', '--', ':!.mec'], { cwd: path })
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
      message,
    ],
    { cwd: path },
  )
  return headSha(path)
}

/** Aggregates `git diff --numstat` between two full SHAs (binary files count as files only). */
export async function diffSummary(gitDir: string, base: string, head: string): Promise<DiffSummary> {
  const range = `${assertSha(base)}..${assertSha(head)}`
  const { stdout } = await git(['diff', '--numstat', range], { cwd: gitDir })
  let files = 0
  let insertions = 0
  let deletions = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    files += 1
    const [ins, del] = line.split('\t')
    insertions += Number(ins) || 0
    deletions += Number(del) || 0
  }
  return { files, insertions, deletions }
}
