/**
 * `mec restart` end to end (§21): real scratch servers from a tree built like a package, driven by
 * the real launcher on a scratch `MEC_DATA_DIR`. Every signal here goes to a pid this file started
 * or read back from its own scratch data dir.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProcess } from '@mec/runtime'
import { type BuildOptions, build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { writeStopMarker } from '../src/stop-marker'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(appDir, '..', '..')

/** See bundle-defaults.test.ts: a new process can take many seconds under a full suite. */
const BOOT_MS = 40_000
const TEST_MS = 120_000

const NATIVE: BuildOptions = {
  format: 'esm',
  platform: 'node',
  target: 'node22',
  bundle: true,
  external: ['better-sqlite3', 'node-pty'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'silent',
}

let scratch: string
let install: string
let dataDir: string
const started: ChildProcess[] = []
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'mec-restart-'))
  install = join(scratch, 'install')
  mkdirSync(join(install, 'dist'), { recursive: true })
  cpSync(join(appDir, 'bin'), join(install, 'bin'), { recursive: true })
  cpSync(join(appDir, 'package.json'), join(install, 'package.json'))
  symlinkSync(join(appDir, 'node_modules'), join(install, 'node_modules'))
  cpSync(join(repoRoot, 'packages/prompts/defaults'), join(install, 'dist', 'prompts-defaults'), {
    recursive: true,
  })
  await build({
    ...NATIVE,
    entryPoints: [join(appDir, 'src', 'serve.ts')],
    outfile: join(install, 'dist', 'mec.mjs'),
  })
  await build({
    ...NATIVE,
    entryPoints: [join(appDir, 'src', 'mec.ts')],
    outfile: join(install, 'dist', 'mec-cli.mjs'),
  })
}, TEST_MS)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: scratch,
  MEC_DATA_DIR: dataDir,
  MEC_NO_OPEN: '1',
  MEC_FAKE_ENGINE: '1',
})

const healthPath = (): string => join(dataDir, 'health.json')
const lockPath = (): string => join(dataDir, '.mec.lock')

const health = (): { pid?: number; portMoved?: { from: number; to: number } } => {
  try {
    return JSON.parse(readFileSync(healthPath(), 'utf8'))
  } catch {
    return {}
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(ready: () => boolean | Promise<boolean>, what: string, ms = BOOT_MS): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await ready()) return
    await sleep(50)
  }
  throw new Error(`never happened in ${ms}ms: ${what}`)
}

/** A running `mec` from the built tree: resolves on its announce line. */
async function serve(): Promise<{ pid: number; port: number }> {
  const child = spawn(process.execPath, [join(install, 'bin', 'mec.js')], {
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(child)
  let output = ''
  const read = (chunk: Buffer): void => {
    output += chunk
  }
  child.stdout.on('data', read)
  child.stderr.on('data', read)
  await until(() => output.includes('listening on'), 'the announce line')
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(output)?.[1])
  await until(() => health().pid === child.pid, 'the first snapshot')
  return { pid: child.pid as number, port }
}

function mec(...args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [join(install, 'bin', 'mec.js'), ...args], {
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const read = (chunk: Buffer): void => {
    output += chunk
  }
  child.stdout.on('data', read)
  child.stderr.on('data', read)
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ code, output }))
  })
}

const answers = async (port: number): Promise<boolean> => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(5000) })).ok
  } catch {
    return false
  }
}

/** Whichever server this data dir now has, by the pid its own files name. */
const scratchServers = (): number[] => {
  const locked = existsSync(lockPath()) ? Number.parseInt(readFileSync(lockPath(), 'utf8'), 10) : 0
  const pids = [health().pid ?? 0, locked]
  return [...new Set(pids.filter((pid) => pid > 0))]
}

afterEach(async () => {
  const pids = scratchServers()
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM')
  for (const pid of pids) await until(() => !alive(pid), `scratch server ${pid} to stop`, 20_000)
  for (const child of started.splice(0)) child.kill('SIGKILL')
})

const fresh = (): void => {
  dataDir = mkdtempSync(join(scratch, 'data-'))
}

describe('mec stop', () => {
  it(
    'stops the running server: its pid is gone when it says so, and the stop is recorded',
    async () => {
      fresh()
      const { pid, port } = await serve()
      expect(await answers(port)).toBe(true)

      const { code, output } = await mec('stop')

      expect(output).toContain(`stopped pid ${pid}`)
      expect(code).toBe(0)
      expect(alive(pid)).toBe(false)
      expect(await answers(port)).toBe(false)
      expect(existsSync(join(dataDir, 'stop-marker'))).toBe(true)
      // The recorded stop holds: a watchdog's restart does not bring it back.
      const watchdog = await mec('restart', '--respect-stop')
      expect(watchdog.output).toContain('not starting')
      expect(scratchServers().filter(alive)).toEqual([])
    },
    TEST_MS,
  )

  it(
    'says plainly when nothing was running',
    async () => {
      fresh()
      const { code, output } = await mec('stop')
      expect(code).toBe(0)
      expect(output).toContain('no server was running')
    },
    TEST_MS,
  )
})

describe('mec restart', () => {
  it(
    'stops the running server and brings a new one up on the same port, detached',
    async () => {
      fresh()
      const before = await serve()
      expect(await answers(before.port)).toBe(true)

      const { code, output } = await mec('restart')

      expect(output).toContain(`port ${before.port}`)
      expect(code).toBe(0)
      expect(alive(before.pid)).toBe(false)
      const pid = health().pid as number
      expect(pid).not.toBe(before.pid)
      expect(output).toContain(`pid ${pid}`)
      // The command has exited, and what it started outlives it, in a group of its own.
      expect(alive(pid)).toBe(true)
      expect(readProcess(pid)?.pgid).toBe(pid)
      // From the same install.
      const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      expect(command).toContain(join(install, 'bin', 'mec.js'))
      expect(await answers(before.port)).toBe(true)
      expect(readFileSync(lockPath(), 'utf8').trim()).toBe(String(pid))
    },
    TEST_MS,
  )

  it(
    'keeps the port across a second restart',
    async () => {
      fresh()
      const { port } = await serve()
      expect((await mec('restart')).code).toBe(0)
      const second = await mec('restart')
      expect(second.code).toBe(0)
      expect(second.output).toContain(`port ${port}`)
      expect(await answers(port)).toBe(true)
    },
    TEST_MS,
  )

  it(
    'starts one when nothing is running, over a dead owner’s lock',
    async () => {
      fresh()
      const { port, pid } = await serve()
      process.kill(pid, 'SIGKILL')
      await until(() => !alive(pid), 'the crash')
      expect(existsSync(lockPath())).toBe(true)

      const { code, output } = await mec('restart')

      expect(code).toBe(0)
      expect(output).toContain('no server was running')
      expect(output).toContain(`port ${port}`)
      expect(await answers(port)).toBe(true)
    },
    TEST_MS,
  )

  it(
    'starts one on a data dir that has never run',
    async () => {
      fresh()
      const { code, output } = await mec('restart')
      expect(code).toBe(0)
      const port = Number(/port (\d+)/.exec(output)?.[1])
      expect(await answers(port)).toBe(true)
    },
    TEST_MS,
  )

  it(
    'says where it went when the last port is taken',
    async () => {
      fresh()
      const { port, pid } = await serve()
      process.kill(pid, 'SIGTERM')
      await until(() => !alive(pid), 'the stop')
      const squatter = createServer()
      await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve))
      try {
        const { code, output } = await mec('restart')
        const moved = health().portMoved
        expect(code).toBe(0)
        expect(moved?.from).toBe(port)
        expect(output).toContain(`port ${moved?.to}`)
        expect(output).toContain(`port ${port} is taken`)
      } finally {
        await new Promise((resolve) => squatter.close(resolve))
      }
    },
    TEST_MS,
  )

  it(
    'refuses when an unproven process holds the lock, and signals nothing',
    async () => {
      fresh()
      const stranger = spawn('sleep', ['120'], { stdio: 'ignore' })
      started.push(stranger)
      const pid = stranger.pid as number
      writeFileSync(lockPath(), `${pid}\n`)
      writeFileSync(
        healthPath(),
        JSON.stringify({
          runtime: { state: 'ready', instances: 1, answering: true },
          parts: {},
          setup: { has_slot: true, has_repository: true },
          pid,
          heartbeatAt: new Date().toISOString(),
        }),
      )

      const { code, output } = await mec('restart')

      expect(code).toBe(1)
      expect(output).toContain('not restarted')
      expect(output).toContain(String(pid))
      expect(alive(pid)).toBe(true)
      expect(stranger.exitCode).toBeNull()
      expect(stranger.signalCode).toBeNull()
      expect(health().pid).toBe(pid)
      rmSync(lockPath())
      rmSync(healthPath())
    },
    TEST_MS,
  )

  it(
    'the single-writer lock still holds: a second server does not start beside a live one',
    async () => {
      fresh()
      const { pid, port } = await serve()

      const { code, output } = await mec()

      expect(code).toBe(1)
      expect(output).toContain('another process owns')
      expect(alive(pid)).toBe(true)
      expect(await answers(port)).toBe(true)
      expect(readFileSync(lockPath(), 'utf8').trim()).toBe(String(pid))
    },
    TEST_MS,
  )

  it(
    'two restarts at once leave one server',
    async () => {
      fresh()
      const { port } = await serve()

      const [first, second] = await Promise.all([mec('restart'), mec('restart')])

      expect([first.code, second.code]).toContain(0)
      await until(() => answers(port), 'the survivor to answer')
      const owner = Number.parseInt(readFileSync(lockPath(), 'utf8'), 10)
      await until(() => health().pid === owner, 'the lock and the snapshot to agree')
      expect(alive(owner)).toBe(true)
    },
    TEST_MS,
  )

  it(
    'a restart that honours a stop leaves the running server alone',
    async () => {
      fresh()
      const { pid, port } = await serve()
      // A marker standing beside a live server (`mec stop` now stops it too): the watchdog's
      // restart must not touch that server either.
      writeStopMarker(dataDir, 'the owner stopped it')

      const { code, output } = await mec('restart', '--respect-stop')

      expect(code).toBe(0)
      expect(output).toContain('intentional stop marker present')
      expect(alive(pid)).toBe(true)
      expect(await answers(port)).toBe(true)
    },
    TEST_MS,
  )
})
