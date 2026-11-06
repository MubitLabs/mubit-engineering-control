// The launch default and the two variables that change it, as every reader sees them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { realRunnerOn } from '../src/attempt-launch'
import { plannerPlacement } from '../src/planner-placement'

afterEach(() => {
  vi.unstubAllEnvs()
})

const CASES: { env: Record<string, string>; on: boolean }[] = [
  { env: {}, on: true },
  { env: { MEC_REAL_RUNNER: '1' }, on: true },
  { env: { MEC_REAL_RUNNER: '0' }, on: false },
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

  it.each(CASES)('a planner turn sees launchable slots alone under $env: $on', ({ env, on }) => {
    vi.stubEnv('MEC_REAL_RUNNER', undefined)
    vi.stubEnv('MEC_FAKE_ENGINE', undefined)
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    const placement = plannerPlacement({} as never, '/nowhere')
    expect(placement.launchableSlots !== undefined).toBe(on)
  })
})
