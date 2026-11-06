/**
 * `mec restore` and the restore drill (plan §20, Database-corruption row): extract a
 * `mec backup` archive into a target that must not exist or be empty, verify the extracted
 * database against the manifest's sha256, and list the slot homes that came back. Their
 * credentials were excluded at backup time, so every listed slot must re-probe (plan §5.8)
 * before the scheduler may use it again.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { DB_NAME, MANIFEST_NAME, runTar, scanForCredentialFiles, sha256File } from './backup'

export type RestoreInput = { archivePath: string; targetDir: string }

export type RestoreResult = { restoredDb: string; slotsToReprobe: string[] }

export type DrillResult = { ok: boolean; checks: Record<string, boolean> }

function assertEmptyOrAbsent(targetDir: string): void {
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`restore target ${targetDir} is not empty — restore refuses to overwrite`)
  }
}

export function restore(input: RestoreInput): RestoreResult {
  if (!existsSync(input.archivePath)) throw new Error(`archive not found: ${input.archivePath}`)
  assertEmptyOrAbsent(input.targetDir)
  mkdirSync(input.targetDir, { recursive: true })
  runTar(['-xzf', input.archivePath, '-C', input.targetDir])

  const dbPath = join(input.targetDir, DB_NAME)
  const manifestPath = join(input.targetDir, MANIFEST_NAME)
  if (!existsSync(manifestPath)) throw new Error('archive has no manifest.json — not a mec backup')
  if (!existsSync(dbPath)) throw new Error('archive has no db.sqlite — not a mec backup')
  const expected = parseManifestSha(manifestPath)
  const actual = sha256File(dbPath)
  if (actual !== expected) {
    throw new Error(
      `db sha256 mismatch — manifest says ${expected}, extracted db is ${actual}; the archive is damaged or tampered`,
    )
  }
  return { restoredDb: dbPath, slotsToReprobe: slotNames(input.targetDir) }
}

/** What a data dir calls the database that an archive calls `DB_NAME`. */
const STORE_NAME = 'mec.db'

/**
 * `mec restore`: the archive becomes a data dir the next server opens. It is staged beside the
 * target and verified there, so a damaged archive never reaches the target. The final rename
 * refuses an occupied target by itself (ENOTEMPTY), so a store that appears after the first
 * check still survives; only the staging directory this call made is ever removed.
 */
export function restoreStore(input: { archivePath: string; dataDir: string }): RestoreResult {
  if (!existsSync(input.archivePath)) throw new Error(`archive not found: ${input.archivePath}`)
  assertEmptyOrAbsent(input.dataDir)
  mkdirSync(dirname(input.dataDir), { recursive: true })
  const staging = mkdtempSync(`${input.dataDir}.restore-`)
  try {
    const { restoredDb, slotsToReprobe } = restore({ archivePath: input.archivePath, targetDir: staging })
    renameSync(restoredDb, join(staging, STORE_NAME))
    requireReprobe(join(staging, STORE_NAME))
    renameSync(staging, input.dataDir)
    return { restoredDb: join(input.dataDir, STORE_NAME), slotsToReprobe }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** §20: the scheduler and the launcher take only a `healthy` slot, so none may stay one unprobed. */
function requireReprobe(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    const rows = db.prepare("SELECT id, json FROM docs WHERE kind = 'slot'").all() as {
      id: string
      json: string
    }[]
    const save = db.prepare('UPDATE docs SET json = ? WHERE id = ?')
    for (const row of rows) {
      const doc = JSON.parse(row.json) as { state?: unknown }
      if (doc.state === 'healthy') save.run(JSON.stringify({ ...doc, state: 'home_ready' }), row.id)
    }
  } finally {
    db.close()
  }
}

function parseManifestSha(path: string): string {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('manifest.json is not valid JSON — the archive is damaged')
  }
  const sha = (raw as { db_sha256?: unknown })?.db_sha256
  if (typeof sha !== 'string') throw new Error('manifest.json has no db_sha256 — the archive is damaged')
  return sha
}

type SlotHome = { engine: string; slot: string }

/** Slot homes present in the tree: `engines/<engine>/<slot>/` directories. */
function slotHomes(root: string): SlotHome[] {
  const enginesDir = join(root, 'engines')
  if (!existsSync(enginesDir)) return []
  const homes: SlotHome[] = []
  for (const engine of readdirSync(enginesDir, { withFileTypes: true })) {
    if (!engine.isDirectory()) continue
    for (const slot of readdirSync(join(enginesDir, engine.name), { withFileTypes: true })) {
      if (slot.isDirectory()) homes.push({ engine: engine.name, slot: slot.name })
    }
  }
  return homes
}

function slotNames(root: string): string[] {
  return [...new Set(slotHomes(root).map((home) => home.slot))].sort()
}

/**
 * The drill (v1 port, plan §20): restore into a scratch dir and judge the extracted tree —
 * db present with a matching sha, no credential file anywhere in it, and a non-empty
 * re-probe list whenever slot homes exist. A failed restore still leaves the extracted
 * tree in place for the checks to judge; the caller cleans `scratchRoot`.
 */
export function runRestoreDrill(input: { archivePath: string; scratchRoot: string }): DrillResult {
  mkdirSync(input.scratchRoot, { recursive: true })
  const target = mkdtempSync(join(input.scratchRoot, 'drill-'))
  let slots: string[] = []
  try {
    slots = restore({ archivePath: input.archivePath, targetDir: target }).slotsToReprobe
  } catch {
    // reported as facts below, not as a throw
  }
  const dbPath = join(target, DB_NAME)
  const checks: Record<string, boolean> = {
    db_exists: existsSync(dbPath),
    db_sha_matches: manifestShaMatches(target, dbPath),
    no_credential_files: scanForCredentialFiles(target).length === 0,
    slots_to_reprobe: slotHomes(target).length === 0 || slots.length > 0,
  }
  return { ok: Object.values(checks).every(Boolean), checks }
}

function manifestShaMatches(target: string, dbPath: string): boolean {
  try {
    return sha256File(dbPath) === parseManifestSha(join(target, MANIFEST_NAME))
  } catch {
    return false
  }
}
