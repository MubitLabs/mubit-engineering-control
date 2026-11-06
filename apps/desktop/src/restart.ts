/**
 * `mec restart` (§21): finds the data dir's server, stops it by a pid proven to be MEC's, and
 * starts a new detached one from this install. The new server takes the last port itself
 * (`listenOnLastPort`), and `DirLock` stays what keeps a second writer out: nothing here replaces
 * it. A stop is SIGTERM only, so a server that will not go is reported, never killed.
 *
 * The new server has no log. Its output can carry an engine's stderr, and a file would be a write
 * that no redaction runs before (§5, AGENTS non-negotiable 5).
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { processStart } from '@mec/runtime'
import { isProcessAlive, lockOwner } from '@mec/store'
import { type HealthSnapshot, parseHealthSnapshot } from './health'
import { heartbeatIsFresh, movedLine } from './status'

/** §20: three close bounds of 10 s and the planner's 5 s grace, with room for the rest of a close. */
export const STOP_BOUND_MS = 45_000
/** A new process took over 12 s to start under load (bundle-defaults.test.ts); boot comes after. */
export const START_BOUND_MS = 40_000
const POLL_MS = 100

export type RestartOutcome = { started: boolean; lines: string[] }

export type RestartDeps = {
  dataDir: string
  /** The launcher to start, which is this install's. */
  binPath: string
  /** Test seams: the bounds above. */
  stopBoundMs?: number
  startBoundMs?: number
}

type Sighting = { status: 'none' } | { status: 'running'; pid: number } | { status: 'unproven'; why: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function readHealth(dataDir: string): HealthSnapshot | null {
  try {
    return parseHealthSnapshot(readFileSync(join(dataDir, 'health.json'), 'utf8'))
  } catch {
    return null
  }
}

/** The launcher's own command line: `mec`, or a path ending in `mec` or `mec.js`. */
function commandIsMec(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return /(^|[\s/])mec(\.m?js)?(\s|$)/.test(command.trim())
  } catch {
    return false
  }
}

/**
 * The pid is MEC's when both files name it and it is the process that wrote them. The recorded
 * start time proves that, the same way a launch mark does (§8.1). A server from before that field
 * has only a heartbeat too recent for its pid to have been reused, and its command line.
 */
function provenMec(pid: number, health: HealthSnapshot | null): boolean {
  if (health?.pid !== pid) return false
  if (health.started !== undefined) return processStart(pid) === health.started
  return heartbeatIsFresh(health.heartbeatAt, new Date()) && commandIsMec(pid)
}

export function findServer(dataDir: string): Sighting {
  const owner = lockOwner(dataDir)
  if (owner === 'unreadable') return { status: 'unproven', why: 'the lock file names no pid' }
  const health = readHealth(dataDir)
  if (owner !== undefined && isProcessAlive(owner)) {
    return provenMec(owner, health)
      ? { status: 'running', pid: owner }
      : {
          status: 'unproven',
          why: `pid ${owner} holds the lock but is not proven to be this server: it may be starting or stopping`,
        }
  }
  // No live lock owner, yet a live pid still writes health.json: a server that lost its lock file.
  const writer = health?.pid
  if (writer !== undefined && isProcessAlive(writer) && heartbeatIsFresh(health?.heartbeatAt, new Date())) {
    return { status: 'unproven', why: `pid ${writer} writes health.json but holds no lock` }
  }
  return { status: 'none' }
}

/** Whether the process is gone by the bound. A pid that vanished first needs no signal. */
async function stop(pid: number, boundMs: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    return false
  }
  const deadline = Date.now() + boundMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(POLL_MS)
  }
  return !isProcessAlive(pid)
}

/** Up means listening: the new pid has written its port into health.json. */
async function start(deps: RestartDeps, opening: string): Promise<RestartOutcome> {
  const { dataDir, binPath, startBoundMs = START_BOUND_MS } = deps
  const child = spawn(process.execPath, [...process.execArgv, binPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MEC_NO_OPEN: '1' },
  })
  let ended: string | undefined
  child.once('error', (error) => {
    ended = error.message
  })
  child.once('exit', (code, signal) => {
    ended = `exit ${code ?? signal}`
  })
  child.unref()

  const deadline = Date.now() + startBoundMs
  while (Date.now() < deadline) {
    const health = readHealth(dataDir)
    if (child.pid !== undefined && health?.pid === child.pid && health.port !== undefined) {
      const url = `http://127.0.0.1:${health.port}`
      const moved = health.portMoved
      return {
        started: true,
        lines: [
          `${opening} on port ${health.port} (pid ${child.pid}): ${url}`,
          ...(moved === undefined ? [] : [movedLine(moved)]),
        ],
      }
    }
    if (ended !== undefined) {
      const found = findServer(dataDir)
      const holder = found.status === 'running' ? `: pid ${found.pid} owns this data dir` : ''
      return {
        started: false,
        lines: [`no server was started: the new server ended (${ended})${holder}; run \`mec\` to see why`],
      }
    }
    await sleep(POLL_MS)
  }
  return {
    started: false,
    lines: [
      `no server was confirmed: pid ${child.pid} has not answered within ${startBoundMs / 1000} s and may still be starting; check \`mec status\``,
    ],
  }
}

export async function restartServer(deps: RestartDeps): Promise<RestartOutcome> {
  const { dataDir, stopBoundMs = STOP_BOUND_MS } = deps
  const found = findServer(dataDir)
  if (found.status === 'unproven') {
    return { started: false, lines: [`not restarted: ${found.why}; nothing was signalled`] }
  }
  if (found.status === 'none') return start(deps, 'no server was running; started one')
  if (!(await stop(found.pid, stopBoundMs))) {
    return {
      started: false,
      lines: [
        `not restarted: pid ${found.pid} did not stop within ${stopBoundMs / 1000} s; it was sent SIGTERM and no new server was started`,
      ],
    }
  }
  return start(deps, `stopped pid ${found.pid}; server restarted`)
}
