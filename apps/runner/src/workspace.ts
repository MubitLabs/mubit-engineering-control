import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { StartPayload } from '@mec/contracts'
import {
  addWorktree,
  beginMerge,
  commitAll,
  commitExists,
  type DiffSummary,
  diffSummary,
  headSha,
  initSubmodules,
  mergeCommit,
  pushBranch,
  RepoCache,
  type Submodule,
} from '@mec/git'

export interface GitSettings {
  /** Fine-grained token for fetch/push. Used only by the runner's own git calls, never by agents. */
  token: string | null
  authorName: string
  authorEmail: string
  push: boolean
}

export interface PreparedWorkspace {
  workdir: string
  branch: string | null
  baseSha: string | null
  submodules: Submodule[]
}

const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "$MEC_GIT_TOKEN" ;;
esac
`

/**
 * Workspace lifecycle (PDF §14): one clone per repository, one worktree per attempt on the pinned
 * base, recorded submodule SHAs, then commit + diff capture when the agent stops.
 */
export class Workspaces {
  private readonly repos: RepoCache
  /** Shared with the repo cache; filled in by init() once the askpass helper exists. */
  private readonly credentials: { env: Record<string, string> } = { env: {} }

  constructor(
    private readonly home: string,
    private readonly settings: GitSettings,
  ) {
    this.repos = new RepoCache(path.join(home, 'repos'), this.credentials)
  }

  /** Writes the askpass helper so the token travels via the environment, not argv. */
  async init(): Promise<void> {
    if (!this.settings.token) return
    const bin = path.join(this.home, 'bin')
    await mkdir(bin, { recursive: true })
    const helper = path.join(bin, 'git-askpass')
    await writeFile(helper, ASKPASS, { mode: 0o700 })
    await chmod(helper, 0o700)
    this.credentials.env = { GIT_ASKPASS: helper, MEC_GIT_TOKEN: this.settings.token }
  }

  async prepare(
    attemptId: string,
    payload: StartPayload,
    existing: string | null,
  ): Promise<PreparedWorkspace> {
    const workdir = existing ?? path.join(this.home, 'work', attemptId)
    if (!payload.repository) {
      await mkdir(workdir, { recursive: true })
      return { workdir, branch: null, baseSha: null, submodules: [] }
    }
    const { cloneUrl } = payload.repository
    const baseSha = await this.repos.resolve(cloneUrl, payload.baseSha ?? payload.baseRef ?? 'main')
    const branch = payload.branch ?? `mec/attempt/${attemptId}`
    await mkdir(path.dirname(workdir), { recursive: true })
    await this.repos.withLock(cloneUrl, (clone) =>
      addWorktree(clone, workdir, payload.integration ? null : branch, baseSha),
    )
    const submodules = await initSubmodules(workdir, this.credentials.env)
    return { workdir, branch, baseSha, submodules }
  }

  /** Commits whatever the agent left uncommitted and summarises the change against the base. */
  async finalize(workdir: string, baseSha: string, message: string): Promise<DiffSummary> {
    const committed = await commitAll(workdir, message, {
      name: this.settings.authorName,
      email: this.settings.authorEmail,
    })
    const head = committed ?? (await headSha(workdir))
    return diffSummary(workdir, baseSha, head)
  }

  get author(): { name: string; email: string } {
    return { name: this.settings.authorName, email: this.settings.authorEmail }
  }

  /** Makes a commit available locally, fetching its branch if it was produced elsewhere. */
  async ensureCommit(
    payload: StartPayload,
    workdir: string,
    sha: string,
    branch: string | null,
  ): Promise<void> {
    if (await commitExists(workdir, sha)) return
    if (!payload.repository) throw new Error(`commit ${sha} is not available`)
    await this.repos.resolve(payload.repository.cloneUrl, sha).catch(async () => {
      if (branch) await this.repos.resolve(payload.repository!.cloneUrl, branch)
    })
    if (!(await commitExists(workdir, sha)))
      throw new Error(`commit ${sha.slice(0, 10)} could not be fetched`)
  }

  /** Repairs of a conflict start with the merge in progress so the agent sees both changes. */
  beginMerge(workdir: string, sha: string): Promise<string[]> {
    return beginMerge(workdir, sha)
  }

  get pushEnabled(): boolean {
    return this.settings.push
  }

  push(workdir: string, branch: string): Promise<void> {
    return pushBranch(workdir, branch, this.credentials.env)
  }
}

export interface IntegrationOutcome {
  merged: { taskId: string; taskKey: string; sha: string }[]
  conflict: { taskId: string; taskKey: string; conflicts: string[] } | null
  headSha: string
}

/** Merges accepted task commits in order; stops at the first conflict (PDF §14). */
export async function integrate(
  ws: Workspaces,
  payload: StartPayload,
  workdir: string,
  onMerged: (m: { taskId: string; taskKey: string; sha: string }) => Promise<void>,
): Promise<IntegrationOutcome> {
  const merged: IntegrationOutcome['merged'] = []
  for (const m of payload.integration?.merges ?? []) {
    await ws.ensureCommit(payload, workdir, m.sha, m.branch)
    const outcome = await mergeCommit(
      workdir,
      m.sha,
      `Integrate ${m.taskKey}: ${m.sha.slice(0, 10)}`,
      ws.author,
    )
    if (!outcome.ok) {
      return {
        merged,
        conflict: { taskId: m.taskId, taskKey: m.taskKey, conflicts: outcome.conflicts },
        headSha: await headSha(workdir),
      }
    }
    const entry = { taskId: m.taskId, taskKey: m.taskKey, sha: outcome.sha }
    merged.push(entry)
    await onMerged(entry)
  }
  return { merged, conflict: null, headSha: await headSha(workdir) }
}
