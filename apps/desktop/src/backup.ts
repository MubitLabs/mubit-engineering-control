/**
 * `mec backup` (plan §20, Database-corruption row): a tar of the state directory plus the
 * database, with slot credential files and keystores excluded by exact path rules
 * (plan §5.4, §5.7): `keys` directories anywhere under `engines`, `.credentials.json`,
 * `auth.json`, `opencode.db`, `*.key`, `.salt`, the state-dir lock and lockfiles, and each
 * attempt worktree's `.mec/` (§12). Excluded
 * entries are reported by name only — no code path here reads or embeds their contents.
 *
 * Everything else may hold a token an engine wrote into a transcript (spec line 558, §5.4), so
 * each file is read once and written out through `redactForBackup`. A file that cannot go
 * through redaction (binary, compressed, not UTF-8, unreadable) is left out by name, and the
 * bare clones under `repos/` go out whole: their objects are compressed, and `RepoCache`
 * re-clones a missing clone where a half-copied one would break it.
 *
 * The SQLite online-backup step is a hook: `copyDb` defaults to a plain file copy for this
 * pure-filesystem module; `packages/store` wires better-sqlite3's backup API at composition
 * so a running database is copied consistently. Symlinks are named as excluded and never
 * followed, so a link out of the state dir cannot drag credential material into the archive.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { KeyFingerprint } from '@mec/contracts'
import { redact } from '@mec/slots'

export const DB_NAME = 'db.sqlite'
export const MANIFEST_NAME = 'manifest.json'
const STAGING_PREFIX = '.mec-backup-staging-'
const ARCHIVE_NAME = /^mec-backup-.*\.tgz$/

export type ExcludedKind =
  | 'engines-keys'
  | 'credentials'
  | 'auth'
  | 'opencode-db'
  | 'key-file'
  | 'salt'
  | 'lock'
  | 'attempt-files'
  | 'repo-clone'

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
  // A worktree's `.mec/` holds the running attempt's bearer token, and a live server can back up.
  // On a case-folding volume the launcher's `.mec/` lands in a tracked `.MEC/`, so case never counts.
  if (segments[0] === 'work' && segments[2]?.toLowerCase() === '.mec') return 'attempt-files'
  if (segments[0] === 'repos') return 'repo-clone'
  return null
}

/**
 * Shapes only a backup has to catch: `redact` knows provider keys, but a `MEC_TOOLS_TOKEN` is
 * redacted live by its exact value, which dies with the process that issued it. The first
 * pattern is that token's own shape, base64url JSON and a signature, and so also a JWT; the
 * second is any bearer header, whatever the token looks like.
 */
const BACKUP_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+)?/g,
    label: '[redacted:mec-tools]',
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, label: 'Bearer [redacted]' },
]

/**
 * A transcript is JSONL, so a newline in it is a backslash and an `n`. That `n` is a word
 * character, so no shape's `\b` holds before a token at the start of a line. A quote ends the
 * run the last-four sweep looks at. A backslash alone is here for JSON nested in JSON, and only
 * the last backslash of a run counts, so `\\n` still frees what follows the `n`. No shape holds
 * any of these characters, so a cut never splits a token.
 */
const JSON_SEPARATOR = /(\\u[0-9a-fA-F]{4}|\\[nrtbf]|\\|")/

/** Below every shape's length and the sweep's: a transcript cuts into millions of short pieces. */
const SHORTEST_SECRET = 20

function redactPiece(text: string, fingerprints: readonly KeyFingerprint[]): string {
  let out = redact(text, fingerprints)
  for (const { pattern, label } of BACKUP_PATTERNS) out = out.replace(pattern, label)
  return out
}

/** One pass over any text a backup writes. Fingerprints only: a backup never reads a key. */
export function redactForBackup(text: string, fingerprints: readonly KeyFingerprint[] = []): string {
  return text
    .split(JSON_SEPARATOR)
    .map((piece, index) =>
      index % 2 === 1 || piece.length < SHORTEST_SECRET ? piece : redactPiece(piece, fingerprints),
    )
    .join('')
}

/** The file's text, or null when redaction could not see all of it. */
function readScannable(path: string): string | null {
  try {
    const bytes = readFileSync(path)
    if (bytes.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
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
 * extracted tree with this. The lock and clone kinds are hygiene, not credentials.
 */
export function scanForCredentialFiles(rootDir: string): string[] {
  return collectStateTree(rootDir)
    .filter(
      (entry) => !entry.dir && entry.kind !== null && entry.kind !== 'lock' && entry.kind !== 'repo-clone',
    )
    .map((entry) => entry.rel)
}

/**
 * Only what a backup itself writes, plus the folder they sit in, so `--out` can name any folder:
 * the data dir, a parent of it, or a state folder. A file beside the archives is state like any
 * other, and its copy brings the folder back.
 */
function isBackupOutput(outDir: string, path: string): boolean {
  const [first = ''] = relative(resolve(outDir), resolve(path)).split(sep)
  return first === '' || first.startsWith(STAGING_PREFIX) || ARCHIVE_NAME.test(first)
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
  /** Turns on `redact`'s last-four sweep for key material no pattern knows. */
  fingerprints?: readonly KeyFingerprint[]
}

export function backup(input: BackupInput): { archivePath: string; excluded: string[]; redacted: string[] } {
  const now = input.now ?? new Date()
  const copyDb = input.copyDb ?? ((from: string, to: string) => copyFileSync(from, to))
  mkdirSync(input.outDir, { recursive: true })
  const stamp = fileStamp(now)
  const archivePath = join(input.outDir, `mec-backup-${stamp}.tgz`)
  const staging = mkdtempSync(join(input.outDir, `${STAGING_PREFIX}${stamp}-`))
  const excluded: string[] = []
  const redacted: string[] = []
  try {
    // (1) the database travels exactly once, through the online-backup hook
    copyDb(input.dbPath, join(staging, DB_NAME))

    // (2) the state tree, filtered by the exact exclusion rules
    const dbAbs = resolve(input.dbPath)
    const liveDbFiles = new Set([dbAbs, `${dbAbs}-wal`, `${dbAbs}-shm`, `${dbAbs}-journal`])
    for (const entry of collectStateTree(input.stateDir)) {
      if (isBackupOutput(input.outDir, entry.abs)) continue // outDir inside stateDir must not archive itself
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
      // Written from the text that was swept: a second read could see a live file's newer bytes.
      const text = readScannable(entry.abs)
      if (text === null) {
        excluded.push(entry.rel)
        continue
      }
      const clean = redactForBackup(text, input.fingerprints)
      if (clean !== text) redacted.push(entry.rel)
      const dest = join(staging, entry.rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, clean, { mode: statSync(entry.abs).mode & 0o777 })
    }

    // (4) the manifest is written before tarring so it travels inside the archive
    const kinds = [
      ...new Set(excluded.map((p) => exclusionKindFor(p)).filter((k): k is ExcludedKind => k !== null)),
    ].sort()
    const manifest = {
      created_at: now.toISOString(),
      db_sha256: sha256File(join(staging, DB_NAME)),
      excluded_kinds: kinds,
      redacted_files: redacted.length,
    }
    writeFileSync(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)

    // (3) one tar of the db plus the filtered state tree
    runTar(['-czf', archivePath, '-C', staging, '.'])
    chmodSync(archivePath, 0o600) // chat, journals and work: the owner's, whatever the umask says
    return { archivePath, excluded, redacted }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
