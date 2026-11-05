import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MetaBrain, MetaDecision } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const effectRow = (db: Database.Database, kind: string, key: string) =>
  db.prepare('SELECT state, attempts, last_error FROM effects WHERE kind = ? AND key = ?').get(kind, key) as
    | { state: string; attempts: number; last_error: string | null }
    | undefined

/** What a crash mid-planning leaves: the work and the message committed, no receipt. */
const seedInterrupted = (store: SqliteStore, n = 1): void => {
  store.atomic(() => {
    store.engines.save({
      id: 'repo_a',
      url: 'https://example.test/a',
      bootstrap: [],
      checks: [],
      trust: true,
    })
    store.workItems.save({
      id: `wi_${n}`,
      state: 'planning',
      repoId: 'repo_a',
      pin: { repoId: 'repo_a' },
      mandate: { originMessageId: `msg_${n}` },
    })
    store.messages.save({
      id: `msg_${n}`,
      text: `request ${n}`,
      repoId: 'repo_a',
      routing: 'new_work',
      workItemId: `wi_${n}`,
      createdAt: `${AT.slice(0, -2)}${n}Z`,
    })
  })
}

/** A brain that stays on its await until the test answers. */
const heldBrain = () => {
  const answers: ((decision: MetaDecision) => void)[] = []
  const seen: string[] = []
  const brain: MetaBrain = (context) => {
    seen.push(context.messageText)
    return new Promise((resolve) => answers.push(resolve))
  }
  return { brain, seen, answer: (decision: MetaDecision) => answers.shift()!(decision) }
}

const untilSeen = async (seen: string[], count: number): Promise<void> => {
  await vi.waitFor(() => expect(seen).toHaveLength(count), { timeout: 4000 })
}

describe('truthful launch (§17, decision #26)', () => {
  it('unsupported launch never settles as success', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedLaunch(store)

    const handle = await startServer({ dataDir })
    await sleep(100)
    const status = (await (await fetch(`${handle.url}/api/status`)).json()) as {
      parts: Record<string, { state: string; detail?: string }>
    }

    expect(effectRow(db, 'launch', 'att_1:1')).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error: expect.stringContaining('no_runner'),
    })
    expect(store.attempts.get('att_1')).toMatchObject({ state: 'failed', terminal_reason: 'no_runner' })
    expect(store.workItems.get('wi_1')).toMatchObject({ state: 'blocked', blockedReason: 'no_runner' })
    expect(status.parts['effects:launch']?.state).toBe('error')
    await handle.close()
    db.close()
  }, 12_000)

  it('unsupported launch blocks the work once across retries', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedLaunch(store)

    const handle = await startServer({ dataDir })
    await vi.waitFor(() => expect(effectRow(db, 'launch', 'att_1:1')?.attempts).toBe(2), { timeout: 6000 })

    const types = store.events.read('work:wi_1').map((event) => event.type)
    expect(types).toEqual(['work_blocked'])
    expect(store.events.read('attempt:att_1').map((event) => event.type)).toEqual(['attempt.failed'])
    await handle.close()
    db.close()
  }, 12_000)

  it('a held launch with no runner still only waits', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedLaunch(store, { hold: { reason: 'wait', at: AT } })

    const handle = await startServer({ dataDir })
    await sleep(100)

    expect(store.attempts.get('att_1')?.state).toBe('queued')
    expect(store.workItems.get('wi_1')?.state).toBe('executing')
    await handle.close()
    db.close()
  }, 12_000)

  it('an effect kind with no handler throws', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    for (const kind of ['reply', 'external', 'probe'] as const) {
      store.effects.enqueue(kind, 'k1', {})
    }

    const handle = await startServer({ dataDir })
    await sleep(100)

    for (const kind of ['reply', 'external', 'probe']) {
      expect(effectRow(db, kind, 'k1')).toMatchObject({
        attempts: 1,
        last_error: `unsupported effect: ${kind}`,
      })
    }
    await handle.close()
    db.close()
  }, 12_000)
})

describe('relays and boot resume (§6, §17, §20)', () => {
  it('a relay with no meta agent waits', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    store.effects.enqueue('relay', 'wake:q', { reason: 'r', causationId: 'q' })

    const handle = await startServer({ dataDir })
    await sleep(100)

    expect(effectRow(db, 'relay', 'wake:q')).toMatchObject({ state: 'waiting', attempts: 0 })
    await handle.close()
    db.close()
  }, 12_000)

  it('boot resumes a receipt-less message through the queue', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedInterrupted(store)
    const held = heldBrain()

    const handle = await startServer({ dataDir, brain: held.brain })
    await untilSeen(held.seen, 1)
    expect(store.messages.get('msg_1')?.ackText).toBeUndefined()
    held.answer({ ack: 'Resumed' })
    await handle.close()

    expect(held.seen).toEqual(['request 1'])
    expect(store.messages.get('msg_1')).toMatchObject({ ackText: 'Resumed', workItemId: 'wi_1' })
    expect(store.workItems.list()).toHaveLength(1)
    expect(effectRow(db, 'relay', 'resume:msg_1')).toBeUndefined()
    db.close()
  }, 12_000)

  it('a pause holds the turn until resume, which runs it (decision #27)', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedPause(store, new Date(Date.now() - 3_600_000).toISOString())
    seedInterrupted(store)
    const held = heldBrain()

    const handle = await startServer({ dataDir, brain: held.brain })
    await sleep(100)
    expect(held.seen).toEqual([])

    handle.resume()
    await untilSeen(held.seen, 1)
    held.answer({ ack: 'After the pause' })
    await handle.close()

    expect(store.messages.get('msg_1')?.ackText).toBe('After the pause')
    db.close()
  }, 12_000)
})

describe('bounded shutdown (§20)', () => {
  it('close is bounded with a stuck turn', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedInterrupted(store)
    const held = heldBrain()
    const handle = await startServer({ dataDir, brain: held.brain, closeBoundMs: 100 })
    await untilSeen(held.seen, 1)

    await handle.close()

    expect(effectRow(db, 'relay', 'resume:msg_1')?.state).toBe('running')
    // The lock is free, and the turn answering after the close fails quietly.
    held.answer({ ack: 'Too late' })
    await sleep(20)
    expect(store.messages.get('msg_1')?.ackText).toBeUndefined()
    const next = heldBrain()
    const second = await startServer({ dataDir, brain: next.brain, closeBoundMs: 100 })
    await untilSeen(next.seen, 1)
    next.answer({ ack: 'Resumed' })
    await second.close()
    expect(store.messages.get('msg_1')?.ackText).toBe('Resumed')
    db.close()
  }, 12_000)

  it('a chat request stuck on a turn does not hold close open', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedInterrupted(store)
    store.atomic(() => {
      const work = store.workItems.get('wi_1')!
      store.workItems.save({ ...work, state: 'stopped' })
    })
    const held = heldBrain()
    const handle = await startServer({ dataDir, brain: held.brain, closeBoundMs: 100 })

    const request = fetch(`${handle.url}/api/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'new work', repoId: 'repo_a' }),
    }).catch(() => undefined)
    await untilSeen(held.seen, 1)

    await handle.close()
    await request
    held.answer({ ack: 'Too late' })
    await sleep(20)
    db.close()
  }, 12_000)

  it('close starts no new planner turn', async () => {
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedInterrupted(store, 1)
    seedInterrupted(store, 2)
    const held = heldBrain()
    const handle = await startServer({ dataDir, brain: held.brain })
    await untilSeen(held.seen, 1)

    const closing = handle.close()
    held.answer({ ack: 'First' })
    await closing

    expect(held.seen).toEqual(['request 1'])
    expect(store.messages.get('msg_1')?.ackText).toBe('First')
    expect(effectRow(db, 'relay', 'resume:msg_2')?.state).toBe('pending')
    db.close()
  }, 12_000)
})

/**
 * How long a stub may take to start. On a busy macOS host a new process has sat at `_dyld_start`
 * for over 15 s while the suite's other files ran; this wait is for that, not for the product.
 */
const ENGINE_START_MS = 40_000

/** Only what the stub reports it started: a test never signals anything else. */
const stubPids: number[] = []

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A real `claude` on PATH, and a scratch HOME so nothing reads the real one. The body runs as
 * the engine process; $LOG gets one pid per launch and $ARGV the launch's arguments.
 */
const stubClaude = (body: string) => {
  const dir = scratch()
  const log = join(dir, 'engine.log')
  const argv = join(dir, 'engine.argv')
  mkdirSync(join(dir, 'bin'))
  const script = `#!/bin/sh\nLOG='${log}'\nARGV='${argv}'\necho $$ >> "$LOG"\nprintf '%s\\n' "$@" >> "$ARGV"\n${body}\n`
  writeFileSync(join(dir, 'bin', 'claude'), script, { mode: 0o755 })
  vi.stubEnv('PATH', `${join(dir, 'bin')}:${process.env.PATH}`)
  vi.stubEnv('HOME', dir)
  const pids = (): number[] => {
    if (!existsSync(log)) return []
    const found = readFileSync(log, 'utf8').trim().split('\n').map(Number)
    stubPids.push(...found.filter((pid) => !stubPids.includes(pid)))
    return found
  }
  return {
    pids,
    home: dir,
    argv: () => (existsSync(argv) ? readFileSync(argv, 'utf8') : ''),
    untilLaunches: (count: number) =>
      vi.waitFor(() => expect(pids()).toHaveLength(count), { timeout: ENGINE_START_MS }),
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const pid of stubPids) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
  stubPids.length = 0
  vi.unstubAllEnvs()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
  delete process.env.MEC_FAKE_ENGINE
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('shutdown with a real engine process (§20)', () => {
  it('close stops the engine child, past the bound, and its row resumes', async () => {
    const stub = stubClaude('exec sleep 60')
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedInterrupted(store)
    const handle = await startServer({ dataDir, metaSlotDir: scratch(), closeBoundMs: 100 })
    await stub.untilLaunches(1)
    const [engine] = stub.pids()

    await handle.close()
    await vi.waitFor(() => expect(isAlive(engine!)).toBe(false), { timeout: 2000 })

    expect(stub.pids()).toHaveLength(1)
    expect(store.messages.get('msg_1')?.ackText).toBeUndefined()
    expect(store.workItems.get('wi_1')?.state).toBe('planning')
    expect(effectRow(db, 'relay', 'resume:msg_1')?.attempts).toBe(0)
    db.close()
  }, 60_000)

  it('an engine ending without the protocol during close starts no second engine', async () => {
    const stub = stubClaude('sleep 1')
    const dataDir = scratch()
    const { db, store } = openStore(dataDir)
    seedInterrupted(store)
    const handle = await startServer({ dataDir, metaSlotDir: scratch() })
    await stub.untilLaunches(1)

    await handle.close()
    await sleep(300)

    expect(stub.pids()).toHaveLength(1)
    expect(store.messages.get('msg_1')?.ackText).toBeUndefined()
    expect(store.workItems.get('wi_1')?.state).toBe('planning')
    expect(effectRow(db, 'relay', 'resume:msg_1')?.attempts).toBe(0)
    db.close()
  }, 60_000)

  it('the real planner reads its protocol from the data dir, not the real home', async () => {
    const stub = stubClaude('exec sleep 60')
    const dataDir = scratch()
    const part = 'prompts/roles/meta_agent/protocol.md'
    for (const [root, text] of [
      [dataDir, 'DATA-DIR PROTOCOL'],
      [join(stub.home, '.mec'), 'REAL-HOME PROTOCOL'],
    ] as const) {
      mkdirSync(join(root, 'prompts/roles/meta_agent'), { recursive: true })
      writeFileSync(join(root, part), text)
    }
    const { db, store } = openStore(dataDir)
    seedInterrupted(store)
    const handle = await startServer({ dataDir, metaSlotDir: scratch(), closeBoundMs: 100 })
    await stub.untilLaunches(1)
    await vi.waitFor(() => expect(stub.argv()).toContain('PROTOCOL'))

    expect(stub.argv()).toContain('DATA-DIR PROTOCOL')
    expect(stub.argv()).not.toContain('REAL-HOME PROTOCOL')
    await handle.close()
    db.close()
  }, 60_000)
})

describe('scratch data dirs (§5.4)', () => {
  it('prompts and models resolve under the data dir', async () => {
    const dataDir = scratch()
    const handle = await startServer({ dataDir })
    try {
      copyFileSync(
        fileURLToPath(new URL('../../../packages/prompts/defaults/models.yaml', import.meta.url)),
        join(dataDir, 'models.yaml'),
      )
      const models = (await (await fetch(`${handle.url}/api/models`)).json()) as {
        provenance: { source: string; path: string }
      }
      // The read comes first: on a tree without the fix the write below would land in ~/.mec.
      expect(models.provenance).toMatchObject({ source: 'user', path: join(dataDir, 'models.yaml') })

      const res = await fetch(`${handle.url}/api/prompts`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          base_revision: 0,
          origin: 'panel',
          parts: [{ path: 'roles/implementer.md', text: 'Scratch rules.\n' }],
        }),
      })
      expect(res.status).toBe(200)
      expect(existsSync(join(dataDir, 'prompts/roles/implementer.md'))).toBe(true)
    } finally {
      await handle.close()
    }
  }, 12_000)
})

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
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = mkdtempSync(join(tmpdir(), 'mec-composition-'))
    tempDirs.push(dataDir)
    const seed = new Database(join(dataDir, 'mec.db'))
    migrate(seed, MIGRATIONS_v1)
    new SqliteStore(seed).effects.enqueue('relay', 'wake:left-running', { reason: 'left running' })
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
