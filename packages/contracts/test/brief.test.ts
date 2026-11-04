import { describe, expect, it } from 'vitest'
import { AttemptBrief } from '../src'
import { FAKE_KEYS } from './fake-keys'
import { BRIEF } from './samples'

const parses = (patch: Record<string, unknown>) => AttemptBrief.safeParse({ ...BRIEF, ...patch }).success
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('AttemptBrief', () => {
  it('caps the routing note at 50 words', () => {
    expect(parses({ routing_note: words(50) })).toBe(true)
    expect(parses({ routing_note: words(51) })).toBe(false)
  })

  it('takes each origin message verbatim or by pointer, never both or neither', () => {
    expect(parses({ origin: { messages: [{ id: 'msg_1', pointer: 'message/msg_1' }] } })).toBe(true)
    expect(parses({ origin: { messages: [{ id: 'msg_1', text: 't', pointer: 'message/msg_1' }] } })).toBe(
      false,
    )
    expect(parses({ origin: { messages: [{ id: 'msg_1' }] } })).toBe(false)
    expect(parses({ origin: { messages: [] } })).toBe(false)
  })

  it('refuses secret-named env keys by the plan §5.12 substring rule', () => {
    for (const name of ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'db_password', 'CLIENT_SECRET', 'MEC_TOOLS_TOKEN']) {
      expect(parses({ env: { [name]: 'x' } }), name).toBe(false)
    }
    expect(parses({ env: { MEC_TASK: 'task_01', NODE_ENV: 'test', LANG: 'en_US.UTF-8' } })).toBe(true)
  })

  it('refuses an env value shaped like a provider key', () => {
    expect(parses({ env: { UPSTREAM: FAKE_KEYS.anthropic! } })).toBe(false)
  })

  it('points tools only at the local mec-tools server', () => {
    expect(parses({ tools: { url: 'http://127.0.0.1:1234/mcp', token: 't' } })).toBe(true)
    expect(parses({ tools: { url: 'https://mec.example.com/mcp', token: 't' } })).toBe(false)
  })
})

describe('AttemptBrief.model_request (additive v0.1)', () => {
  it('takes a tier or a model — exactly one — with a reason and optional effort/variant', () => {
    expect(
      parses({ model_request: { tier: 'strong', effort: 'max', reason: 'Security-sensitive migration.' } }),
    ).toBe(true)
    expect(parses({ model_request: { model: 'opus', reason: 'The user named the model.' } })).toBe(true)
    expect(
      parses({
        model_request: { model: 'zai-coding-plan/glm-5.3', variant: 'high', reason: 'Cheap lookup pass.' },
      }),
    ).toBe(true)
  })

  it('refuses neither, both, a missing reason and an unknown tier', () => {
    expect(parses({ model_request: { reason: 'neither tier nor model' } })).toBe(false)
    expect(parses({ model_request: { tier: 'strong', model: 'opus', reason: 'both' } })).toBe(false)
    expect(parses({ model_request: { tier: 'strong' } })).toBe(false) // the reason is required
    expect(parses({ model_request: { tier: 'turbo', reason: 'off the ladder' } })).toBe(false)
  })
})
