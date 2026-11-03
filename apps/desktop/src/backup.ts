/**
 * `mec backup` (plan §20, Database-corruption row): a tar of the state directory plus the
 * database, with slot credential files and keystores excluded by exact path rules
 * (plan §5.4, §5.7): `keys` directories anywhere under `engines`, `.credentials.json`,
 * `auth.json`, `opencode.db`, `*.key`, `.salt`, the state-dir lock and lockfiles. Excluded
 * entries are reported by name only — no code path here reads or embeds their contents.
 *
 * The SQLite online-backup step is a hook: `copyDb` defaults to a plain file copy for this
 * pure-filesystem module; `packages/store` wires better-sqlite3's backup API at composition
 * so a running database is copied consistently. Symlinks are named as excluded and never
 * followed, so a link out of the state dir cannot drag credential material into the archive.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const DB_NAME = 'db.sqlite'
export const MANIFEST_NAME = 'manifest.json'

export type ExcludedKind =
  | 'engines-keys'
  | 'credentials'
  | 'auth'
  | 'opencode-db'
  | 'key-file'
  | 'salt'
  | 'lock'

/** First matching rule wins; the order is the plan's list (§5.7) followed by the lock rule. */
export function exclusionKindFor(relPath: string): ExcludedKind | null {
  const segments = relPath.split('/')
  const name = segments[segments.length - 1] ?? ''
  if (segments[0] === 'engines' && segments.includes('keys')) return 'engines-keys'
  if (name === '.credentials.json') return 'credentials'
  if (name === 'auth.json') return 'auth'
  if (name === 'opencode.db') return 'opencode-db'
  if (name.endsWith('.key')) return 'key-file'
  if (name === '.salt') return 'salt'
  if (isLockPath(segments, name)) return 'lock'
  return null
}

function isLockPath(segments: string[], name: string): boolean {
  if (segments[0] === 'lock') return true // the ~/.mec directory lock (plan §4)
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i] === '.mec' && segments[i + 1] === 'lock') return true
  }
  return name === 'lock' || name.endsWith('.lock')
}

/** Argv-only call into the system tar — no shell, no string commands; a missing tar is a clear error. */
export function runTar(args: string[]): void {
  const result = spawnSync('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const error = result.error
  if (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('system tar not found — mec backup and restore require tar on PATH')
    }
    throw new Error(`could not run tar: ${error.message}`)
  }
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim() ?? 'no stderr'
    throw new Error(`tar ${args.join(' ')} failed (exit ${result.status}): ${detail}`)
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

type TreeEntry = { rel: string; abs: string; dir: boolean; regular: boolean; kind: ExcludedKind | null }

/**
 * Full walk of the tree, sorted for reproducible archives. An entry under an excluded
 * directory inherits that directory's kind, so nothing inside `keys/` or the lock slips
 * through under an innocent basename.
 */
function collectStateTree(root: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  const visit = (relDir: string, forced: ExcludedKind | null): void => {
    const absDir = relDir === '' ? root : join(root, ...relDir.split('/'))
    let read: Dirent[]
    try {
      read = readdirSync(absDir, { withFileTypes: true })
    } catch (error) {
      if (relDir === '') throw error // a missing state dir is a misconfiguration, not an empty backup
      return // an unreadable subtree has nothing to copy and nothing to name
    }
    const sorted = [...read].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of sorted) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        const kind = forced ?? exclusionKindFor(rel)
        entries.push({ rel, abs: join(absDir, entry.name), dir: true, regular: false, kind })
        visit(rel, kind)
        continue
      }
      entries.push({
        rel,
        abs: join(absDir, entry.name),
        dir: false,
        regular: entry.isFile(),
        kind: forced ?? exclusionKindFor(rel),
      })
    }
  }
  visit('', null)
  return entries
}

/**
 * Files under `rootDir` matching a credential exclusion rule — the restore drill scans an
 * extracted tree with this. The lock kind is hygiene, not a credential.
 */
export function scanForCredentialFiles(rootDir: string): string[] {
  return collectStateTree(rootDir)
    .filter((entry) => !entry.dir && entry.kind !== null && entry.kind !== 'lock')
    .map((entry) => entry.rel)
}

function isAtOrUnder(ancestor: string, path: string): boolean {
  const a = resolve(ancestor)
  const p = resolve(path)
  return a === p || p.startsWith(`${a}${sep}`)
}

/** ISO-8601 with `:` replaced: colons are legal filenames but hostile to scp/rsync and friends. */
function fileStamp(now: Date): string {
  return now.toISOString().replaceAll(':', '-')
}

export type BackupInput = {
  dbPath: string
  stateDir: string
  outDir: string
  now?: Date
  /**
   * SQLite online backup hook (plan §20). The default cold copy serves tests and a stopped
   * app; production passes better-sqlite3's `db.backup()` (packages/store, at composition).
   */
  copyDb?: (from: string, to: string) => void
}

export function backup(input: BackupInput): { archivePath: string; excluded: string[] } {
  const now = input.now ?? new Date()
  const copyDb = input.copyDb ?? ((from: string, to: string) => copyFileSync(from, to))
  mkdirSync(input.outDir, { recursive: true })
  const stamp = fileStamp(now)
  const archivePath = join(input.outDir, `mec-backup-${stamp}.tgz`)
  const staging = mkdtempSync(join(input.outDir, `.mec-backup-staging-${stamp}-`))
  const excluded: string[] = []
  try {
    // (1) the database travels exactly once, through the online-backup hook
    copyDb(input.dbPath, join(staging, DB_NAME))

    // (2) the state tree, filtered by the exact exclusion rules
    const dbAbs = resolve(input.dbPath)
    const liveDbFiles = new Set([dbAbs, `${dbAbs}-wal`, `${dbAbs}-shm`, `${dbAbs}-journal`])
    for (const entry of collectStateTree(input.stateDir)) {
      if (isAtOrUnder(staging, entry.abs)) continue // outDir inside stateDir must not archive itself
      if (entry.kind !== null) {
        if (!entry.dir) excluded.push(entry.rel)
        continue
      }
      if (entry.dir) {
        mkdirSync(join(staging, entry.rel), { recursive: true }) // empty dirs survive — slot homes must exist for re-probe
        continue
      }
      if (!entry.regular) {
        excluded.push(entry.rel) // symlinks and specials: named, never followed, never copied
        continue
      }
      if (liveDbFiles.has(resolve(entry.abs))) continue // the live db enters only via copyDb
      const dest = join(staging, entry.rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(entry.abs, dest)
    }

    // (4) the manifest is written before tarring so it travels inside the archive
    const kinds = [
      ...new Set(excluded.map((p) => exclusionKindFor(p)).filter((k): k is ExcludedKind => k !== null)),
    ].sort()
    const manifest = {
      created_at: now.toISOString(),
      db_sha256: sha256File(join(staging, DB_NAME)),
      excluded_kinds: kinds,
    }
    writeFileSync(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)

    // (3) one tar of the db plus the filtered state tree
    runTar(['-czf', archivePath, '-C', staging, '.'])
    return { archivePath, excluded }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
