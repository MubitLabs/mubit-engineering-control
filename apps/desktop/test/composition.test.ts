import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
  delete process.env.MEC_FAKE_ENGINE
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('startServer', () => {
  it('serves status, writes health.json and releases the lock on close', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = mkdtempSync(join(tmpdir(), 'mec-composition-'))
    tempDirs.push(dataDir)

    const handle = await startServer({ dataDir })
    try {
      const deadline = Date.now() + 8000
      let answered = false
      while (Date.now() < deadline && !answered) {
        try {
          const res = await fetch(`${handle.url}/api/status`)
          answered = res.ok
          await res.text()
        } catch {
          // not accepting yet — poll again
        }
        if (!answered) await sleep(100)
      }
      expect(answered).toBe(true)
      expect(existsSync(join(dataDir, 'mec.db'))).toBe(true)

      const snapshot = JSON.parse(readFileSync(join(dataDir, 'health.json'), 'utf8')) as {
        runtime: { state: string; instances: number; answering: boolean }
        setup: { has_slot: boolean; has_repository: boolean }
      }
      expect(snapshot.runtime).toEqual({ state: 'ready', instances: 1, answering: true })
      expect(snapshot.setup).toEqual({ has_slot: false, has_repository: false })
    } finally {
      await handle.close()
    }

    // close() released the directory lock and the database: a second server starts on the
    // same directory without a refusal.
    const second = await startServer({ dataDir })
    await second.close()
  }, 12_000)
})

describe('§26 restart reconciliation and capability drift (composition)', () => {
  it('an effect left running by a crash is resumed once at boot and drained', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mec-composition-'))
    tempDirs.push(dataDir)
    const seed = new Database(join(dataDir, 'mec.db'))
    migrate(seed, MIGRATIONS_v1)
    new SqliteStore(seed).effects.enqueue('note', 'wi_crashed', { text: 'left running' })
    seed.prepare("UPDATE effects SET state = 'running'").run()
    seed.close()

    const handle = await startServer({ dataDir })
    await handle.close()

    const after = new Database(join(dataDir, 'mec.db'))
    const left = after.prepare('SELECT COUNT(*) AS n FROM effects').get() as { n: number }
    after.close()
    expect(left.n).toBe(0)
  }, 12_000)

  it('running attempts reconcile to stalled with a recovery event on restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mec-recon-'))
    const db = new Database(join(dir, 'mec.db'))
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    const at = new Date().toISOString()
    store.atomic(() => {
      store.attempts.save({ id: 'att_stuck', state: 'running', generation: 1, updatedAt: at })
      const stream = 'attempt:att_stuck'
      store.events.append(stream, { stream, seq: 1, at, type: 'session_started', body: {} })
    })
    // simulate restart: a NEW server reconciling the old store
    const { startServer } = await import('../src/composition')
    const server = await startServer({ dataDir: dir })
    const attempt = store.attempts.get('att_stuck')
    expect(attempt?.state).toBe('stalled')
    const events = store.events.read('attempt:att_stuck')
    expect(events.some((e) => e.type === 'attempt.reconciled')).toBe(true)
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
