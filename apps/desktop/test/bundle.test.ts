/**
 * The §21.1 packaging smoke: `node bin/mec.js` must boot the bundle as a real Node process,
 * keep the composition's health snapshot warm in the data dir and announce its URL. Skipped
 * until `pnpm build:desktop` has produced dist/mec.mjs, so a clean checkout stays green.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
        env: { ...process.env, MEC_DATA_DIR: dataDir },
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
})
