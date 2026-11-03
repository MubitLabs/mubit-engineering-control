import { describe, expect, it } from 'vitest'
import { AttemptBrief } from '../src'
import {
  type AttemptHandle,
  AuthHealth,
  Capabilities,
  type EngineAdapter,
  Input,
  type LaunchSpec,
} from '../src/adapter'
import type { Runtime } from '../src/runtime'
import { BRIEF } from './samples'

const CAPABILITIES = {
  engine_version: '2.1.317',
  flags_verified: ['--output-format', 'stream-json', '--restricted'],
  structured_stream: true,
  questions: true,
  tool_approval: true,
  interrupt: true,
  resume: true,
  usage: true,
  rate_limit_events: true,
  sandbox: true,
  restricted_mode: false,
  mcp_http: false,
  usage_mode: 'cumulative',
}

describe('Capabilities', () => {
  it('accepts a subscription Claude probe and a leaner API-slot probe', () => {
    expect(Capabilities.safeParse(CAPABILITIES).success).toBe(true)
    expect(
      Capabilities.safeParse({
        ...CAPABILITIES,
        engine_version: '0.54.0',
        questions: false,
        restricted_mode: true,
        usage_mode: 'delta',
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown usage mode and a string where a boolean belongs', () => {
    expect(Capabilities.safeParse({ ...CAPABILITIES, usage_mode: 'sum' }).success).toBe(false)
    expect(Capabilities.safeParse({ ...CAPABILITIES, sandbox: 'required' }).success).toBe(false)
  })
})

describe('AuthHealth', () => {
  it('accepts a logged-in subscription and a bare not-logged-in reading', () => {
    expect(
      AuthHealth.safeParse({ logged_in: true, method: 'oauth', expires_soon: false, detail: 'Max, pro plan' })
        .success,
    ).toBe(true)
    expect(AuthHealth.safeParse({ logged_in: false }).success).toBe(true)
  })

  it('rejects a string for logged_in and an unknown field', () => {
    expect(AuthHealth.safeParse({ logged_in: 'yes' }).success).toBe(false)
    expect(AuthHealth.safeParse({ logged_in: true, expires_at: '2026-11-20T00:00:00.000Z' }).success).toBe(
      false,
    )
  })
})

describe('Input', () => {
  it('accepts a message answering msg_01 and a recovery note', () => {
    expect(
      Input.safeParse({
        id: 'inp_01',
        kind: 'message',
        text: 'Use Postgres for the audit log.',
        message_id: 'msg_01',
      }).success,
    ).toBe(true)
    expect(
      Input.safeParse({
        id: 'inp_02',
        kind: 'recovery',
        text: 'The laptop slept mid-turn; resume from the journal.',
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown kind and a mis-prefixed id', () => {
    expect(Input.safeParse({ id: 'inp_01', kind: 'reply', text: 'hi' }).success).toBe(false)
    expect(Input.safeParse({ id: 'msg_01', kind: 'message', text: 'hi' }).success).toBe(false)
  })
})

describe('EngineAdapter', () => {
  it('keeps the CONTRACTS §4 surface', () => {
    const surface: (keyof EngineAdapter)[] = [
      'probe',
      'launch',
      'send',
      'interrupt',
      'stop',
      'events',
      'classify',
      'mapReport',
    ]
    expect([...surface].sort()).toEqual([
      'classify',
      'events',
      'interrupt',
      'launch',
      'mapReport',
      'probe',
      'send',
      'stop',
    ])
  })

  it('builds a resumable LaunchSpec around the sample brief and a stub bridge', () => {
    const spec: LaunchSpec = {
      brief: AttemptBrief.parse(BRIEF),
      env: { MEC_TASK: 'task_01' },
      cwd: '/Users/me/wt/att_01',
      resume: { session_id: 'f5fdd8dd-5fb7-49ed-80cb-9eec8412c6e3' },
      bridge: { request: async () => 'allow' },
    }
    const handle: AttemptHandle = {
      attempt_id: spec.brief.attempt_id,
      generation: spec.brief.generation,
      pid: 4242,
    }
    expect(spec.resume?.session_id).toBeDefined()
    expect(spec.bridge.request).toBeTypeOf('function')
    expect(handle).toMatchObject({ attempt_id: 'att_01', generation: 0, pid: 4242 })
  })

  it('classifies an auth-shaped failure', () => {
    const classifier: Pick<EngineAdapter, 'classify'> = {
      classify: (error) => (String(error).includes('authentication') ? 'auth' : 'unknown'),
    }
    expect(classifier.classify(new Error('authentication_failed'))).toBe('auth')
  })
})

describe('Runtime', () => {
  it('keeps the CONTRACTS §4 surface', () => {
    const surface: (keyof Runtime)[] = ['launchAttempt', 'deliver', 'stop', 'replay']
    expect([...surface].sort()).toEqual(['deliver', 'launchAttempt', 'replay', 'stop'])
  })
})
