// What each engine row's worker can do, read off the launch config the row really writes
// (owner's horse tinder test, 9 November 2026): the planner placed a browser check on an
// OpenCode slot, where MEC refuses every shell command.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_ROWS, reachOf } from '../src/engine-registry'
import { plannerPlacement } from '../src/planner-placement'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('engine reach', () => {
  it('OpenCode edits files and cannot run commands: its shell asks reach a decider that refuses them', () => {
    expect(reachOf(ENGINE_ROWS.opencode!)).toEqual({ commands: false, edits: true, network: false })
  })

  it('Claude runs commands under the required sandbox, whose network is the engine’s own domains', () => {
    expect(reachOf(ENGINE_ROWS.claude!)).toEqual({ commands: true, edits: true, network: false })
  })

  it('Codex runs commands in its sandbox profile, which grants no network', () => {
    expect(reachOf(ENGINE_ROWS.codex!)).toEqual({ commands: true, edits: true, network: false })
  })

  it('a row whose sandbox is off cannot run commands, whatever its engine', () => {
    expect(reachOf({ ...ENGINE_ROWS.claude!, sandbox: 'off' }).commands).toBe(false)
    expect(reachOf({ ...ENGINE_ROWS.codex!, sandbox: 'off' }).commands).toBe(false)
  })
})

describe("the planner's reach per slot", () => {
  const SLOTS = [
    { id: 'slot_glm', engine: 'opencode', kind: 'opencode-glm', home: '/nowhere/glm' },
    { id: 'slot_codex', engine: 'codex', kind: 'codex-sub', home: '/nowhere/codex' },
    { id: 'slot_gem', engine: 'opencode', kind: 'opencode-gemini', home: '/nowhere/gem' },
  ]
  const placement = () => {
    vi.stubEnv('MEC_REAL_RUNNER', undefined)
    vi.stubEnv('MEC_FAKE_ENGINE', undefined)
    const store = { slots: { list: () => SLOTS }, engines: { get: () => undefined } }
    return plannerPlacement(store as never, '/nowhere')
  }

  it('each launchable slot carries its engine row’s reach, and a slot no row launches carries none', () => {
    const reach = placement().reach?.()
    expect(reach).toEqual({
      slot_glm: { commands: false, edits: true, network: false },
      slot_codex: { commands: true, edits: true, network: false },
    })
  })
})
