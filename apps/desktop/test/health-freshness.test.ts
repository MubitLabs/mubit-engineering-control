import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processStart } from '@mec/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'
import { type HealthSnapshot, parseHealthSnapshot } from '../src/health'
import { runCli } from '../src/mec'
import { HEARTBEAT_STALE_MS, statusFromSnapshot } from '../src/status'

/**
 * Liveness (§21.2): `mec status` tells a dead server from a quiet one. These run the real writer;
 * the abrupt exit is a real `kill -9` of the real bundle.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()

const board = (fields: Partial<HealthSnapshot>): HealthSnapshot => ({
  runtime: { state: 'ready', instances: 1, answering: true },
  parts: {},
  setup: { has_slot: true, has_repository: true },
  ...fields,
})
const status = (snapshot: HealthSnapshot | null) =>
  statusFromSnapshot(snapshot, { initialized: true, now: NOW })

const tempDirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mec-health-'))
  tempDirs.push(dir)
  return dir
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (ready: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !ready()) await sleep(25)
  expect(ready()).toBe(true)
}
const readHealth = (dataDir: string): HealthSnapshot => {
  const snapshot = parseHealthSnapshot(readFileSync(join(dataDir, 'health.json'), 'utf8'))
  if (snapshot === null) throw new Error('no snapshot')
  return snapshot
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('statusFromSnapshot: the heartbeat', () => {
  it('stale snapshot is not answering', () => {
    const result = status(board({ heartbeatAt: ago(HEARTBEAT_STALE_MS + 1) }))
    expect(result).toEqual({ code: 1, lines: ['not answering'] })
  })

  it('a heartbeat just inside the limit is fresh', () => {
    expect(status(board({ heartbeatAt: ago(HEARTBEAT_STALE_MS) })).code).toBe(0)
  })

  it('the limit is five ticks of two seconds', () => {
    expect(HEARTBEAT_STALE_MS).toBe(10_000)
  })

  it('an older file with no heartbeat is not answering', () => {
    expect(status(board({})).lines).toEqual(['not answering'])
  })

  it('a heartbeat that is not a time is not answering', () => {
    expect(status(board({ heartbeatAt: 'soon' })).code).toBe(1)
  })

  it('a heartbeat from the future is not trusted', () => {
    expect(status(board({ heartbeatAt: ago(-(HEARTBEAT_STALE_MS + 1)) })).code).toBe(1)
  })

  it('a clean stop still reads not running', () => {
    const result = status(board({ runtime: { state: 'paused', instances: 0, answering: false } }))
    expect(result.lines).toEqual(['not running'])
  })

  it('parsing keeps the liveness fields and tolerates an older file', () => {
    const fields = { instanceId: 'i', pid: 42, heartbeatAt: ago(0), observedAt: ago(0) }
    expect(parseHealthSnapshot(JSON.stringify(board(fields)))).toMatchObject(fields)
    const older = parseHealthSnapshot(JSON.stringify(board({})))
    expect(older).not.toBeNull()
    expect(older?.heartbeatAt).toBeUndefined()
    // A field of the wrong type is dropped, not trusted and not fatal.
    const wrong = parseHealthSnapshot(JSON.stringify({ ...board({}), heartbeatAt: 7 }))
    expect(wrong?.heartbeatAt).toBeUndefined()
  })
})

describe('mec status reads the clock', () => {
  const run = async (text: string): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = []
    const code = await runCli(['status'], {
      readSnapshotText: () => text,
      initialized: () => true,
      markerDir: scratch(),
      dataDir: scratch(),
      stdout: (line) => lines.push(line),
      restartServer: async () => ({ started: true, lines: [] }),
      stopServer: async () => ({ stopped: true, lines: [] }),
    })
    return { code, lines }
  }

  it('a snapshot with a stale heartbeat exits 1', async () => {
    const stale = new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString()
    expect(await run(JSON.stringify(board({ heartbeatAt: stale })))).toEqual({
      code: 1,
      lines: ['not answering'],
    })
  })

  it('a snapshot with a fresh heartbeat exits 0', async () => {
    const result = await run(JSON.stringify(board({ heartbeatAt: new Date().toISOString() })))
    expect(result.code).toBe(0)
  })
})

describe('the writer', () => {
  it('idle healthy server stays exit 0', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const handle = await startServer({ dataDir })
    try {
      const first = readHealth(dataDir)
      expect(first.pid).toBe(process.pid)
      expect(first.instanceId).toBeTruthy()
      // Nothing changed on the board: the file is still rewritten, or quiet would read as dead.
      await until(() => readHealth(dataDir).heartbeatAt !== first.heartbeatAt, 15_000)
      const live = readHealth(dataDir)
      const at = new Date(Date.parse(String(live.heartbeatAt)) + 5_000)
      const healthy = { ...live, setup: { has_slot: true, has_repository: true } }
      expect(statusFromSnapshot(healthy, { initialized: true, now: at }).code).toBe(0)
    } finally {
      await handle.close()
      delete process.env.MEC_FAKE_ENGINE
    }
  })

  it('a data dir that goes away does not kill the server', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const handle = await startServer({ dataDir })
    const crashes: unknown[] = []
    const onCrash = (error: unknown): void => {
      crashes.push(error)
    }
    process.on('uncaughtException', onCrash)
    try {
      const health = join(dataDir, 'health.json')
      rmSync(health)
      renameSync(dataDir, `${dataDir}.gone`)
      tempDirs.push(`${dataDir}.gone`)
      await sleep(2_500)
      expect(crashes).toEqual([])
      expect((await fetch(`${handle.url}/api/status`)).ok).toBe(true)
    } finally {
      process.off('uncaughtException', onCrash)
      renameSync(`${dataDir}.gone`, dataDir)
      await handle.close()
      delete process.env.MEC_FAKE_ENGINE
    }
  })

  it('the snapshot says which process wrote it and where it listens', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const handle = await startServer({ dataDir })
    try {
      const snapshot = readHealth(dataDir)
      expect(snapshot.started).toBe(processStart(process.pid))
      expect(snapshot.port).toBe(handle.port)
    } finally {
      await handle.close()
      delete process.env.MEC_FAKE_ENGINE
    }
  })

  it('a new server has a new instance id', async () => {
    process.env.MEC_FAKE_ENGINE = '1'
    const dataDir = scratch()
    const first = await startServer({ dataDir })
    const firstId = readHealth(dataDir).instanceId
    await first.close()
    const second = await startServer({ dataDir })
    try {
      expect(readHealth(dataDir).instanceId).toBeTruthy()
      expect(readHealth(dataDir).instanceId).not.toBe(firstId)
    } finally {
      await second.close()
      delete process.env.MEC_FAKE_ENGINE
    }
  })
})

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const itWithBundle = existsSync(join(appDir, 'dist', 'mec.mjs')) ? it : it.skip

describe('a real process', () => {
  itWithBundle(
    'abrupt exit stops the heartbeat',
    async () => {
      const dataDir = scratch()
      const child = spawn(process.execPath, [join(appDir, 'bin', 'mec.js')], {
        env: { ...process.env, MEC_DATA_DIR: dataDir, MEC_NO_OPEN: '1', MEC_FAKE_ENGINE: '1' },
        stdio: 'ignore',
      })
      try {
        await until(() => existsSync(join(dataDir, 'health.json')), 30_000)
        const first = readHealth(dataDir)
        expect(first.pid).toBe(child.pid)
        await until(() => readHealth(dataDir).heartbeatAt !== first.heartbeatAt, 15_000)
      } finally {
        child.kill('SIGKILL')
      }
      await new Promise((resolve) => child.once('exit', resolve))
      const last = readHealth(dataDir)
      await sleep(2_500)
      expect(readHealth(dataDir).heartbeatAt).toBe(last.heartbeatAt)
      const later = new Date(Date.parse(String(last.heartbeatAt)) + HEARTBEAT_STALE_MS + 1)
      expect(statusFromSnapshot(last, { initialized: true, now: later }).lines).toEqual(['not answering'])
    },
    70_000,
  )
})
