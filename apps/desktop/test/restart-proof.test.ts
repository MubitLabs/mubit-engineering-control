/**
 * What `mec restart` may signal, and what it says when it cannot finish. The processes are real:
 * a stand-in named like the launcher, started and ended here. No server runs, because these are the
 * cases a healthy one never reaches.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStart } from '@mec/runtime'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findServer, restartServer } from '../src/restart'

let scratch: string
let dataDir: string
const children: ChildProcess[] = []
let standIns = 0
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mec-restart-proof-'))
  mkdirSync(join(scratch, 'bin'))
})

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const fresh = (): void => {
  dataDir = mkdtempSync(join(scratch, 'data-'))
}

/** A process whose command line reads as the launcher's; it records a SIGTERM and ignores it. */
async function standIn(file = 'mec.js'): Promise<{ child: ChildProcess; pid: number; sawTerm: string }> {
  const path = join(scratch, 'bin', file)
  standIns += 1
  const sawTerm = `${path}.${standIns}.term`
  const ready = `${sawTerm}.ready`
  writeFileSync(
    path,
    `const { writeFileSync } = require('node:fs')
process.on('SIGTERM', () => writeFileSync(process.argv[2], ''))
writeFileSync(process.argv[3], '')
setInterval(() => {}, 1000)
`,
  )
  const child = spawn(process.execPath, [path, sawTerm, ready], { stdio: 'ignore' })
  children.push(child)
  while (!existsSync(ready)) await sleep(10)
  return { child, pid: child.pid as number, sawTerm }
}

const board = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    runtime: { state: 'ready', instances: 1, answering: true },
    parts: {},
    setup: { has_slot: true, has_repository: true },
    ...fields,
  })

const claim = (pid: number, fields: Record<string, unknown>, lock = `${pid}\n`): void => {
  writeFileSync(join(dataDir, '.mec.lock'), lock)
  writeFileSync(join(dataDir, 'health.json'), board({ pid, ...fields }))
}

const STALE = new Date(Date.now() - 60_000).toISOString()
const nowIso = (): string => new Date().toISOString()
const restart = () =>
  restartServer({
    dataDir,
    binPath: join(scratch, 'no-such-launcher.js'),
    stopBoundMs: 300,
    startBoundMs: 300,
  })

describe('the proof', () => {
  it('a recorded start time that matches proves the pid, even past the heartbeat', async () => {
    fresh()
    const { pid } = await standIn()
    claim(pid, { started: processStart(pid), heartbeatAt: STALE })
    expect(findServer(dataDir)).toEqual({ status: 'running', pid })
  })

  it('a pid reused by another process is not proven, however fresh the heartbeat', async () => {
    fresh()
    const { pid, sawTerm } = await standIn()
    claim(pid, { started: 'Thu Jan  1 00:00:00 2026', heartbeatAt: nowIso() })

    const outcome = await restart()

    expect(outcome.started).toBe(false)
    expect(outcome.lines.join('\n')).toContain('nothing was signalled')
    await sleep(100)
    expect(existsSync(sawTerm)).toBe(false)
  })

  it('a server from before the start time is proven by a fresh heartbeat and its command line', async () => {
    fresh()
    const { pid } = await standIn()
    claim(pid, { heartbeatAt: nowIso() })
    expect(findServer(dataDir)).toEqual({ status: 'running', pid })
  })

  it('such a server with a stale heartbeat is not proven', async () => {
    fresh()
    const { pid } = await standIn()
    claim(pid, { heartbeatAt: STALE })
    expect(findServer(dataDir).status).toBe('unproven')
  })

  it('a command line that is not the launcher’s is not proven', async () => {
    fresh()
    const { pid } = await standIn('other.js')
    claim(pid, { heartbeatAt: nowIso() })
    expect(findServer(dataDir).status).toBe('unproven')
  })

  it('a lock and a snapshot that name different pids prove nothing', async () => {
    fresh()
    const { pid } = await standIn()
    claim(pid, { started: processStart(pid), heartbeatAt: nowIso() }, `${process.pid}\n`)
    expect(findServer(dataDir).status).toBe('unproven')
  })

  it('a lock that names no pid is held, and proves nothing', async () => {
    fresh()
    writeFileSync(join(dataDir, '.mec.lock'), 'garbled')
    expect(findServer(dataDir).status).toBe('unproven')
  })

  it('a live writer with no lock file is not "nothing running"', async () => {
    fresh()
    const { pid } = await standIn()
    writeFileSync(join(dataDir, 'health.json'), board({ pid, heartbeatAt: nowIso() }))
    expect(findServer(dataDir).status).toBe('unproven')
  })

  it('a dead owner, or no files at all, is nothing running', async () => {
    fresh()
    expect(findServer(dataDir)).toEqual({ status: 'none' })
    const { child, pid } = await standIn()
    claim(pid, { heartbeatAt: STALE })
    child.kill('SIGKILL')
    while (child.exitCode === null && child.signalCode === null) await sleep(10)
    expect(findServer(dataDir)).toEqual({ status: 'none' })
  })
})

describe('what it says when it cannot finish', () => {
  it('a server that will not stop within the bound is reported, not killed, and nothing starts', async () => {
    fresh()
    const { child, pid, sawTerm } = await standIn()
    claim(pid, { started: processStart(pid), heartbeatAt: nowIso() })

    const outcome = await restart()

    expect(outcome.started).toBe(false)
    expect(outcome.lines.join('\n')).toContain(`pid ${pid} did not stop within 0.3 s`)
    expect(existsSync(sawTerm)).toBe(true)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
  })

  it('a start that ends says so, with no claim of a server', async () => {
    fresh()
    const failing = join(scratch, 'failing-launcher.js')
    writeFileSync(failing, 'process.exit(1)\n')

    const outcome = await restartServer({ dataDir, binPath: failing })

    expect(outcome.started).toBe(false)
    expect(outcome.lines.join('\n')).toContain('no server was started')
    expect(outcome.lines.join('\n')).toContain('exit 1')
  })

  it('a start that does not answer within the bound is not called a success', async () => {
    fresh()
    const silent = join(scratch, 'silent-launcher.js')
    writeFileSync(silent, 'setTimeout(() => {}, 1500)\n')

    const outcome = await restartServer({ dataDir, binPath: silent, startBoundMs: 300 })

    expect(outcome.started).toBe(false)
    expect(outcome.lines.join('\n')).toContain('has not answered within 0.3 s')
  })
})
