/**
 * Bare clone cache (plan §14): one bare repository per source URL, stored under a
 * sha256-derived key, cloned on first use and refreshed with a forced, pruning fetch
 * afterwards. Attempt worktrees hang off this clone so objects are shared. Only https://
 * and file:// URLs are accepted — no local transports with side effects, and nothing that
 * could fall back to an interactive credential prompt.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './exec'

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
      return { gitDir, repoKey }
    }
    // A leading '+' makes every ref force-updatable, so a reset branch on the remote is
    // taken rather than rejected; --prune drops branches the remote deleted.
    await git(['fetch', '--quiet', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*'], {
      cwd: gitDir,
    })
    return { gitDir, repoKey }
  }
}
