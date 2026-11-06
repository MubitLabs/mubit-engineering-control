import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backup, MANIFEST_NAME, scanForCredentialFiles } from '../src/backup'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mec-backup-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

/** A fake ~/.mec: slot homes with credential material, the live db, journals, the dir lock. */
function makeStateDir(): { stateDir: string; dbPath: string } {
  const stateDir = freshDir()

  const claude = join(stateDir, 'engines/claude/s1')
  mkdirSync(join(claude, 'keys'), { recursive: true })
  writeFileSync(join(claude, 'keys/anthropic.key'), 'key-material-never-to-leave-the-machine')
  writeFileSync(join(claude, '.credentials.json'), '{"oauth":"never-to-leave-the-machine"}')
  writeFileSync(join(claude, 'settings.json'), '{"env":{}}')

  const codex = join(stateDir, 'engines/codex/c1')
  mkdirSync(codex, { recursive: true })
  writeFileSync(join(codex, 'auth.json'), '{"OPENAI_API_KEY":"never-to-leave-the-machine"}')
  writeFileSync(join(codex, 'config.toml'), 'model = "gpt-5.3"\n')

  const opencode = join(stateDir, 'engines/opencode/o1')
  mkdirSync(join(opencode, 'data'), { recursive: true })
  writeFileSync(join(opencode, 'data/opencode.db'), 'opencode credential store')
  writeFileSync(join(opencode, 'opencode.json'), '{}')

  mkdirSync(join(stateDir, 'journal'))
  writeFileSync(join(stateDir, 'journal/000001.jsonl'), '{"event":"attempt_started"}\n')
  writeFileSync(join(stateDir, 'journal/journal.lock'), 'locked')

  mkdirSync(join(stateDir, 'lock'))
  writeFileSync(join(stateDir, 'lock/holder'), 'pid 421')
  writeFileSync(join(stateDir, '.salt'), 'per-install-salt')

  const dbPath = join(stateDir, 'db.sqlite')
  writeFileSync(dbPath, 'fake sqlite pages')
  return { stateDir, dbPath }
}

function extract(archivePath: string): string {
  const dir = freshDir()
  execFileSync('tar', ['-xzf', archivePath, '-C', dir])
  return dir
}

describe('backup', () => {
  const now = new Date('2026-11-03T10:00:00.000Z')

  it('writes mec-backup-<ISOtimestamp>.tgz into outDir', () => {
    const { stateDir, dbPath } = makeStateDir()
    const outDir = freshDir()
    const result = backup({ dbPath, stateDir, outDir, now })
    expect(result.archivePath).toBe(join(outDir, 'mec-backup-2026-11-03T10-00-00.000Z.tgz'))
    expect(existsSync(result.archivePath)).toBe(true)
  })

  it('archives the db and state tree but no credential or lock path', () => {
    const { stateDir, dbPath } = makeStateDir()
    const result = backup({ dbPath, stateDir, outDir: freshDir(), now })
    const tree = extract(result.archivePath)

    expect(readFileSync(join(tree, 'db.sqlite'), 'utf8')).toBe('fake sqlite pages')
    expect(readFileSync(join(tree, 'journal/000001.jsonl'), 'utf8')).toContain('attempt_started')
    expect(existsSync(join(tree, 'engines/claude/s1/settings.json'))).toBe(true)
    expect(existsSync(join(tree, 'engines/codex/c1/config.toml'))).toBe(true)
    expect(existsSync(join(tree, 'engines/opencode/o1/opencode.json'))).toBe(true)

    const gone = [
      'engines/claude/s1/keys',
      'engines/claude/s1/keys/anthropic.key',
      'engines/claude/s1/.credentials.json',
      'engines/codex/c1/auth.json',
      'engines/opencode/o1/data/opencode.db',
      'journal/journal.lock',
      'lock',
      'lock/holder',
      '.salt',
    ]
    for (const path of gone) {
      expect(existsSync(join(tree, path)), path).toBe(false)
    }
  })

  it('lists excluded paths by name only — never their contents', () => {
    const { stateDir, dbPath } = makeStateDir()
    const result = backup({ dbPath, stateDir, outDir: freshDir(), now })
    for (const path of [
      'engines/claude/s1/keys/anthropic.key',
      'engines/claude/s1/.credentials.json',
      'engines/codex/c1/auth.json',
      'engines/opencode/o1/data/opencode.db',
      'journal/journal.lock',
      'lock/holder',
      '.salt',
    ]) {
      expect(result.excluded, path).toContain(path)
    }
    expect(JSON.stringify(result)).not.toContain('never-to-leave-the-machine')
    expect(JSON.stringify(result)).not.toContain('key-material')
    expect(JSON.stringify(result)).not.toContain('per-install-salt')
  })

  // §12: a running attempt's bearer token sits in its worktree, and Settings backs up a live server.
  it('leaves out a running attempt\'s .mec files and keeps its work', () => {
    const { stateDir, dbPath } = makeStateDir()
    const worktree = join(stateDir, 'work/att_1')
    mkdirSync(join(worktree, '.mec'), { recursive: true })
    writeFileSync(join(worktree, '.mec/mcp.json'), '{"headers":{"Authorization":"Bearer never-archived"}}')
    writeFileSync(join(worktree, 'made.txt'), 'made\n')

    const result = backup({ dbPath, stateDir, outDir: freshDir(), now })
    const tree = extract(result.archivePath)

    expect(existsSync(join(tree, 'work/att_1/.mec/mcp.json'))).toBe(false)
    expect(readFileSync(join(tree, 'work/att_1/made.txt'), 'utf8')).toBe('made\n')
    expect(result.excluded).toContain('work/att_1/.mec/mcp.json')
    expect(JSON.stringify(result)).not.toContain('never-archived')
    expect(scanForCredentialFiles(tree)).toEqual([])
  })

  it('writes a manifest inside the archive whose db_sha256 matches the archived db', () => {
    const { stateDir, dbPath } = makeStateDir()
    const result = backup({ dbPath, stateDir, outDir: freshDir(), now })
    const tree = extract(result.archivePath)

    const manifest = JSON.parse(readFileSync(join(tree, MANIFEST_NAME), 'utf8'))
    expect(manifest.created_at).toBe('2026-11-03T10:00:00.000Z')
    const sha = createHash('sha256')
      .update(readFileSync(join(tree, 'db.sqlite')))
      .digest('hex')
    expect(manifest.db_sha256).toBe(sha)
    expect(manifest.excluded_kinds).toEqual(
      expect.arrayContaining(['engines-keys', 'credentials', 'auth', 'opencode-db', 'salt', 'lock']),
    )
  })

  it('takes the db through the copyDb hook (production wires better-sqlite3 here)', () => {
    const { stateDir, dbPath } = makeStateDir()
    const result = backup({
      dbPath,
      stateDir,
      outDir: freshDir(),
      now,
      copyDb: (from, to) => {
        writeFileSync(to, `online backup of ${readFileSync(from, 'utf8')}`)
      },
    })
    const tree = extract(result.archivePath)
    expect(readFileSync(join(tree, 'db.sqlite'), 'utf8')).toBe('online backup of fake sqlite pages')
  })

  it('names symlinks as excluded and never follows them out of the state dir', () => {
    const { stateDir, dbPath } = makeStateDir()
    const outside = freshDir()
    writeFileSync(join(outside, 'outside-secret'), 'a-secret-outside-the-state-dir')
    symlinkSync(join(outside, 'outside-secret'), join(stateDir, 'engines/claude/s1/link-to-outside'))

    const result = backup({ dbPath, stateDir, outDir: freshDir(), now })
    expect(result.excluded).toContain('engines/claude/s1/link-to-outside')

    const tree = extract(result.archivePath)
    expect(existsSync(join(tree, 'engines/claude/s1/link-to-outside'))).toBe(false)
    expect(JSON.stringify(result)).not.toContain('a-secret-outside')
  })

  it('throws a clear error when the system tar is missing', () => {
    const { stateDir, dbPath } = makeStateDir()
    const previousPath = process.env.PATH
    process.env.PATH = ''
    try {
      expect(() => backup({ dbPath, stateDir, outDir: freshDir(), now })).toThrow(/tar/)
    } finally {
      process.env.PATH = previousPath
    }
  })
})
