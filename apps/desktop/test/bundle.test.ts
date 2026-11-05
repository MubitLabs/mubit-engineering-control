/**
 * The §21.1 packaging smoke: `node bin/mec.js` must boot the bundle as a real Node process,
 * keep the composition's health snapshot warm in the data dir and announce its URL. Skipped
 * until `pnpm build:desktop` has produced dist/mec.mjs, so a clean checkout stays green.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const binPath = join(appDir, 'bin', 'mec.js')
const healthOf = (dataDir: string): string => join(dataDir, 'health.json')

const hasBundle = existsSync(join(appDir, 'dist', 'mec.mjs'))
const itWithBundle = hasBundle ? it : it.skip

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('bin/mec.js bundle smoke', () => {
  itWithBundle(
    'boots the bundled server and writes health.json',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'mec-bundle-'))
      tempDirs.push(dataDir)

      const child = spawn(process.execPath, [binPath], {
        env: { ...process.env, MEC_DATA_DIR: dataDir, MEC_NO_OPEN: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk
      })
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk
      })

      try {
        // serveMain stays alive by design (§21), so the proof is the snapshot the composition
        // keeps warm plus serveMain's own startup line — poll for the file first…
        const deadline = Date.now() + 6000
        while (Date.now() < deadline && !existsSync(healthOf(dataDir))) await sleep(100)
        expect(existsSync(healthOf(dataDir)), `stdout: ${out}\nstderr: ${err}`).toBe(true)

        const snapshot = JSON.parse(readFileSync(healthOf(dataDir), 'utf8')) as {
          runtime?: { state?: unknown }
        }
        expect(typeof snapshot.runtime?.state, `stdout: ${out}\nstderr: ${err}`).toBe('string')

        // …then the announce line (it follows the listen that follows the first snapshot write).
        const lineDeadline = Date.now() + 1500
        while (Date.now() < lineDeadline && !out.includes('mec server listening on')) await sleep(50)
        expect(out, `stderr: ${err}`).toContain('mec server listening on')

        // Shutdown is serveMain's SIGTERM path; SIGKILL in finally is the hard fallback.
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          child.once('exit', resolve)
          child.once('error', resolve)
          setTimeout(resolve, 1500).unref()
        })
      } finally {
        child.kill('SIGKILL')
      }
    },
    8000,
  )

  /** What a crash mid-planning leaves, so a resume relay is running when the signal lands. */
  const seedInterrupted = (dataDir: string): void => {
    const db = new Database(join(dataDir, 'mec.db'))
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    store.atomic(() => {
      store.engines.save({
        id: 'repo_a',
        url: 'https://example.test/a',
        bootstrap: [],
        checks: [],
        trust: true,
      })
      store.workItems.save({
        id: 'wi_1',
        state: 'planning',
        repoId: 'repo_a',
        pin: { repoId: 'repo_a' },
        mandate: { originMessageId: 'msg_1' },
      })
      store.messages.save({
        id: 'msg_1',
        text: 'request 1',
        repoId: 'repo_a',
        routing: 'new_work',
        workItemId: 'wi_1',
        createdAt: '2026-11-05T12:00:00.000Z',
      })
    })
    db.close()
  }

  itWithBundle(
    'exits within the bound while an engine child ignores the signal and holds its pipes',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mec-exit-'))
      tempDirs.push(dir)
      const dataDir = join(dir, 'data')
      mkdirSync(dataDir)
      mkdirSync(join(dir, 'slot'))
      mkdirSync(join(dir, 'bin'))
      const log = join(dir, 'engine.log')
      writeFileSync(
        join(dir, 'bin', 'claude'),
        `#!/bin/sh\ntrap '' TERM\nsleep 40 &\necho $! >> '${log}'\necho $$ >> '${log}'\nwait\n`,
        { mode: 0o755 },
      )
      seedInterrupted(dataDir)

      const { MEC_FAKE_ENGINE: _fake, ...inherited } = process.env
      const child = spawn(process.execPath, [binPath], {
        env: {
          ...inherited,
          HOME: dir,
          MEC_DATA_DIR: dataDir,
          MEC_META_SLOT: join(dir, 'slot'),
          MEC_NO_OPEN: '1',
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
      const enginePids = (): number[] =>
        existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(Number) : []

      try {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && enginePids().length < 2) await sleep(50)
        expect(enginePids()).toHaveLength(2)

        const signalled = Date.now()
        child.kill('SIGTERM')
        const code = await Promise.race([exited, sleep(14_000).then(() => 'still running')])

        expect(code).toBe(0)
        expect(Date.now() - signalled).toBeLessThan(13_000)
        expect(existsSync(join(dataDir, '.mec.lock'))).toBe(false)
      } finally {
        child.kill('SIGKILL')
        // Only the two pids the stub itself reported; each ignores SIGTERM on purpose.
        for (const pid of enginePids()) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
      }
    },
    25_000,
  )
})
