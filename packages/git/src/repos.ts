/**
 * Bare clone cache (plan §14): one bare repository per source URL, stored under a
 * sha256-derived key, cloned on first use and refreshed with a forced, pruning fetch
 * afterwards. Attempt worktrees hang off this clone so objects are shared. Only https://
 * and file:// URLs are accepted — no local transports with side effects, and nothing that
 * could fall back to an interactive credential prompt.
 *
 * The remote's branches live under `refs/remotes/origin/`, never `refs/heads/`: the task
 * branches `mec/*` are local to this clone, and a pruning fetch into `refs/heads/` deletes
 * them, even one checked out in a live worktree. Bases are taken from the remote side.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git } from './exec'
import { assertSafeRef, assertSha } from './worktrees'

export type EnsureResult = { gitDir: string; repoKey: string }

function assertSupportedUrl(url: string): string {
  if (!url.startsWith('https://') && !url.startsWith('file://')) {
    throw new Error(`unsupported repository URL (https:// or file:// only): ${JSON.stringify(url)}`)
  }
  return url
}

function repoKeyFor(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 12)
}

export class RepoCache {
  /**
   * One in-flight ensure per repo key: concurrent callers for the same URL share a single
   * clone/fetch instead of racing over the same directory. Open one cache per root dir.
   */
  private readonly inflight = new Map<string, Promise<EnsureResult>>()

  private constructor(private readonly rootDir: string) {}

  static open(rootDir: string): RepoCache {
    mkdirSync(rootDir, { recursive: true })
    return new RepoCache(rootDir)
  }

  async ensure(url: string): Promise<EnsureResult> {
    assertSupportedUrl(url)
    const repoKey = repoKeyFor(url)
    const running = this.inflight.get(repoKey)
    if (running) return running

    const started = this.sync(repoKey, url).finally(() => {
      this.inflight.delete(repoKey)
    })
    this.inflight.set(repoKey, started)
    return started
  }

  private async sync(repoKey: string, url: string): Promise<EnsureResult> {
    const gitDir = join(this.rootDir, `${repoKey}.git`)
    if (!existsSync(join(gitDir, 'HEAD'))) {
      await git(['clone', '--quiet', '--bare', url, gitDir])
    }
    // A leading '+' makes every ref force-updatable, so a reset branch on the remote is
    // taken rather than rejected; --prune drops branches the remote deleted, and only under
    // the destination this refspec names.
    await git(['fetch', '--quiet', '--prune', '--force', 'origin', '+refs/heads/*:refs/remotes/origin/*'], {
      cwd: gitDir,
    })
    return { gitDir, repoKey }
  }
}

/** The tip of the clone's default branch as of the last `ensure`: what a work item pins (§14). */
export async function cachedDefaultTip(gitDir: string): Promise<string> {
  const head = await git(['symbolic-ref', '--short', 'HEAD'], { cwd: gitDir })
  const ref = `refs/remotes/origin/${assertSafeRef(head.stdout.trim())}`
  const tip = await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: gitDir })
  return assertSha(tip.stdout.trim())
}

/**
 * Hides `pattern` from `git add` in this worktree and its siblings. `info/exclude` is common to
 * a bare clone's worktrees, so the file sits in the cache, out of the worktree's own reach.
 * Exclude a directory's contents (`.mec/*`), not the directory: with the directory ignored,
 * `commitAll`'s `git add --all -- ':!.mec'` exits 1 even though it staged everything else.
 */
export async function excludeFromWorktree(worktree: string, pattern: string): Promise<void> {
  const { stdout } = await git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], {
    cwd: worktree,
  })
  const file = stdout.trim()
  const present = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  if (present.includes(pattern)) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${pattern}\n`)
}

/**
 * Did any commit in `base..head` touch `path`? It walks the commits, not the end state, because
 * a token added and then removed is still in the history a push would publish.
 */
/**
 * The files the commits after `base` changed, up to `head`, in git's order: what a task's owned
 * paths are checked against (§10). Renames show as their new path; nothing is staged or read.
 */
export async function changedPaths(worktree: string, base: string, head: string): Promise<string[]> {
  const range = `${assertSha(base)}..${assertSha(head)}`
  const { stdout } = await git(['diff', '--name-only', '-z', '--no-renames', range], { cwd: worktree })
  return stdout.split('\0').filter((path) => path !== '')
}

export async function historyTouches(
  worktree: string,
  base: string,
  head: string,
  path: string,
): Promise<boolean> {
  const range = `${assertSha(base)}..${assertSha(head)}`
  const { stdout } = await git(['log', '--format=%H', range, '--', path], { cwd: worktree })
  return stdout.trim() !== ''
}
