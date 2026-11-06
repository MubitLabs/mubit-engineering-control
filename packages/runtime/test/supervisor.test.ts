// Plan §8.1 supervision contract against real binaries: group ownership, stop escalation,
// and exit classification. Grace windows are kept small (graceMs: 150) so the suite stays
// fast while exercising the real signalling paths.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
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

// Parentage cannot reach a process once this holds, so only the group still ties it to the attempt.
async function untilOrphaned(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const parent = execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
    if (parent.trim() === '1') return
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error(`pid ${pid} kept its parent`)
}

function reap(...pids: number[]): void {
  for (const pid of pids) if (!isGone(pid)) process.kill(pid, 'SIGKILL')
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

  // A command in a group of its own runs `script`, as Codex runs a shell command.
  function spawnCommand(attemptId: string, script: string, supervisor: Supervisor): void {
    const file = join(workdir, `${attemptId}.sh`)
    writeFileSync(file, script)
    supervisor.spawn({
      attemptId,
      generation: 1,
      cmd: '/bin/sh',
      args: ['-c', `set -m; /bin/sh ${file} & wait`],
      cwd: workdir,
      env,
    })
  }

  it('stops a job the command backgrounded, which no parent ties to the attempt (§8.1)', async () => {
    const pidFile = join(workdir, 'background.pid')
    const supervisor = new Supervisor()
    spawnCommand('background', `(/bin/sleep 30 & echo $! > ${pidFile}); /bin/sleep 30\n`, supervisor)
    const pid = await waitForPidFile(pidFile)
    await untilOrphaned(pid)
    try {
      await supervisor.stop('background', 1, { graceMs: 150 })
      expect(isGone(pid)).toBe(true)
    } finally {
      reap(pid)
    }
  })

  it('escalates on a backgrounded job that ignores SIGTERM (§8.1)', async () => {
    const pidFile = join(workdir, 'stubborn-job.pid')
    const job = `trap "" TERM; echo $$ > ${pidFile}; exec /bin/sleep 30`
    const supervisor = new Supervisor()
    spawnCommand('stubborn-job', `(/bin/sh -c '${job}' &); /bin/sleep 30\n`, supervisor)
    const pid = await waitForPidFile(pidFile)
    await untilOrphaned(pid)
    try {
      await expect(supervisor.stop('stubborn-job', 1, { graceMs: 150 })).resolves.toBe('escalated')
      expect(isGone(pid)).toBe(true)
    } finally {
      reap(pid)
    }
  })

  // The trap outlives the listing: the command that follows it starts after the stop began.
  it('stops what a trapping command starts after the signal (§8.1)', async () => {
    const readyFile = join(workdir, 'trapping.ready')
    const pidFile = join(workdir, 'trapping.pid')
    const first = `/bin/sh -c ': > ${readyFile}; exec /bin/sleep 30'`
    const next = `/bin/sh -c 'echo $$ > ${pidFile}; exec /bin/sleep 30'`
    const supervisor = new Supervisor()
    spawnCommand('trapping', `trap ":" TERM; ${first}; ${next}\n`, supervisor)
    await waitForFile(readyFile)
    try {
      await supervisor.stop('trapping', 1, { graceMs: 400 })
      expect(isGone(await waitForPidFile(pidFile))).toBe(true)
    } finally {
      if (existsSync(pidFile)) reap(await waitForPidFile(pidFile))
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

  // The attempt runner's monitor stops again as soon as the leader's death ends the event stream.
  // By then the group is gone and the stray has no parent to find it by: only the first stop knows it.
  async function strayOutliving(attemptId: string, supervisor: Supervisor): Promise<number> {
    const pidFile = join(workdir, `${attemptId}.pid`)
    const inner = `trap "" TERM; echo $$ > ${pidFile}; /bin/sleep 30; /bin/sleep 30`
    supervisor.spawn({
      attemptId,
      generation: 1,
      // Node, not `set -m`: dash without a terminal keeps a background job in its own group, so
      // on Linux the stray would never leave.
      cmd: process.execPath,
      args: [
        '-e',
        `require('node:child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(inner)}], { detached: true, stdio: 'ignore' })`,
      ],
      cwd: workdir,
      env,
    })
    return waitForPidFile(pidFile)
  }

  async function untilGroupGone(attemptId: string, supervisor: Supervisor): Promise<void> {
    while (supervisor.isAlive(attemptId, 1)) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }
  }

  it('a second stop waits for the first, while a stray ignores SIGTERM (§8.1)', async () => {
    const supervisor = new Supervisor()
    const pid = await strayOutliving('overlap', supervisor)
    try {
      const first = supervisor.stop('overlap', 1, { graceMs: 800 })
      await untilGroupGone('overlap', supervisor)
      const second = supervisor.stop('overlap', 1, { graceMs: 800 })
      await expect(second).resolves.toBe('escalated')
      expect(isGone(pid)).toBe(true)
      await expect(first).resolves.toBe('escalated')
      expect(supervisor.owns('overlap', 1)).toBe(false)
    } finally {
      if (!isGone(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  // A process SIGKILL cannot take is the kernel's doing, so only that much is faked: the pid
  // swallows its signals and keeps answering.
  it('a stray that survives SIGKILL fails both stops and stays owned (§8.1)', async () => {
    const supervisor = new Supervisor()
    const pid = await strayOutliving('refused', supervisor)
    const kill = process.kill.bind(process)
    const spy = vi
      .spyOn(process, 'kill')
      .mockImplementation((target, signal) => (Math.abs(target) === pid ? true : kill(target, signal)))
    try {
      const first = supervisor.stop('refused', 1, { graceMs: 300 })
      const refused = expect(first).rejects.toThrow('refused to die')
      await untilGroupGone('refused', supervisor)
      await expect(supervisor.stop('refused', 1, { graceMs: 300 })).rejects.toThrow('refused to die')
      await refused
      expect(supervisor.owns('refused', 1)).toBe(true)
    } finally {
      spy.mockRestore()
      kill(pid, 'SIGKILL')
    }
  })

  // The runner's monitor stops once more after a refusal, when the group has gone and no parent
  // leads to the stray. Dropping ownership there would forget a process that is still alive.
  it('a stop after a refusal still knows the stray, and stays refused until it goes (§8.1)', async () => {
    const supervisor = new Supervisor()
    const pid = await strayOutliving('retried', supervisor)
    const kill = process.kill.bind(process)
    const spy = vi
      .spyOn(process, 'kill')
      .mockImplementation((target, signal) => (Math.abs(target) === pid ? true : kill(target, signal)))
    try {
      await expect(supervisor.stop('retried', 1, { graceMs: 150 })).rejects.toThrow('refused to die')
      await untilGroupGone('retried', supervisor)
      await expect(supervisor.stop('retried', 1, { graceMs: 150 })).rejects.toThrow('refused to die')
      expect(supervisor.owns('retried', 1)).toBe(true)

      spy.mockRestore()
      await expect(supervisor.stop('retried', 1, { graceMs: 150 })).resolves.toBe('escalated')
      expect(isGone(pid)).toBe(true)
      expect(supervisor.owns('retried', 1)).toBe(false)
    } finally {
      spy.mockRestore()
      reap(pid)
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
