// The numbers `ps` can answer with that must never reach kill(2) as a group: -1 is every process
// we may signal and -0 is our own group. No real process has them in reach, so `ps` and the kill
// are both faked here, and nothing is ever signalled.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reapGroup, Supervisor } from '../src/supervisor'

const ATTEMPT = 500
const IN_GROUP_ONE = 502
const IN_GROUP_ZERO = 503
const PS = [
  `${ATTEMPT} 1 ${ATTEMPT}`,
  `501 ${ATTEMPT} 777`,
  `${IN_GROUP_ONE} ${ATTEMPT} 1`,
  `${IN_GROUP_ZERO} ${ATTEMPT} 0`,
].join('\n')

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (_cmd: string, _args: string[], _opts: object, done: (e: null, out: string) => void) => {
    done(null, PS)
  },
}))

function gone(): Error {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
}

// The two strays that have only their pids take SIGKILL and not SIGTERM. Everything else is gone.
function fakeKill(): { signalled: (number | string)[][] } {
  const alive = new Set([IN_GROUP_ONE, IN_GROUP_ZERO])
  const signalled: (number | string)[][] = []
  vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (signal !== 0) signalled.push([target, signal as string])
    if (signal === 'SIGKILL') alive.delete(target)
    if (!alive.has(target)) throw gone()
    return true
  })
  return { signalled }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Supervisor stray groups', () => {
  it('signals a stray group, and never group 0 or 1', async () => {
    const { signalled } = fakeKill()
    const supervisor = new Supervisor()
    supervisor.adopt('groups', 1, ATTEMPT)
    await supervisor.stop('groups', 1, { graceMs: 50 })
    const targets = signalled.map(([target]) => target)
    expect(targets).toContain(-777)
    expect(targets.filter((target) => target === 0 || target === -1)).toEqual([])
  })

  it('a stray outside any group it can be reached by is signalled and confirmed by pid', async () => {
    const { signalled } = fakeKill()
    const supervisor = new Supervisor()
    supervisor.adopt('pids', 1, ATTEMPT)
    await expect(supervisor.stop('pids', 1, { graceMs: 50 })).resolves.toBe('escalated')
    expect(signalled).toContainEqual([IN_GROUP_ONE, 'SIGKILL'])
    expect(signalled).toContainEqual([IN_GROUP_ZERO, 'SIGKILL'])
  })

  it('a boot reap of a group another process started reaches its strays too', async () => {
    const { signalled } = fakeKill()
    await expect(reapGroup(ATTEMPT, { graceMs: 50 })).resolves.toBe('escalated')
    expect(signalled.map(([target]) => target)).toContain(-777)
    expect(signalled).toContainEqual([IN_GROUP_ONE, 'SIGKILL'])
  })
})
