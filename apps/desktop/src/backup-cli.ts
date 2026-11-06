/**
 * `mec backup` and `mec restore` (plan §20, §21.1), and the one way production takes a backup:
 * the Settings route and the CLI share `backupStore`, so neither can skip the database sweep.
 *
 * The CLI needs no server and no lock: it reads the store through a read-only connection, so it
 * works beside a running server and never writes the store. Restore writes only into a target
 * that is empty or absent, and a running server's lockfile makes its data dir non-empty.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KeyFingerprint } from '@mec/contracts'
import Database from 'better-sqlite3'
import { backup, redactForBackup } from './backup'
import { restoreStore, runRestoreDrill } from './restore'

const BACKUP_USAGE = 'usage: mec backup [--out <dir>]'
const RESTORE_USAGE = 'usage: mec restore <archive> [--target <dir>] | mec restore --drill <archive>'

type CliOut = { dataDir: string; stdout: (line: string) => void }

/** The fingerprints slot docs keep: enough for `redact`'s last-four sweep, and never a key. */
function slotFingerprints(db: Database.Database): KeyFingerprint[] {
  return db
    .prepare("SELECT json FROM docs WHERE kind = 'slot'")
    .pluck()
    .all()
    .flatMap((json) => {
      const { fingerprint } = JSON.parse(json as string) as { fingerprint?: KeyFingerprint }
      return fingerprint === undefined ? [] : [fingerprint]
    })
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`

/**
 * Redacts every text value of the private copy. No fingerprints here: their sweep takes any long
 * value with the same last four, such as an id another row points at, and every write to the
 * store already went through it. No column holds a BLOB. The final VACUUM drops the freed pages,
 * which still hold the old values. The live store is never opened for writing.
 */
function redactDbCopy(path: string): void {
  const copy = new Database(path)
  try {
    const tables = copy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .pluck()
      .all() as string[]
    let changed = false
    copy.transaction(() => {
      for (const table of tables) {
        const columns = copy.pragma(`table_info(${quoted(table)})`) as { name: string }[]
        for (const { name } of columns) {
          const column = quoted(name)
          const rows = copy
            .prepare(
              `SELECT rowid AS id, ${column} AS value FROM ${quoted(table)} WHERE typeof(${column}) = 'text'`,
            )
            .all() as { id: number; value: string }[]
          const save = copy.prepare(`UPDATE ${quoted(table)} SET ${column} = ? WHERE rowid = ?`)
          for (const { id, value } of rows) {
            const clean = redactForBackup(value)
            if (clean === value) continue
            save.run(clean, id)
            changed = true
          }
        }
      }
    })()
    if (changed) copy.exec('VACUUM')
  } finally {
    copy.close()
  }
}

/** §20: `VACUUM INTO` copies a WAL database consistently; the sweep runs on that copy. */
export function backupStore(
  db: Database.Database,
  dataDir: string,
  outDir: string,
): ReturnType<typeof backup> {
  return backup({
    dbPath: join(dataDir, 'mec.db'),
    stateDir: dataDir,
    outDir,
    fingerprints: slotFingerprints(db),
    copyDb: (_from, to) => {
      db.prepare('VACUUM INTO ?').run(to)
      redactDbCopy(to)
    },
  })
}

/** `<positional>` and the named value flags, or null for anything else. */
function parseArgs(
  argv: string[],
  flags: readonly string[],
): { positional: string[]; values: Map<string, string> } | null {
  const positional: string[] = []
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (!flags.includes(arg) || value === undefined || value.startsWith('--')) return null
    values.set(arg, value)
    i += 1
  }
  return { positional, values }
}

const plural = (count: number): string => `${count} file${count === 1 ? '' : 's'}`

export function runBackupCli(argv: string[], io: CliOut): number {
  const args = parseArgs(argv, ['--out'])
  if (args === null || args.positional.length > 0) {
    io.stdout(BACKUP_USAGE)
    return 1
  }
  let db: Database.Database | undefined
  try {
    db = new Database(join(io.dataDir, 'mec.db'), { readonly: true, fileMustExist: true })
    const taken = backupStore(db, io.dataDir, args.values.get('--out') ?? join(io.dataDir, 'backups'))
    io.stdout(`backup written: ${taken.archivePath}`)
    // Counts: a name in `excluded` is safe to keep, but a clone alone runs to thousands of lines.
    io.stdout(`${plural(taken.redacted.length)} redacted, ${plural(taken.excluded.length)} left out by rule`)
    return 0
  } catch (error) {
    io.stdout(`mec backup: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    db?.close()
  }
}

function runDrill(archivePath: string, io: CliOut): number {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'mec-restore-drill-'))
  try {
    const { ok, checks } = runRestoreDrill({ archivePath, scratchRoot })
    for (const [name, passed] of Object.entries(checks)) io.stdout(`${passed ? 'ok' : 'FAILED'} ${name}`)
    io.stdout(ok ? 'drill passed' : 'drill failed')
    return ok ? 0 : 1
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true })
  }
}

export function runRestoreCli(argv: string[], io: CliOut): number {
  const args = parseArgs(argv, ['--target', '--drill'])
  const drill = args?.values.get('--drill')
  if (args !== null && drill !== undefined && args.positional.length === 0 && args.values.size === 1) {
    return runDrill(drill, io)
  }
  const [archivePath] = args?.positional ?? []
  if (args === null || archivePath === undefined || args.positional.length > 1 || drill !== undefined) {
    io.stdout(RESTORE_USAGE)
    return 1
  }
  try {
    const dataDir = args.values.get('--target') ?? io.dataDir
    const { slotsToReprobe } = restoreStore({ archivePath, dataDir })
    io.stdout(`restored into ${dataDir}`)
    io.stdout(
      slotsToReprobe.length > 0
        ? `re-probe before scheduling: ${slotsToReprobe.join(', ')} (keys and sign-ins are never in a backup)`
        : 'no slot homes in this archive',
    )
    return 0
  } catch (error) {
    io.stdout(`mec restore: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
