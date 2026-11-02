import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { assertSafeRef, assertSha, git } from './exec'

/** Serialises git operations per repository: concurrent fetches on one clone would fight over locks. */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.tails.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }
}

export interface CredentialEnv {
  /** Environment for git network operations, e.g. GIT_ASKPASS + token. Never given to agents. */
  env: Record<string, string>
}

/**
 * One bare clone per repository per runner (PDF §6): `<root>/<name>-<hash>.git`. Worktrees for
 * attempts are added from it, so objects are shared within the employee boundary.
 */
export class RepoCache {
  private readonly lock = new KeyedMutex()

  constructor(
    private readonly root: string,
    private readonly credentials: CredentialEnv = { env: {} },
  ) {}

  pathFor(cloneUrl: string): string {
    const hash = createHash('sha256').update(cloneUrl).digest('hex').slice(0, 12)
    const name = (cloneUrl.split('/').pop() ?? 'repo').replace(/\.git$/, '').replace(/[^A-Za-z0-9_.-]/g, '_')
    return path.join(this.root, `${name}-${hash}.git`)
  }

  /** Clones (first time) and fetches all branches. Returns the clone path. */
  async sync(cloneUrl: string): Promise<string> {
    const dir = this.pathFor(cloneUrl)
    return this.lock.run(dir, async () => {
      const env = this.credentials.env
      if (!existsSync(path.join(dir, 'HEAD'))) {
        await mkdir(dir, { recursive: true })
        await git(['init', '--bare', '--quiet'], { cwd: dir })
        await git(['remote', 'add', 'origin', '--', cloneUrl], { cwd: dir })
        await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: dir })
      }
      await git(['fetch', '--prune', '--quiet', 'origin'], { cwd: dir, env, timeoutMs: 600_000 })
      return dir
    })
  }

  /** Resolves a branch name (origin/<ref>) or verifies a SHA, fetching it if needed. */
  async resolve(cloneUrl: string, refOrSha: string): Promise<string> {
    const dir = await this.sync(cloneUrl)
    return this.lock.run(dir, async () => {
      if (/^[0-9a-f]{40}$/.test(refOrSha)) {
        if (!(await hasCommit(dir, refOrSha))) {
          await git(['fetch', '--quiet', 'origin', assertSha(refOrSha)], {
            cwd: dir,
            env: this.credentials.env,
          })
        }
        return refOrSha
      }
      const out = await git(
        [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `refs/remotes/origin/${assertSafeRef(refOrSha)}^{commit}`,
        ],
        {
          cwd: dir,
        },
      )
      return assertSha(out.trim())
    })
  }

  withLock<T>(cloneUrl: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = this.pathFor(cloneUrl)
    return this.lock.run(dir, () => fn(dir))
  }
}

export async function hasCommit(dir: string, sha: string): Promise<boolean> {
  try {
    await git(['cat-file', '-e', `${assertSha(sha)}^{commit}`], { cwd: dir })
    return true
  } catch {
    return false
  }
}
