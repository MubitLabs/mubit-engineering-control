// Plan §8.1 supervision contract against real binaries: group ownership, stop escalation,
// and exit classification. Grace windows are kept small (graceMs: 150) so the suite stays
// fast while exercising the real signalling paths.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyExit, Supervisor, SupervisorError } from '../src/supervisor'

const workdir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-supervisor-'))
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const env = { PATH: '/usr/bin:/bin' }

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error(`file never appeared: ${path}`)
}

async function waitForPidFile(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
      if (!Number.isNaN(pid)) return pid
    } catch {
      // not written yet
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error(`pid file never appeared: ${path}`)
}

describe('Supervisor', () => {
  it('spawns, reports alive, and terminates on SIGTERM', async () => {
    const supervisor = new Supervisor()
    const owned = supervisor.spawn({
      attemptId: 'sleep-1',
      generation: 1,
      cmd: '/bin/sleep',
      args: ['30'],
      cwd: workdir,
      env,
    })
    expect(owned.attemptId).toBe('sleep-1')
    expect(owned.generation).toBe(1)
    expect(owned.pid).toBeGreaterThan(0)
    expect(supervisor.isAlive('sleep-1', 1)).toBe(true)
    expect(supervisor.isAlive('unknown-attempt', 9)).toBe(false)

    const outcome = await supervisor.stop('sleep-1', 1, { graceMs: 150 })
    expect(outcome).toBe('terminated')
    expect(supervisor.isAlive('sleep-1', 1)).toBe(false)
    // confirmed gone, not just forgotten: the pid itself no longer answers
    expect(isGone(owned.pid)).toBe(true)
  })

  it('throws SupervisorError when stopping twice', async () => {
    const supervisor = new Supervisor()
    supervisor.spawn({
      attemptId: 'sleep-2',
      generation: 3,
      cmd: '/bin/sleep',
      args: ['30'],
      cwd: workdir,
      env,
    })
    await expect(supervisor.stop('sleep-2', 3, { graceMs: 150 })).resolves.toBe('terminated')
    await expect(supervisor.stop('sleep-2', 3)).rejects.toBeInstanceOf(SupervisorError)
  })

  it('throws SupervisorError when the binary does not exist', () => {
    const supervisor = new Supervisor()
    expect(() =>
      supervisor.spawn({
        attemptId: 'sleep-3',
        generation: 1,
        cmd: '/nonexistent/binary',
        args: [],
        cwd: workdir,
        env,
      }),
    ).toThrow(SupervisorError)
  })

  it('stops the whole process group', async () => {
    const supervisor = new Supervisor()
    const pidFile = join(workdir, 'group.pid')
    // The inner `sleep 30` lands in the detached group but is NOT a direct child of this
    // process — killing only the shell pid would orphan it, so it proves group-wide death.
    supervisor.spawn({
      attemptId: 'group-1',
      generation: 1,
      cmd: '/bin/sh',
      args: ['-c', `sleep 30 & echo $! > "${pidFile}" && wait`],
      cwd: workdir,
      env,
    })
    const innerPid = await waitForPidFile(pidFile)
    expect(supervisor.isAlive('group-1', 1)).toBe(true)

    await expect(supervisor.stop('group-1', 1, { graceMs: 150 })).resolves.toBe('terminated')
    expect(supervisor.isAlive('group-1', 1)).toBe(false)
    expect(isGone(innerPid)).toBe(true)

    // no state corruption: the supervisor keeps working for the next attempt
    supervisor.spawn({
      attemptId: 'group-2',
      generation: 1,
      cmd: '/bin/sleep',
      args: ['30'],
      cwd: workdir,
      env,
    })
    expect(supervisor.isAlive('group-2', 1)).toBe(true)
    await expect(supervisor.stop('group-2', 1, { graceMs: 150 })).resolves.toBe('terminated')
  })

  // `set -m` gives each background job a process group of its own, as Codex does for a command.
  it('stops a descendant that left for a process group of its own', async () => {
    const pidFile = join(workdir, 'own-group.pid')
    const supervisor = new Supervisor()
    supervisor.spawn({
      attemptId: 'own-group',
      generation: 1,
      cmd: '/bin/sh',
      args: ['-c', `set -m; /bin/sleep 30 & echo $! > ${pidFile}; wait`],
      cwd: workdir,
      env,
    })
    const pid = await waitForPidFile(pidFile)
    try {
      await supervisor.stop('own-group', 1, { graceMs: 150 })
      expect(isGone(pid)).toBe(true)
    } finally {
      if (!isGone(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('escalates on a descendant in its own group that ignores SIGTERM', async () => {
    const pidFile = join(workdir, 'stubborn.pid')
    const inner = `trap "" TERM; echo $$ > ${pidFile}; /bin/sleep 30; /bin/sleep 30`
    const supervisor = new Supervisor()
    supervisor.spawn({
      attemptId: 'stubborn',
      generation: 1,
      cmd: '/bin/sh',
      args: ['-c', `set -m; /bin/sh -c '${inner}' & wait`],
      cwd: workdir,
      env,
    })
    const pid = await waitForPidFile(pidFile)
    try {
      await expect(supervisor.stop('stubborn', 1, { graceMs: 150 })).resolves.toBe('escalated')
      expect(isGone(pid)).toBe(true)
    } finally {
      if (!isGone(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const supervisor = new Supervisor()
    // The ready file appears only after `trap '' TERM` is installed, so the group signal
    // cannot win the race against the trap.
    const readyFile = join(workdir, 'stubborn.ready')
    supervisor.spawn({
      attemptId: 'stubborn-1',
      generation: 1,
      cmd: '/bin/sh',
      args: ['-c', `trap '' TERM; : > "${readyFile}" && while :; do sleep 1; done`],
      cwd: workdir,
      env,
    })
    await waitForFile(readyFile)
    const outcome = await supervisor.stop('stubborn-1', 1, { graceMs: 150 })
    expect(outcome).toBe('escalated')
    expect(supervisor.isAlive('stubborn-1', 1)).toBe(false)
  })
})

describe('classifyExit', () => {
  it.each<[number | null, string | null, string]>([
    [0, null, 'completed'],
    [null, 'SIGTERM', 'killed'],
    [null, 'SIGINT', 'killed'],
    [null, 'SIGKILL', 'crashed'],
    [1, null, 'crashed'],
  ])('(%s, %s) is %s', (code, signal, expected) => {
    expect(classifyExit(code, signal)).toBe(expected)
  })
})
