import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backup } from '../src/backup'
import { restore, runRestoreDrill } from '../src/restore'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mec-restore-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

/** A minimal fake ~/.mec: one claude slot with credentials excluded by backup, db, journal. */
function makeArchive(): string {
  const stateDir = freshDir()
  const slot = join(stateDir, 'engines/claude/s1')
  mkdirSync(join(slot, 'keys'), { recursive: true })
  writeFileSync(join(slot, 'keys/anthropic.key'), 'key-material-never-to-leave-the-machine')
  writeFileSync(join(slot, '.credentials.json'), '{"oauth":"never-to-leave-the-machine"}')
  writeFileSync(join(slot, 'settings.json'), '{"env":{}}')
  mkdirSync(join(stateDir, 'journal'))
  writeFileSync(join(stateDir, 'journal/000001.jsonl'), '{"event":"attempt_started"}\n')
  writeFileSync(join(stateDir, 'db.sqlite'), 'fake sqlite pages')
  return backup({
    dbPath: join(stateDir, 'db.sqlite'),
    stateDir,
    outDir: freshDir(),
    now: new Date('2026-11-03T10:00:00.000Z'),
  }).archivePath
}

/** Re-pack an archive with a modified db so its sha no longer matches the manifest. */
function tamperWithDb(archivePath: string): string {
  const tree = freshDir()
  execFileSync('tar', ['-xzf', archivePath, '-C', tree])
  const db = join(tree, 'db.sqlite')
  writeFileSync(db, `${readFileSync(db, 'utf8')}tampered`)
  const tampered = join(freshDir(), 'tampered.tgz')
  execFileSync('tar', ['-czf', tampered, '-C', tree, '.'])
  return tampered
}

describe('restore', () => {
  it('round-trips a backup into a fresh target and lists slot homes to re-probe', () => {
    const archivePath = makeArchive()
    const target = join(freshDir(), 'restored') // does not exist yet
    const result = restore({ archivePath, targetDir: target })

    expect(result.restoredDb).toBe(join(target, 'db.sqlite'))
    expect(readFileSync(result.restoredDb, 'utf8')).toBe('fake sqlite pages')
    expect(result.slotsToReprobe).toEqual(['s1'])
    expect(existsSync(join(target, 'engines/claude/s1/settings.json'))).toBe(true)
    expect(existsSync(join(target, 'engines/claude/s1/keys/anthropic.key'))).toBe(false)
  })

  it('accepts an existing but empty target', () => {
    const archivePath = makeArchive()
    const target = freshDir()
    expect(() => restore({ archivePath, targetDir: target })).not.toThrow()
    expect(existsSync(join(target, 'db.sqlite'))).toBe(true)
  })

  it('refuses a non-empty target', () => {
    const archivePath = makeArchive()
    const target = freshDir()
    writeFileSync(join(target, 'leftover'), 'precious user data')
    expect(() => restore({ archivePath, targetDir: target })).toThrow(/not empty/)
  })

  it('refuses an archive whose db sha does not match the manifest', () => {
    const tampered = tamperWithDb(makeArchive())
    expect(() => restore({ archivePath: tampered, targetDir: join(freshDir(), 'target') })).toThrow(
      /sha256 mismatch/,
    )
  })
})

describe('runRestoreDrill', () => {
  it('is all green on a good archive', () => {
    const drill = runRestoreDrill({ archivePath: makeArchive(), scratchRoot: freshDir() })
    expect(drill.ok).toBe(true)
    expect(drill.checks).toEqual({
      db_exists: true,
      db_sha_matches: true,
      no_credential_files: true,
      slots_to_reprobe: true,
    })
  })

  it('fails on a tampered archive whose db sha mismatches', () => {
    const tampered = tamperWithDb(makeArchive())
    const drill = runRestoreDrill({ archivePath: tampered, scratchRoot: freshDir() })
    expect(drill.ok).toBe(false)
    expect(drill.checks.db_sha_matches).toBe(false)
  })

  it('passes vacuously when the archive has no slot homes', () => {
    const stateDir = freshDir()
    mkdirSync(join(stateDir, 'journal'))
    writeFileSync(join(stateDir, 'journal/000001.jsonl'), '{"event":"attempt_started"}\n')
    writeFileSync(join(stateDir, 'db.sqlite'), 'fake sqlite pages')
    const archivePath = backup({
      dbPath: join(stateDir, 'db.sqlite'),
      stateDir,
      outDir: freshDir(),
      now: new Date('2026-11-03T10:00:00.000Z'),
    }).archivePath

    const drill = runRestoreDrill({ archivePath, scratchRoot: freshDir() })
    expect(drill.checks.slots_to_reprobe).toBe(true)
    expect(drill.ok).toBe(true)
  })
})
