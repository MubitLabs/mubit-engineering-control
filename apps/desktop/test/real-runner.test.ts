// The launch default and the two variables that change it, as every reader sees them.
import { buildAgentEnv } from '@mec/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { realRunnerOn, repoEnv } from '../src/attempt-launch'
import { plannerPlacement } from '../src/planner-placement'

afterEach(() => {
  vi.unstubAllEnvs()
})

const CASES: { env: Record<string, string>; on: boolean }[] = [
  { env: {}, on: true },
  { env: { MEC_REAL_RUNNER: '1' }, on: true },
  { env: { MEC_REAL_RUNNER: '0' }, on: false },
  { env: { MEC_REAL_RUNNER: 'false' }, on: false },
  { env: { MEC_REAL_RUNNER: 'FALSE' }, on: false },
  { env: { MEC_FAKE_ENGINE: '1' }, on: false },
  { env: { MEC_REAL_RUNNER: '1', MEC_FAKE_ENGINE: '1' }, on: false },
]

describe('a real launch is the default', () => {
  it.each(CASES)('$env reads as on: $on', ({ env, on }) => {
    expect(realRunnerOn(env)).toBe(on)
  })

  it('reads the process environment unless told otherwise', () => {
    vi.stubEnv('MEC_REAL_RUNNER', '0')
    expect(realRunnerOn()).toBe(false)
    vi.stubEnv('MEC_REAL_RUNNER', undefined)
    expect(realRunnerOn()).toBe(true)
  })

  // Plans see launchable slots alone, on or off (slot choice). The fake engine has its one slot. What
  // the runner changes is whether a launchable slot's marks are the capability table's.
  it.each(CASES)('a planner turn under $env: declared marks $on', ({ env, on }) => {
    vi.stubEnv('MEC_REAL_RUNNER', undefined)
    vi.stubEnv('MEC_FAKE_ENGINE', undefined)
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    const slot = { id: 'slot_a', engine: 'claude', kind: 'claude-sub', home: '/nowhere/slot' }
    const store = { slots: { list: () => [slot] } }
    const placement = plannerPlacement(store as never, '/nowhere')
    expect(placement.launchableSlots !== undefined).toBe(env.MEC_FAKE_ENGINE !== '1')
    expect(placement.marks().slot_a !== undefined).toBe(on)
  })
})

describe('what a repository command inherits', () => {
  it('the agent socket reaches an engine, and never a repository command', () => {
    const inherited = { PATH: '/bin', SSH_AUTH_SOCK: '/tmp/agent.sock', LANG: 'C' }
    vi.stubEnv('SSH_AUTH_SOCK', inherited.SSH_AUTH_SOCK)
    vi.stubEnv('LANG', inherited.LANG)
    const env = repoEnv('att_1', '/w', '/t', '/g')
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.LANG).toBe('C')
    expect(buildAgentEnv({ inherited, home: '/h', attempt: {} }).SSH_AUTH_SOCK).toBe(inherited.SSH_AUTH_SOCK)
  })
})
