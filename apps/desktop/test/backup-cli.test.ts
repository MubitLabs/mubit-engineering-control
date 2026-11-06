import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { issueToken } from '@mec/mec-tools'
import { MIGRATIONS_v1, migrate } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backup, scanForCredentialFiles } from '../src/backup'
import { runCli } from '../src/mec'

/** §20, §5.4, §13 invariant 3: `mec backup` and `mec restore`, and no token in anything they write. */

const dirs: string[] = []
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mec-backup-cli-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

// Synthetic, assembled at run time, so no key-shaped literal lands in the source.
const TOOLS_TOKEN = issueToken({
  attemptId: 'att_backup_test',
  generation: 3,
  role: 'specialist',
  secret: 'synthetic-secret-for-this-test',
})
const GITHUB_TOKEN = `ghp_${'a1B2'.repeat(10)}`
const BEARER = `Bearer ${'opaque9'.repeat(4)}`
const TOKENS = [TOOLS_TOKEN, GITHUB_TOKEN, BEARER.slice('Bearer '.length)]
const EVERY_SHAPE = [
  TOOLS_TOKEN,
  GITHUB_TOKEN,
  `github_pat_${'a1B2'.repeat(11)}`,
  `sk-ant-${'a1B2'.repeat(6)}`,
  `sk-proj-${'a1B2'.repeat(6)}`,
  `sk-${'a1B2'.repeat(9)}`,
  `AIza${'a1B2'.repeat(9)}`.slice(0, 39),
  `AQ.Ab${'a1B2'.repeat(6)}`,
  `${'a1'.repeat(16)}.${'aB'.repeat(8)}`,
]

function cliIo(dataDir: string) {
  const lines: string[] = []
  const io = {
    readSnapshotText: () => null,
    initialized: () => true,
    markerDir: dataDir,
    dataDir,
    stdout: (line: string) => {
      lines.push(line)
    },
    startServer: async () => {},
  }
  return { io, lines }
}

const out = (lines: string[]): string => lines.join('\n')

/** A real store with a slot, plus a token in a doc and an event, the way an unredacted row would hold one. */
function makeDataDir(): string {
  const dataDir = join(fresh(), 'data')
  mkdirSync(dataDir)
  const db = new Database(join(dataDir, 'mec.db'))
  db.pragma('journal_mode = WAL')
  migrate(db, MIGRATIONS_v1)
  const at = '2026-11-06T10:00:00.000Z'
  const doc = db.prepare('INSERT INTO docs (id, kind, json, updated_at) VALUES (?, ?, ?, ?)')
  doc.run('s1', 'slot', JSON.stringify({ id: 's1', label: 'one', state: 'healthy' }), at)
  doc.run('s2', 'slot', JSON.stringify({ id: 's2', label: 'two', state: 'retired' }), at)
  doc.run('c1', 'card', JSON.stringify({ id: 'c1', evidence: `saw ${TOOLS_TOKEN} and ${GITHUB_TOKEN}` }), at)
  // Stored JSON writes a newline as backslash and `n`, the `n` touching the token.
  doc.run('c3', 'card', JSON.stringify({ id: 'c3', evidence: `done\n${TOOLS_TOKEN}\n${GITHUB_TOKEN}\n` }), at)
  // Long enough for overflow pages: the update frees them, and a freed page keeps its old bytes.
  doc.run('c2', 'card', JSON.stringify({ id: 'c2', evidence: `${GITHUB_TOKEN} `.repeat(1000) }), at)
  db.prepare('INSERT INTO events (stream, seq, at, type, body) VALUES (?, ?, ?, ?, ?)').run(
    'task-1',
    1,
    at,
    'note',
    JSON.stringify({ text: `Authorization: ${BEARER}` }),
  )
  db.close()
  const slot = join(dataDir, 'engines/claude/s1')
  mkdirSync(join(slot, 'keys'), { recursive: true })
  writeFileSync(join(slot, 'keys/anthropic-api.key'), 'synthetic-key-bytes')
  writeFileSync(join(slot, 'settings.json'), '{}')
  return dataDir
}

function extract(archivePath: string): string {
  const tree = fresh()
  execFileSync('tar', ['-xzf', archivePath, '-C', tree])
  return tree
}

function allFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function expectNoToken(root: string): void {
  for (const file of allFiles(root)) {
    const raw = readFileSync(file).toString('latin1')
    for (const token of TOKENS) expect(raw.includes(token), `${file} holds a token`).toBe(false)
  }
}

async function takeBackup(dataDir: string): Promise<string> {
  const outDir = fresh()
  const { io, lines } = cliIo(dataDir)
  expect(await runCli(['backup', '--out', outDir], io), out(lines)).toBe(0)
  const archives = readdirSync(outDir).filter((name) => name.endsWith('.tgz'))
  expect(archives).toHaveLength(1)
  return join(outDir, archives[0] as string)
}

function damage(archivePath: string): string {
  const tree = extract(archivePath)
  writeFileSync(join(tree, 'db.sqlite'), 'damaged')
  const damaged = join(fresh(), 'damaged.tgz')
  execFileSync('tar', ['-czf', damaged, '-C', tree, '.'])
  return damaged
}

describe('every backup output goes through redaction or leaves the content out', () => {
  const now = new Date('2026-11-06T10:00:00.000Z')

  function transcriptState(): { stateDir: string; dbPath: string; transcript: string } {
    const stateDir = fresh()
    const dbPath = join(stateDir, 'mec.db')
    writeFileSync(dbPath, 'fake sqlite pages')
    const transcript = 'engines/claude/s1/projects/p/session.jsonl'
    mkdirSync(dirname(join(stateDir, transcript)), { recursive: true })
    return { stateDir, dbPath, transcript }
  }

  it('a transcript keeps its text and loses every token shape', () => {
    const { stateDir, dbPath, transcript } = transcriptState()
    const line = `{"tool":"Bash","env":"MEC_TOOLS_TOKEN=${TOOLS_TOKEN}","out":"${GITHUB_TOKEN}","h":"${BEARER}"}\n`
    writeFileSync(join(stateDir, transcript), `{"text":"keep this line"}\n${line}`)

    const result = backup({ dbPath, stateDir, outDir: fresh(), now })
    const tree = extract(result.archivePath)

    expectNoToken(tree)
    const text = readFileSync(join(tree, transcript), 'utf8')
    expect(text).toContain('keep this line')
    expect(text).toContain('[redacted:')
    expect(result.redacted).toEqual([transcript])
    expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN)
    expect(readFileSync(join(stateDir, transcript), 'utf8')).toContain(GITHUB_TOKEN) // stored data is untouched
  })

  it('a key known only by its fingerprint goes too, and the key is never read', () => {
    const { stateDir, dbPath, transcript } = transcriptState()
    const key = 'unpatterned-key-material-wxyz'
    writeFileSync(join(stateDir, transcript), `the key was ${key} here\n`)

    const fingerprints = [{ provider: 'zai-coding-plan', last4: 'wxyz', sha256: 'f'.repeat(64) }] as never
    const result = backup({ dbPath, stateDir, outDir: fresh(), now, fingerprints })

    expect(readFileSync(join(extract(result.archivePath), transcript), 'utf8')).not.toContain(key)
  })

  // JSONL stores a newline as backslash and `n`: the `n` is a word character, so `\b` fails before the token.
  it.each([
    ['a newline', '\n'],
    ['a carriage return', '\r'],
    ['a tab', '\t'],
    ['a backspace', '\b'],
    ['a form feed', '\f'],
    ['a control character', '\v'],
  ])('a token straight after %s in a JSONL string goes, whatever its shape', (_name, separator) => {
    const { stateDir, dbPath, transcript } = transcriptState()
    const content = ['first line', ...EVERY_SHAPE, 'next'].join(separator)
    writeFileSync(join(stateDir, transcript), `${JSON.stringify({ content })}\n`)

    const result = backup({ dbPath, stateDir, outDir: fresh(), now })

    const text = readFileSync(join(extract(result.archivePath), transcript), 'utf8')
    for (const shape of EVERY_SHAPE) expect(text.includes(shape), shape.slice(0, 7)).toBe(false)
    const kept = (JSON.parse(text) as { content: string }).content.split(separator)
    expect(kept[0]).toBe('first line')
    expect(kept.at(-1)).toBe('next')
    expect(kept).toHaveLength(EVERY_SHAPE.length + 2)
  })

  it('a token in JSON inside a JSON string goes, escaped twice over', () => {
    const { stateDir, dbPath, transcript } = transcriptState()
    const inner = JSON.stringify({ out: `first\n${TOOLS_TOKEN}\n` })
    writeFileSync(join(stateDir, transcript), `${JSON.stringify({ tool_result: inner })}\n`)

    const result = backup({ dbPath, stateDir, outDir: fresh(), now })

    expectNoToken(extract(result.archivePath))
  })

  it('a text with an escape and no token is written back byte for byte', () => {
    const { stateDir, dbPath, transcript } = transcriptState()
    const line = `${JSON.stringify({ path: 'C:\\notes\\table', text: 'one\ntwo\t"three"\u001b[0m' })}\n`
    writeFileSync(join(stateDir, transcript), line)

    const result = backup({ dbPath, stateDir, outDir: fresh(), now })

    expect(readFileSync(join(extract(result.archivePath), transcript), 'utf8')).toBe(line)
    expect(result.redacted).toEqual([])
  })

  it('a fingerprinted key in a JSONL string goes, and only the key: the quotes and braces stay', () => {
    const { stateDir, dbPath, transcript } = transcriptState()
    const key = 'unpatterned-key-material-wxyz'
    const inner = JSON.stringify({ k: key })
    const shortest = `${'k'.repeat(16)}wxyz` // the sweep's minimum, 20 characters
    const line = { atEnd: `first\n${key}`, beforeEscape: `${key}\nnext`, inner, shortest }
    writeFileSync(join(stateDir, transcript), `${JSON.stringify(line)}\n`)

    const fingerprints = [{ provider: 'zai-coding-plan', last4: 'wxyz', sha256: 'f'.repeat(64) }] as never
    const result = backup({ dbPath, stateDir, outDir: fresh(), now, fingerprints })

    const text = readFileSync(join(extract(result.archivePath), transcript), 'utf8')
    expect(text).not.toContain(key)
    expect(JSON.parse(text)).toEqual({
      atEnd: 'first\n[redacted:exact]',
      beforeEscape: '[redacted:exact]\nnext',
      inner: '{"k":"[redacted:exact]"}',
      shortest: '[redacted:exact]',
    })
  })

  it('a file redaction cannot read is left out by name, compressed or binary', () => {
    const { stateDir, dbPath, transcript } = transcriptState()
    const gz = `${transcript}.gz`
    const binary = 'engines/codex/c1/state.bin'
    const blob = 'work/att_1/image.bin'
    mkdirSync(dirname(join(stateDir, binary)), { recursive: true })
    mkdirSync(dirname(join(stateDir, blob)), { recursive: true })
    writeFileSync(join(stateDir, gz), gzipSync(`token ${GITHUB_TOKEN}\n`))
    writeFileSync(join(stateDir, binary), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(GITHUB_TOKEN)]))
    writeFileSync(join(stateDir, blob), Buffer.from([0xff, 0xfe, 0x41, 0x80])) // no NUL, and not UTF-8
    writeFileSync(join(stateDir, 'work/att_1/made.txt'), 'made\n')

    const result = backup({ dbPath, stateDir, outDir: fresh(), now })
    const tree = extract(result.archivePath)

    for (const path of [gz, binary, blob]) {
      expect(existsSync(join(tree, path)), path).toBe(false)
      expect(result.excluded).toContain(path)
    }
    expect(readFileSync(join(tree, 'work/att_1/made.txt'), 'utf8')).toBe('made\n')
    expectNoToken(tree)
  })

  // A clone's objects are compressed, and a half-copied clone is worse than none: the cache re-clones on a missing HEAD.
  it('leaves a repository clone out whole, and the drill does not call it a credential', () => {
    const { stateDir, dbPath } = transcriptState()
    const clone = join(stateDir, 'repos/abc123.git')
    mkdirSync(join(clone, 'objects'), { recursive: true })
    writeFileSync(join(clone, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(clone, 'config'), '[core]\n\tbare = true\n')

    const result = backup({ dbPath, stateDir, outDir: fresh(), now })
    const tree = extract(result.archivePath)

    expect(existsSync(join(tree, 'repos'))).toBe(false)
    expect(result.excluded).toContain('repos/abc123.git/HEAD')
    expect(scanForCredentialFiles(stateDir)).toEqual([])
  })

  it('an archive only its owner can read', () => {
    const { stateDir, dbPath } = transcriptState()
    const result = backup({ dbPath, stateDir, outDir: fresh(), now })
    expect(statSync(result.archivePath).mode & 0o777).toBe(0o600)
  })

  it('keeps an executable bit through the sweep', () => {
    const { stateDir, dbPath } = transcriptState()
    writeFileSync(join(stateDir, 'run.sh'), '#!/bin/sh\n')
    chmodSync(join(stateDir, 'run.sh'), 0o755)
    const result = backup({ dbPath, stateDir, outDir: fresh(), now })
    expect(statSync(join(extract(result.archivePath), 'run.sh')).mode & 0o111).not.toBe(0)
  })
})

describe('mec backup', () => {
  it('writes an archive whose database bytes hold no token, and leaves the store as it was', async () => {
    const dataDir = makeDataDir()
    const before = new Database(join(dataDir, 'mec.db'), { readonly: true })
    const rows = before.prepare('SELECT * FROM docs ORDER BY id').all()
    before.close()

    const tree = extract(await takeBackup(dataDir))

    expectNoToken(tree)
    const copy = new Database(join(tree, 'db.sqlite'), { readonly: true })
    const card = copy.prepare("SELECT json FROM docs WHERE id = 'c1'").pluck().get() as string
    const body = copy.prepare('SELECT body FROM events').pluck().get() as string
    copy.close()
    expect(JSON.parse(card).evidence).toContain('[redacted:')
    expect(JSON.parse(body).text).toContain('Bearer [redacted]')

    const after = new Database(join(dataDir, 'mec.db'), { readonly: true })
    expect(after.prepare('SELECT * FROM docs ORDER BY id').all()).toEqual(rows)
    after.close()
  })

  it('never carries a keystore', async () => {
    const tree = extract(await takeBackup(makeDataDir()))
    expect(scanForCredentialFiles(tree)).toEqual([])
    expect(existsSync(join(tree, 'engines/claude/s1/settings.json'))).toBe(true)
  })

  it('backs up beside a live writer, and reports counts rather than records', async () => {
    const dataDir = makeDataDir()
    writeFileSync(join(dataDir, 'engines/claude/s1/t.jsonl'), `${GITHUB_TOKEN}\n`)
    const live = new Database(join(dataDir, 'mec.db'))
    live.pragma('journal_mode = WAL')
    live.prepare("UPDATE docs SET updated_at = 'x' WHERE id = 's1'").run()
    try {
      const { io, lines } = cliIo(dataDir)
      expect(await runCli(['backup', '--out', fresh()], io), out(lines)).toBe(0)
      expect(out(lines)).toMatch(/1 file redacted/)
      expect(out(lines)).not.toContain(GITHUB_TOKEN)
    } finally {
      live.close()
    }
  })

  it('defaults to the backups folder of the data dir, as Settings does', async () => {
    const dataDir = makeDataDir()
    const { io, lines } = cliIo(dataDir)
    expect(await runCli(['backup'], io), out(lines)).toBe(0)
    expect(readdirSync(join(dataDir, 'backups')).filter((name) => name.endsWith('.tgz'))).toHaveLength(1)
  })

  it('fails loudly without a store, and creates none', async () => {
    const dataDir = fresh()
    const { io, lines } = cliIo(dataDir)
    expect(await runCli(['backup', '--out', fresh()], io)).toBe(1)
    expect(out(lines)).toContain('mec backup:')
    expect(existsSync(join(dataDir, 'mec.db'))).toBe(false)
  })

  it.each([[['backup', '--out']], [['backup', '--wat']], [['backup', '--wat', 'x']], [['backup', 'stray']]])(
    'prints usage for %j and takes nothing',
    async (argv) => {
      const dataDir = makeDataDir()
      const { io, lines } = cliIo(dataDir)
      expect(await runCli(argv, io)).toBe(1)
      expect(out(lines)).toContain('usage: mec backup')
      expect(existsSync(join(dataDir, 'backups'))).toBe(false)
    },
  )
})

describe('--out never costs the backup what it names', () => {
  const now = new Date('2026-11-06T10:00:00.000Z')

  function homeWithState(): { home: string; dataDir: string } {
    const home = fresh()
    const dataDir = join(home, '.mec')
    mkdirSync(join(dataDir, 'prompts'), { recursive: true })
    mkdirSync(join(dataDir, 'engines/claude/s1'), { recursive: true })
    writeFileSync(join(dataDir, 'mec.db'), 'fake sqlite pages')
    writeFileSync(join(dataDir, 'prompts/edited.md'), 'the owner wrote this')
    writeFileSync(join(dataDir, 'models.yaml'), 'models: []')
    writeFileSync(join(dataDir, 'engines/claude/s1/t.jsonl'), '{"text":"a transcript"}')
    return { home, dataDir }
  }

  it.each([
    ['the data dir', (dataDir: string) => dataDir],
    ['a parent of the data dir', (dataDir: string) => dirname(dataDir)],
    ['a state folder inside the data dir', (dataDir: string) => join(dataDir, 'prompts')],
  ])('%s still gets every file, and only the files it held', (_name, target) => {
    const { dataDir } = homeWithState()
    const outDir = target(dataDir)

    const result = backup({ dbPath: join(dataDir, 'mec.db'), stateDir: dataDir, outDir, now })

    const tree = extract(result.archivePath)
    expect(readFileSync(join(tree, 'prompts/edited.md'), 'utf8')).toBe('the owner wrote this')
    expect(readFileSync(join(tree, 'models.yaml'), 'utf8')).toBe('models: []')
    expect(existsSync(join(tree, 'engines/claude/s1/t.jsonl'))).toBe(true)
    expect(result.excluded).toEqual([])
    expect(readdirSync(tree).filter((name) => name.includes('mec-backup'))).toEqual([])
  })

  it('a second backup into the same folder carries neither the first nor its own staging', () => {
    const { dataDir } = homeWithState()
    const input = { dbPath: join(dataDir, 'mec.db'), stateDir: dataDir, outDir: dataDir }

    backup({ ...input, now })
    const result = backup({ ...input, now: new Date('2026-11-06T11:00:00.000Z') })

    const tree = extract(result.archivePath)
    const names = allFiles(tree).map((file) => relative(tree, file))
    expect(names.filter((name) => name.includes('mec-backup'))).toEqual([])
    expect(result.excluded).toEqual([])
  })

  it('a file of the owner beside the archives stays in the backup', () => {
    const { dataDir } = homeWithState()
    const outDir = join(dataDir, 'backups')
    mkdirSync(outDir)
    writeFileSync(join(outDir, 'notes.md'), 'which backup was the good one')

    const result = backup({ dbPath: join(dataDir, 'mec.db'), stateDir: dataDir, outDir, now })

    expect(readFileSync(join(extract(result.archivePath), 'backups/notes.md'), 'utf8')).toContain('good one')
  })

  it('mec backup --out <home> gives a restorable archive with the state in it', async () => {
    const dataDir = makeDataDir()
    mkdirSync(join(dataDir, 'prompts'))
    writeFileSync(join(dataDir, 'prompts/edited.md'), 'the owner wrote this')
    const home = dirname(dataDir)
    const { io, lines } = cliIo(dataDir)

    expect(await runCli(['backup', '--out', home], io), out(lines)).toBe(0)

    const archive = readdirSync(home).find((name) => name.endsWith('.tgz')) as string
    const tree = extract(join(home, archive))
    expect(existsSync(join(tree, 'prompts/edited.md'))).toBe(true)
    expect(existsSync(join(tree, 'engines/claude/s1/settings.json'))).toBe(true)
  })
})

describe('mec restore', () => {
  it('restores into an empty data dir as a store the next server opens, and every live slot must re-probe', async () => {
    const archive = await takeBackup(makeDataDir())
    const target = join(fresh(), 'home/.mec') // neither it nor its parent exists yet
    const { io, lines } = cliIo(target)

    expect(await runCli(['restore', archive], io), out(lines)).toBe(0)

    expect(existsSync(join(target, 'db.sqlite'))).toBe(false)
    const db = new Database(join(target, 'mec.db'), { readonly: true })
    const states = db
      .prepare("SELECT json FROM docs WHERE kind = 'slot' ORDER BY id")
      .pluck()
      .all()
      .map((json) => JSON.parse(json as string).state)
    db.close()
    expect(states).toEqual(['home_ready', 'retired'])
    expect(out(lines)).toContain('re-probe')
    expect(out(lines)).toContain('s1')
    expect(readdirSync(dirname(target))).toEqual(['.mec']) // no staging left beside it
    expect(existsSync(join(target, 'engines/claude/s1/keys'))).toBe(false)
  })

  it('accepts an existing empty data dir', async () => {
    const archive = await takeBackup(makeDataDir())
    const target = fresh()
    const { io, lines } = cliIo(target)
    expect(await runCli(['restore', archive], io), out(lines)).toBe(0)
    expect(existsSync(join(target, 'mec.db'))).toBe(true)
  })

  it('refuses a store that already has data, changes nothing and deletes nothing', async () => {
    const archive = await takeBackup(makeDataDir())
    const target = makeDataDir()
    const siblings = readdirSync(dirname(target))
    const db = readFileSync(join(target, 'mec.db'))
    const names = readdirSync(target, { recursive: true }).sort()
    const { io, lines } = cliIo(target)

    expect(await runCli(['restore', archive], io)).toBe(1)

    expect(out(lines)).toMatch(/refuses to overwrite/)
    expect(readFileSync(join(target, 'mec.db')).equals(db)).toBe(true)
    expect(readdirSync(target, { recursive: true }).sort()).toEqual(names)
    expect(readdirSync(dirname(target))).toEqual(siblings)
  })

  it('refuses a data dir holding only one file: any file is data', async () => {
    const archive = await takeBackup(makeDataDir())
    const target = fresh()
    writeFileSync(join(target, 'health.json'), '{}')
    const { io } = cliIo(target)
    expect(await runCli(['restore', archive], io)).toBe(1)
    expect(readdirSync(target)).toEqual(['health.json'])
  })

  it('a damaged archive leaves nothing behind in the target or beside it', async () => {
    const damaged = damage(await takeBackup(makeDataDir()))
    const target = join(fresh(), '.mec')
    const { io, lines } = cliIo(target)

    expect(await runCli(['restore', damaged], io)).toBe(1)

    expect(out(lines)).toContain('sha256 mismatch')
    expect(readdirSync(dirname(target))).toEqual([])
  })

  // Stages a store into the target while the restore runs, behind the first check's back.
  it('a store that appears during the restore survives it', async () => {
    const archive = await takeBackup(makeDataDir())
    const target = fresh()
    const realTar = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim()
    const bin = fresh()
    writeFileSync(
      join(bin, 'tar'),
      `#!/bin/sh\n"${realTar}" "$@"\nrc=$?\necho kept > "${join(target, 'precious')}"\nexit $rc\n`,
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    const { io, lines } = cliIo(target)

    expect(await runCli(['restore', archive], io)).toBe(1)

    expect(out(lines)).toContain('mec restore:')
    expect(readdirSync(target)).toEqual(['precious'])
    expect(readFileSync(join(target, 'precious'), 'utf8')).toBe('kept\n')
  })

  it('--target restores somewhere else and leaves the data dir alone', async () => {
    const dataDir = makeDataDir()
    const archive = await takeBackup(dataDir)
    const names = readdirSync(dataDir).sort()
    const scratch = join(fresh(), 'scratch')
    const { io, lines } = cliIo(dataDir)
    expect(await runCli(['restore', archive, '--target', scratch], io), out(lines)).toBe(0)
    expect(existsSync(join(scratch, 'mec.db'))).toBe(true)
    expect(readdirSync(dataDir).sort()).toEqual(names)
  })

  it('--drill judges the archive in a scratch dir and touches no store', async () => {
    const dataDir = makeDataDir()
    const archive = await takeBackup(dataDir)
    const names = readdirSync(dataDir).sort()
    const { io, lines } = cliIo(dataDir)

    expect(await runCli(['restore', '--drill', archive], io), out(lines)).toBe(0)

    expect(out(lines)).toContain('drill passed')
    expect(out(lines)).toContain('no_credential_files')
    expect(readdirSync(dataDir).sort()).toEqual(names)
  })

  it('--drill exits 1 on a damaged archive', async () => {
    const damaged = damage(await takeBackup(makeDataDir()))
    const { io, lines } = cliIo(fresh())

    expect(await runCli(['restore', '--drill', damaged], io)).toBe(1)
    expect(out(lines)).toContain('drill failed')
  })

  it.each([
    [['restore']],
    [['restore', '--target', 'x']],
    [['restore', 'a', 'b']],
    [['restore', 'a', '--wat']],
  ])('prints usage for %j', async (argv) => {
    const { io, lines } = cliIo(fresh())
    expect(await runCli(argv, io)).toBe(1)
    expect(out(lines)).toContain('usage: mec restore')
  })

  it('a missing archive is a plain failure, not a stack', async () => {
    const { io, lines } = cliIo(fresh())
    expect(await runCli(['restore', '/nonexistent/a.tgz'], io)).toBe(1)
    expect(out(lines)).toContain('archive not found')
  })
})
