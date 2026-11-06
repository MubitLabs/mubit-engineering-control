import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { issueToken } from '@mec/mec-tools'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backup, DB_NAME, scanForCredentialFiles } from '../src/backup'
import { startServer } from '../src/composition'
import { makeConfigServer } from './config-server'

/** §20: an on-demand backup. Credentials stay out by rule; a failure is reported as one. */

const dirs: string[] = []
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mec-backups-route-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

const json = { 'content-type': 'application/json' }

describe('the backups route on a composed server', () => {
  // Settings takes the same backup as the CLI: the live store's copy is swept, the live store is not.
  it('no token reaches the archive from the database or a transcript', async () => {
    vi.stubEnv('MEC_FAKE_ENGINE', '1')
    const dataDir = fresh()
    const token = issueToken({
      attemptId: 'att_route',
      generation: 1,
      role: 'specialist',
      secret: 'synthetic',
    })
    const transcript = join(dataDir, 'engines', 'claude', 'max-1', 'session.jsonl')
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, `{"env":"MEC_TOOLS_TOKEN=${token}"}\n`)

    const server = await startServer({ dataDir })
    try {
      const writer = new Database(join(dataDir, 'mec.db'))
      writer
        .prepare('INSERT INTO docs (id, kind, json, updated_at) VALUES (?, ?, ?, ?)')
        .run('card_token', 'card', JSON.stringify({ evidence: token }), '2026-11-06T10:00:00.000Z')
      writer.close()

      const post = await fetch(`${server.url}/api/backups`, { method: 'POST', headers: json, body: '{}' })
      expect(post.status).toBe(200)
      const { archive } = (await post.json()) as { archive: string }

      const out = fresh()
      execFileSync('tar', ['-xzf', join(dataDir, 'backups', archive), '-C', out])
      const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
      expect(files.length).toBeGreaterThan(1)
      for (const file of files) {
        expect(readFileSync(join(file.parentPath, file.name)).toString('latin1')).not.toContain(token)
      }
      expect(readFileSync(transcript, 'utf8')).toContain(token)
    } finally {
      await server.close()
    }
  })

  it('the archive carries no credential file', async () => {
    vi.stubEnv('MEC_FAKE_ENGINE', '1')
    const dataDir = fresh()
    const home = join(dataDir, 'engines', 'claude', 'max-1')
    mkdirSync(join(home, 'keys'), { recursive: true })
    writeFileSync(join(home, 'keys', 'anthropic-api.key'), 'synthetic-key-bytes')
    writeFileSync(join(home, 'keys', '.salt'), 'synthetic-salt')
    writeFileSync(join(home, '.credentials.json'), '{"synthetic":true}')
    writeFileSync(join(home, 'auth.json'), '{"synthetic":true}')
    writeFileSync(join(home, 'settings.json'), '{}')

    const server = await startServer({ dataDir })
    try {
      const status = (await (await fetch(`${server.url}/api/status`)).json()) as {
        capabilities: { backups: boolean }
      }
      expect(status.capabilities.backups).toBe(true)
      const never = (await (await fetch(`${server.url}/api/backups`)).json()) as Record<string, unknown>
      expect(never.lastAt).toBeUndefined()

      const post = await fetch(`${server.url}/api/backups`, { method: 'POST', headers: json, body: '{}' })
      expect(post.status).toBe(200)
      const taken = (await post.json()) as { status: string; archive: string; lastAt: string }
      expect(taken.status).toBe('done')

      const listed = (await (await fetch(`${server.url}/api/backups`)).json()) as {
        lastAt: string
        note: string
        excluded: string
      }
      expect(listed.lastAt).toBe(taken.lastAt)
      expect(listed.excluded).toMatch(/key/i)

      const out = fresh()
      execFileSync('tar', ['-xzf', join(dataDir, 'backups', taken.archive), '-C', out])
      expect(scanForCredentialFiles(out)).toEqual([])
      expect(readdirSync(join(out, 'engines', 'claude', 'max-1'))).toEqual(['settings.json'])
      const copy = new Database(join(out, DB_NAME), { readonly: true })
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
      copy.close()

      // A second archive never swallows the first.
      const again = (await (
        await fetch(`${server.url}/api/backups`, { method: 'POST', headers: json, body: '{}' })
      ).json()) as { archive: string }
      const second = fresh()
      execFileSync('tar', ['-xzf', join(dataDir, 'backups', again.archive), '-C', second])
      expect(readdirSync(second)).not.toContain('backups')
    } finally {
      await server.close()
    }
  })
})

describe('the live copy', () => {
  it('a copy of a live WAL database opens and matches', () => {
    const dir = fresh()
    const dbPath = join(dir, 'mec.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 500; i += 1) insert.run(`row-${i}`)
    expect(readdirSync(dir)).toContain('mec.db-wal')

    const outDir = join(dir, 'out')
    const { archivePath } = backup({
      dbPath,
      stateDir: dir,
      outDir,
      copyDb: (_from, to) => {
        db.prepare('VACUUM INTO ?').run(to)
      },
    })
    const out = fresh()
    execFileSync('tar', ['-xzf', archivePath, '-C', out])
    const copy = new Database(join(out, DB_NAME), { readonly: true })
    const count = copy.prepare('SELECT count(*) AS n, max(v) AS top FROM t').get()
    const live = db.prepare('SELECT count(*) AS n, max(v) AS top FROM t').get()
    expect(count).toEqual(live)
    expect((count as { n: number }).n).toBe(500)
    copy.close()
    db.close()
  })
})

describe('a failed backup', () => {
  it('backup failure is reported, not faked', async () => {
    const ctx = makeConfigServer({
      backups: {
        take: () => {
          throw new Error('disk full')
        },
      },
    })
    try {
      const res = await ctx.post('/api/backups', {})
      expect(res.statusCode).toBe(500)
      expect(res.json()).toMatchObject({ error: 'backup_failed', detail: 'disk full' })
      const after = (await ctx.get('/api/backups')).json() as Record<string, unknown>
      expect(after.lastAt).toBeUndefined()
      expect(ctx.store.events.read('backups')).toEqual([])
    } finally {
      await ctx.close()
    }
  })

  it('without a backup seam the route is not served and the capability says so', async () => {
    const ctx = makeConfigServer()
    try {
      expect((await ctx.get('/api/backups')).statusCode).toBe(404)
      const status = (await ctx.get('/api/status')).json() as {
        capabilities: Record<string, boolean>
      }
      expect(status.capabilities).toEqual({
        switchWork: false,
        drain: false,
        backups: false,
        isolationEdit: false,
        pause: false,
      })
    } finally {
      await ctx.close()
    }
  })
})
