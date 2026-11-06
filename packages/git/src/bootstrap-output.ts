/**
 * What a repository's bootstrap leaves in a worktree (§14). `npm install` in a repository with no
 * lockfile writes one, and nothing ignores it. It is the machine's output, not the task's work, so
 * it stays out of a task commit, and the record lets a merge or a later attempt tell the two apart.
 *
 * - **The record is per worktree.** It sits in the worktree's admin directory: never in a commit,
 *   and gone with the worktree. A worktree without one (an older build's) excludes nothing.
 * - **Bytes decide.** A path stays the bootstrap's while its content is what the bootstrap left.
 *   Once a specialist changes it, it is the specialist's work and commits as usual.
 * - **A later bootstrap on the same worktree keeps the claim.** It rewrites nothing, so its own
 *   before and after match, and only the record says the file was never the specialist's.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git, gitLines } from './exec'
import { isMidMerge } from './merge'
import { assertSafeRef, headSha } from './worktrees'

/** Path to what it held, so a path deleted and a path emptied differ. */
export type DirtyFiles = Record<string, string>

/** The head a record was taken on, and the paths still as the bootstrap left them. */
export type BootstrapOutput = { head: string; paths: string[] }

const RECORD = 'mec-bootstrap.json'
const PATHSPECS = 'mec-pathspecs'
const ABSENT = 'absent'

async function adminDir(worktree: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--absolute-git-dir'], { cwd: worktree })
  return stdout.trim()
}

/** A symlink is its target and a nested repository its name: neither is read through. */
async function contentOf(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => undefined)
  if (stat === undefined) return ABSENT
  if (stat.isSymbolicLink()) return `link:${await readlink(path)}`
  if (stat.isDirectory()) return 'directory'
  return `file:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`
}

/** Paths git would stage here, `.mec/` aside. Renames read as a delete and an add. */
async function dirtyPaths(worktree: string): Promise<string[]> {
  const { stdout } = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ':!.mec'],
    { cwd: worktree },
  )
  return stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.slice(3).replace(/\/$/, ''))
}

export async function dirtyFiles(worktree: string): Promise<DirtyFiles> {
  const files: DirtyFiles = {}
  for (const path of await dirtyPaths(worktree)) files[path] = await contentOf(join(worktree, path))
  return files
}

async function readRecord(worktree: string): Promise<{ head: string; files: DirtyFiles } | undefined> {
  try {
    const text = await readFile(join(await adminDir(worktree), RECORD), 'utf8')
    const parsed = JSON.parse(text) as { head?: unknown; files?: unknown }
    if (typeof parsed.head !== 'string' || typeof parsed.files !== 'object' || parsed.files === null) {
      return undefined
    }
    return { head: parsed.head, files: parsed.files as DirtyFiles }
  } catch {
    return undefined
  }
}

/**
 * Call after the bootstrap, with `dirtyFiles` from before it. A path is the bootstrap's if this run
 * changed it, or if the last record claimed it and it still holds those bytes.
 */
export async function recordBootstrapOutput(worktree: string, before: DirtyFiles): Promise<void> {
  const prior = (await readRecord(worktree))?.files ?? {}
  const files: DirtyFiles = {}
  for (const [path, content] of Object.entries(await dirtyFiles(worktree))) {
    if (before[path] !== content || prior[path] === content) files[path] = content
  }
  const record = JSON.stringify({ head: await headSha(worktree), files })
  await writeFile(join(await adminDir(worktree), RECORD), record, { mode: 0o600 })
}

/** The recorded paths nobody has changed since. Undefined when there is nothing to keep out. */
export async function bootstrapOutput(worktree: string): Promise<BootstrapOutput | undefined> {
  const record = await readRecord(worktree)
  if (record === undefined) return undefined
  const paths: string[] = []
  for (const [path, content] of Object.entries(record.files)) {
    if ((await contentOf(join(worktree, path))) === content) paths.push(path)
  }
  return paths.length === 0 ? undefined : { head: record.head, paths }
}

/**
 * Puts these paths in the index back as `output.head` had them, so a commit leaves them out even if
 * a specialist staged or committed them. An unignored `node_modules` is tens of thousands of paths,
 * more than argv holds, so they go by file, and each is literal.
 */
export async function unstageBootstrapOutput(worktree: string, output: BootstrapOutput): Promise<void> {
  const file = join(await adminDir(worktree), PATHSPECS)
  await writeFile(file, output.paths.map((path) => `:(literal)${path}`).join('\0'))
  try {
    await git(['reset', '--quiet', output.head, `--pathspec-from-file=${file}`, '--pathspec-file-nul'], {
      cwd: worktree,
    })
  } finally {
    await rm(file, { force: true })
  }
}

const collides = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)

/**
 * Makes room for a merge in a machine-owned worktree: anything uncommitted on a path the task
 * branch brings goes, because no agent is in this worktree during a merge and git would refuse to
 * overwrite it. It covers worktrees with no record too, whose bootstrap ran under an older build.
 * Commits are never touched, and neither is a path the merge does not bring. Returns what went.
 */
export async function clearMergePath(opts: { worktree: string; taskBranch: string }): Promise<string[]> {
  const { worktree } = opts
  if (await isMidMerge(worktree)) return []
  const branch = assertSafeRef(opts.taskBranch)
  const dirty = await dirtyPaths(worktree)
  if (dirty.length === 0) return []
  const { stdout } = await git(['diff', '--name-only', '--no-renames', '-z', `HEAD...${branch}`], {
    cwd: worktree,
  })
  const incoming = stdout.split('\0').filter((path) => path !== '')
  const cleared = dirty.filter((path) => incoming.some((brought) => collides(path, brought)))
  if (cleared.length === 0) return []
  const tracked = new Set(await gitLines(['ls-files'], { cwd: worktree }))
  for (const path of cleared) {
    if (tracked.has(path))
      await git(['checkout', '--quiet', 'HEAD', '--', `:(literal)${path}`], { cwd: worktree })
    else await rm(join(worktree, path), { recursive: true, force: true })
  }
  return cleared
}
