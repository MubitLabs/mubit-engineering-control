import { describe, expect, it } from 'vitest'
import { opencodeSlotEnv } from '../src/opencode-env'

describe('opencodeSlotEnv', () => {
  it('an untrusted repository gets OPENCODE_DISABLE_PROJECT_CONFIG=1 and nothing else', () => {
    expect(opencodeSlotEnv(false)).toEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: '1' })
  })

  it("a trusted repository gets an empty layer — the §8.4 name-override is the caller's", () => {
    const env = opencodeSlotEnv(true)
    expect(env).toEqual({})
    expect(Object.keys(env)).toHaveLength(0)
  })

  it('fits the buildAgentEnv slot layer: not secret-shaped by name or value', () => {
    // The §5.12 layer validation would throw on a secret-shaped name or value; the disable
    // variable is neither, so it can ride the slot layer untouched.
    for (const value of Object.values(opencodeSlotEnv(false))) {
      expect(value).toBe('1')
    }
  })
})
