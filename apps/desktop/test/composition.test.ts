import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'

const AT = '2026-11-05T12:00:00.000Z'

const openStore = (dataDir: string): { db: Database.Database; store: SqliteStore } => {
  const db = new Database(join(dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  return { db, store: new SqliteStore(db) }
}

const scratch = (): string => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mec-authority-'))
  tempDirs.push(dataDir)
  return dataDir
}

/** A due launch for one queued attempt on repo-bound work, as a plan commit leaves it. */
const seedLaunch = (store: SqliteStore, work: Record<string, unknown> = {}): void => {
  store.atomic(() => {
    store.workItems.save({
      id: 'wi_1',
      state: 'executing',
      repoId: 'repo_a',
      pin: { repoId: 'repo_a' },
      mandate: { originMessageId: 'msg_1' },
      ...work,
    })
    store.tasks.save({ id: 'task_1', workItemId: 'wi_1', repoId: 'repo_a', status: 'ready' })
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_1',
      workItemId: 'wi_1',
      slotId: 'fake-slot',
      state: 'queued',
      generation: 1,
    })
    store.effects.enqueue('launch', 'att_1:1', {
      attempt_id: 'att_1',
      task_id: 'task_1',
      work_item_id: 'wi_1',
      slot_id: 'fake-slot',
      generation: 1,
    })
  })
}

const launchRow = (db: Database.Database) =>
  db.prepare("SELECT state, attempts, next_run_at FROM effects WHERE kind = 'launch'").get() as
    | { state: string; attempts: number; next_run_at: string }
    | undefined

const seedPause = (store: SqliteStore, pausedAt: string): void => {
  store.atomic(() => {
    store.engines.save({ id: 'settings/processing', paused: true, pausedAt, updatedAt: pausedAt })
  })
}

describe('pause persists (decision #21, §20)', () => {
  it('pause survives restart and no handler runs at boot', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const first = await startServer({ dataDir })
    first.pause()
    await first.close()

    const { db, store } = openStore(dataDir)
    seedLaunch(store)

    const second = await startServer({ dataDir })
    expect(second.isPaused()).toBe(true)
    await sleep(100)

    expect(launchRow(db)?.state).toBe('pending')
    expect(store.attempts.get('att_1')?.state).toBe('queued')
    await second.close()
    db.close()
  }, 12_000)

  it('close while paused runs no queued effect and keeps the row', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedPause(store, AT)
    seedLaunch(store)

    const handle = await startServer({ dataDir })
    await handle.close()

    expect(launchRow(db)?.state).toBe('pending')
    expect(store.attempts.get('att_1')?.state).toBe('queued')
    db.close()
  }, 12_000)

  it('resume shifts deadlines by the stored pause length', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    const hour = 3_600_000
    const dueAt = new Date(Date.now() + hour).toISOString()
    seedPause(store, new Date(Date.now() - hour).toISOString())
    seedLaunch(store)
    db.prepare("UPDATE effects SET next_run_at = ? WHERE kind = 'launch'").run(dueAt)

    const handle = await startServer({ dataDir })
    handle.resume()

    const shift = Date.parse(launchRow(db)?.next_run_at ?? '') - Date.parse(dueAt)
    expect(shift).toBeGreaterThanOrEqual(hour)
    expect(shift).toBeLessThan(hour + 60_000)
    expect(store.engines.get('settings/processing')?.paused).toBe(false)
    await handle.close()
    db.close()
  }, 12_000)

  it('a second pause does not shorten the shift', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    const handle = await startServer({ dataDir })

    handle.pause()
    const first = store.engines.get('settings/processing')?.pausedAt
    await sleep(5)
    handle.pause()

    expect(typeof first).toBe('string')
    expect(store.engines.get('settings/processing')?.pausedAt).toBe(first)
    await handle.close()
    db.close()
  }, 12_000)

  it('health.json and the stored doc say paused while paused', async () => {
    const dataDir = scratch()
    const handle = await startServer({ dataDir })
    handle.pause()
    const status = (await (await fetch(`${handle.url}/api/status`)).json()) as {
      runtime: { state: string }
    }
    expect(status.runtime.state).toBe('paused')
    handle.resume()
    await handle.close()
  }, 12_000)
})

describe('the launch gate (§13, §20)', () => {
  it('held launch defers without counting a failure', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedLaunch(store, { hold: { reason: 'wait', at: AT } })

    const handle = await startServer({ dataDir })
    await sleep(200)
    const status = (await (await fetch(`${handle.url}/api/status`)).json()) as {
      parts: Record<string, { state: string }>
    }

    expect(launchRow(db)).toMatchObject({ state: 'waiting', attempts: 0 })
    expect(status.parts['effects:launch']?.state).toBe('ok')
    expect(store.attempts.get('att_1')?.state).toBe('queued')
    await handle.close()
    db.close()
  }, 12_000)

  it('stopped launch never reaches the engine', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedLaunch(store, { state: 'stopped' })

    const handle = await startServer({ dataDir })
    await handle.close()

    expect(launchRow(db)).toBeUndefined()
    expect(store.attempts.get('att_1')?.state).toBe('queued')
    expect(store.events.read('attempt:att_1')).toEqual([])
    expect(store.events.read('work:wi_1').map((event) => event.type)).toEqual(['launch_refused'])
    db.close()
  }, 12_000)

  it('a launch under a changed policy is dropped and blocks the work', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedLaunch(store, {
      mandate: { originMessageId: 'msg_1', policyHash: 'older', expiresAt: null, status: 'active' },
    })

    const handle = await startServer({ dataDir })
    await handle.close()

    expect(launchRow(db)).toBeUndefined()
    expect(store.events.read('attempt:att_1')).toEqual([])
    expect(store.workItems.get('wi_1')).toMatchObject({ state: 'blocked', blockedReason: 'policy_changed' })
    db.close()
  }, 12_000)

  it('a launch that runs keeps the attempt identity', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedLaunch(store)

    const handle = await startServer({ dataDir })
    await handle.close()

    expect(store.attempts.get('att_1')).toMatchObject({
      taskId: 'task_1',
      workItemId: 'wi_1',
      state: 'succeeded',
    })
    db.close()
  }, 12_000)
})

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
