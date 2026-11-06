// Check runner (plan §15): argv-only children in their own process group, a capped 8 KiB
// log tail, a timeout that SIGKILLs the group, and statuses that keep a failing check
// (ran, non-zero) distinct from one that produced no verdict (timeout, signal, could not
// start). Uses the real /bin/echo, /bin/sh and /bin/sleep — these tests run in CI.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCheck, runChecks } from '../src/checks'

const cwd = process.cwd()

describe('runCheck', () => {
  it('passes a check that exits 0 and captures its output', async () => {
    const outcome = await runCheck({
      name: 'echo',
      cmd: '/bin/echo',
      args: ['check-ok'],
      cwd,
      timeoutMs: 10_000,
    })
    expect(outcome.status).toBe('passed')
    expect(outcome.exitCode).toBe(0)
    expect(outcome.logTail).toContain('check-ok')
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    expect(outcome.durationMs).toBeLessThan(10_000)
  })

  it('fails a check that exits non-zero, reporting its exit code', async () => {
    const outcome = await runCheck({
      name: 'exit-3',
      cmd: '/bin/sh',
      args: ['-c', 'echo doomed; exit 3'],
      cwd,
      timeoutMs: 10_000,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.exitCode).toBe(3)
    expect(outcome.logTail).toContain('doomed')
  })

  it('errors on timeout: the group is SIGKILLed, exitCode is null', async () => {
    const outcome = await runCheck({
      name: 'hang',
      cmd: '/bin/sleep',
      args: ['30'],
      cwd,
      timeoutMs: 150,
    })
    expect(outcome.status).toBe('error')
    expect(outcome.exitCode).toBeNull()
    expect(outcome.durationMs).toBeGreaterThanOrEqual(150)
    expect(outcome.durationMs).toBeLessThan(10_000)
  })

  it('a cancelled check loses its whole group at once and gives no verdict', async () => {
    const controller = new AbortController()
    const pidFile = join(mkdtempSync(join(tmpdir(), 'mec-check-')), 'child.pid')
    const running = runCheck(
      {
        name: 'hang',
        cmd: '/bin/sh',
        args: ['-c', `sleep 30 & echo $! > ${pidFile}; wait`],
        cwd,
        timeoutMs: 30_000,
      },
      controller.signal,
    )
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const child = Number(readFileSync(pidFile, 'utf8'))
    controller.abort()
    const outcome = await running
    expect(outcome.status).toBe('error')
    expect(outcome.exitCode).toBeNull()
    expect(outcome.durationMs).toBeLessThan(10_000)
    // SIGKILL is sent to the group before the check resolves, but delivery and reaping of the
    // grandchild can lag the leader's close, so allow a short bound — far below the 30 s sleep.
    const gone = (): boolean => {
      try {
        process.kill(child, 0)
        return false
      } catch {
        return true
      }
    }
    const deadline = Date.now() + 2_000
    while (!gone() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(gone()).toBe(true)
  })

  it('a check cancelled before it starts never runs on', async () => {
    const outcome = await runCheck(
      { name: 'hang', cmd: '/bin/sleep', args: ['30'], cwd, timeoutMs: 30_000 },
      AbortSignal.abort(),
    )
    expect(outcome.status).toBe('error')
    expect(outcome.durationMs).toBeLessThan(10_000)
  })

  it('errors when the command cannot start', async () => {
    const outcome = await runCheck({
      name: 'missing',
      cmd: '/nonexistent-mec-binary',
      args: [],
      cwd,
      timeoutMs: 10_000,
    })
    expect(outcome.status).toBe('error')
    expect(outcome.exitCode).toBeNull()
    expect(outcome.logTail).toContain('could not start')
  })

  it('keeps only the last 8 KiB of output, including the last line', async () => {
    const outcome = await runCheck({
      name: 'noisy',
      cmd: '/bin/sh',
      args: [
        '-c',
        'awk \'BEGIN { for (i = 1; i <= 2000; i++) print "FILLER-LINE-" i }\'; echo THE-LAST-LINE',
      ],
      cwd,
      timeoutMs: 10_000,
    })
    expect(outcome.status).toBe('passed')
    expect(Buffer.byteLength(outcome.logTail, 'utf8')).toBeLessThanOrEqual(8192)
    expect(outcome.logTail).toContain('THE-LAST-LINE')
    expect(outcome.logTail).toContain('FILLER-LINE-2000')
    // The head was dropped: line 1000 sits well outside the kept tail.
    expect(outcome.logTail).not.toContain('FILLER-LINE-1000\n')
    expect(outcome.logTail.endsWith('THE-LAST-LINE\n')).toBe(true)
  })
})

describe('runChecks', () => {
  it('runs specs sequentially and returns outcomes in order', async () => {
    const outcomes = await runChecks([
      { name: 'first', cmd: '/bin/echo', args: ['one'], cwd, timeoutMs: 10_000 },
      { name: 'second', cmd: '/bin/sh', args: ['-c', 'exit 3'], cwd, timeoutMs: 10_000 },
      { name: 'third', cmd: '/nonexistent-mec-binary', args: [], cwd, timeoutMs: 10_000 },
    ])
    expect(outcomes.map((o) => o.name)).toEqual(['first', 'second', 'third'])
    expect(outcomes.map((o) => o.status)).toEqual(['passed', 'failed', 'error'])
  })
})
