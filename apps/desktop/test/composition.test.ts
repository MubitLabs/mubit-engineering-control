import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
