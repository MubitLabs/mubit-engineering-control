import { describe, expect, it } from 'vitest'
import { Supervisor } from '../src/supervisor'

const owner = { attemptId: 'a1', generation: 1 }
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Supervisor', () => {
  it('runs argv without a shell, so metacharacters are plain data', async () => {
    const s = new Supervisor()
    const child = s.spawn(owner, {
      argv: ['echo', 'a; rm -rf / $(whoami)'],
      cwd: process.cwd(),
      env,
      stdin: 'ignore',
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    await child.exited
    expect(out.trim()).toBe('a; rm -rf / $(whoami)')
  })

  it('terminates the whole process group, including grandchildren', async () => {
    const s = new Supervisor()
    const child = s.spawn(owner, {
      argv: ['sh', '-c', 'sleep 30 & echo $!; wait'],
      cwd: process.cwd(),
      env,
      stdin: 'ignore',
    })
    const grandchild = await new Promise<number>((resolve) => {
      child.stdout.once('data', (d) => resolve(Number(String(d).trim())))
    })
    expect(alive(grandchild)).toBe(true)
    expect(s.isLive(owner)).toBe(true)
    await child.terminate(500)
    expect(alive(child.pid)).toBe(false)
    expect(alive(grandchild)).toBe(false)
    expect(s.isLive(owner)).toBe(false)
  })

  it('escalates to SIGKILL when a process ignores SIGTERM', async () => {
    const s = new Supervisor()
    const child = s.spawn(owner, {
      argv: ['sh', '-c', "trap '' TERM; echo ready; while true; do sleep 1; done"],
      cwd: process.cwd(),
      env,
      stdin: 'ignore',
    })
    await new Promise((r) => child.stdout.once('data', r))
    const started = Date.now()
    await child.terminate(300)
    expect(alive(child.pid)).toBe(false)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('tracks ownership by attempt and generation', async () => {
    const s = new Supervisor()
    const child = s.spawn(owner, { argv: ['sleep', '5'], cwd: process.cwd(), env, stdin: 'ignore' })
    expect(s.isLive({ attemptId: 'a1', generation: 2 })).toBe(false)
    await s.terminateAttempt('a1')
    await child.exited
    expect(s.isLive(owner)).toBe(false)
  })
})
