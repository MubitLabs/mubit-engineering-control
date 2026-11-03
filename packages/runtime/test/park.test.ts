import type { EngineEvent, ErrorClass, Window } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { parkFromEvents } from '../src/park'

let seq = 0
const next = (): number => ++seq

function envelope<T extends object>(
  body: T,
): T & { seq: number; at: string; attempt_id: string; generation: number } {
  return { ...body, seq: next(), at: '2026-11-03T18:00:00.000Z', attempt_id: 'att_1', generation: 1 }
}

const message = (text: string): EngineEvent =>
  envelope({ type: 'message', role: 'assistant', text }) as EngineEvent

const error = (clazz: ErrorClass, detail: string): EngineEvent =>
  envelope({ type: 'error', class: clazz, detail }) as EngineEvent

const rateLimit = (window: Window, status: 'allowed' | 'warning' | 'rejected'): EngineEvent =>
  envelope({ type: 'rate_limit', window, status }) as EngineEvent

const exitCompleted = (): EngineEvent =>
  envelope({ type: 'exit', code: 0, terminal_reason: 'completed' }) as EngineEvent

/** A healthy stream top to bottom: no signal, no park. */
const cleanStream = (): EngineEvent[] => [sessionStarted(), message('working'), usage(), exitCompleted()]

const sessionStarted = (): EngineEvent =>
  envelope({
    type: 'session_started',
    session_id: 's_1',
    engine: 'claude',
    engine_version: '2.1.317',
  }) as EngineEvent

const usage = (): EngineEvent =>
  envelope({ type: 'usage', input_tokens: 120, output_tokens: 30 }) as EngineEvent

describe('parkFromEvents', () => {
  it('a quota error parks as quota_wait', () => {
    const decision = parkFromEvents([
      ...cleanStream().slice(0, 2),
      error('quota', '429 limit hit'),
      exitCompleted(),
    ])
    expect(decision).toEqual({
      park: true,
      state: 'quota_wait',
      reason: 'quota error: 429 limit hit',
    })
  })

  it('a rejected rate_limit parks as quota_wait with the window named', () => {
    const decision = parkFromEvents([
      ...cleanStream().slice(0, 2),
      rateLimit('five_hour', 'rejected'),
      exitCompleted(),
    ])
    expect(decision.park).toBe(true)
    if (decision.park) {
      expect(decision.state).toBe('quota_wait')
      expect(decision.reason).toContain('five_hour')
    }
  })

  it('an auth error parks as auth_required', () => {
    const decision = parkFromEvents([sessionStarted(), error('auth', 'token expired')])
    expect(decision).toEqual({ park: true, state: 'auth_required', reason: 'auth error: token expired' })
  })

  it('a provider_down error parks as provider_down', () => {
    const decision = parkFromEvents([sessionStarted(), error('provider_down', '503 overloaded')])
    expect(decision).toEqual({
      park: true,
      state: 'provider_down',
      reason: 'provider_down error: 503 overloaded',
    })
  })

  it('a clean stream never parks', () => {
    expect(parkFromEvents(cleanStream())).toEqual({ park: false })
    expect(parkFromEvents([])).toEqual({ park: false })
  })

  it('allowed and warning rate limits are not signals', () => {
    const events = [rateLimit('five_hour', 'warning'), rateLimit('seven_day', 'allowed'), exitCompleted()]
    expect(parkFromEvents(events)).toEqual({ park: false })
  })

  describe('ordering (last writer wins)', () => {
    it('a later error overrides an earlier one', () => {
      const decision = parkFromEvents([
        error('quota', '429'),
        message('retrying'),
        error('auth', 'token expired'),
      ])
      expect(decision).toEqual({ park: true, state: 'auth_required', reason: 'auth error: token expired' })
    })

    it('a rejected rate_limit after an error overrides it', () => {
      const decision = parkFromEvents([error('auth', 'token expired'), rateLimit('seven_day', 'rejected')])
      expect(decision.park).toBe(true)
      if (decision.park) {
        expect(decision.state).toBe('quota_wait')
        expect(decision.reason).toContain('seven_day')
      }
    })

    it('an attempt-local error (engine_bug) never masks an earlier parkable signal', () => {
      const decision = parkFromEvents([error('quota', '429'), error('engine_bug', 'panic'), exitCompleted()])
      expect(decision.park).toBe(true)
      if (decision.park) expect(decision.state).toBe('quota_wait')
    })

    it('recovery events after an error do not clear the park', () => {
      const decision = parkFromEvents([
        error('quota', '429'),
        message('engine retried internally'),
        envelope({ type: 'usage', input_tokens: 10, output_tokens: 5 }) as EngineEvent,
        exitCompleted(),
      ])
      expect(decision.park).toBe(true)
      if (decision.park) expect(decision.state).toBe('quota_wait')
    })
  })
})
