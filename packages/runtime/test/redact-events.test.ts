import type { EngineEvent } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { redactEvent } from '../src/redact-events'

// Matches the contracts anthropic shape (sk-ant- + 20+ word chars); no real key.
const ANTHROPIC_KEY = `sk-ant-${'a1B2c3'.repeat(5)}`
// Shaped like nothing in SECRET_PATTERNS, so only the exact layer can catch it.
const UNPATTERNED_KEY = 'opc-zz9f82hf76slej30fma52c8xq'

function messageEvent(text: string): EngineEvent {
  return {
    type: 'message',
    role: 'assistant',
    text,
    seq: 2,
    at: '2026-11-03T18:00:00.000Z',
    attempt_id: 'att_1',
    generation: 1,
  }
}

function errorEvent(detail: string, raw?: unknown): EngineEvent {
  return {
    type: 'error',
    class: 'auth',
    detail,
    ...(raw !== undefined ? { raw } : {}),
    seq: 3,
    at: '2026-11-03T18:00:01.000Z',
    attempt_id: 'att_1',
    generation: 1,
  } as EngineEvent
}

describe('redactEvent', () => {
  it('redacts a patterned key in message text as [redacted:anthropic]', () => {
    const out = redactEvent(messageEvent(`the call failed with ${ANTHROPIC_KEY} in the log`), [], [])
    expect(out).not.toBe(messageEvent)
    expect(out.type === 'message' && out.text).toBe('the call failed with [redacted:anthropic] in the log')
  })

  it('redacts an exact key in error.detail as [redacted:exact]', () => {
    const out = redactEvent(
      errorEvent(`provider rejected ${UNPATTERNED_KEY} at handshake`),
      [],
      [UNPATTERNED_KEY],
    )
    expect(out.type === 'error' && out.detail).toBe('provider rejected [redacted:exact] at handshake')
  })

  it('redacts inside nested raw fields, not just top-level strings', () => {
    const out = redactEvent(
      errorEvent('request failed', { retries: [ANTHROPIC_KEY], envelope: { token: UNPATTERNED_KEY } }),
      [],
      [UNPATTERNED_KEY],
    )
    expect(out.type === 'error' && out.raw).toEqual({
      retries: ['[redacted:anthropic]'],
      envelope: { token: '[redacted:exact]' },
    })
  })

  it('leaves numbers, uuids and structure untouched when nothing matches', () => {
    const uuid = '3f2a9c1e-7b44-4d0a-9c8f-5e6a1b2d3e4f'
    const event: EngineEvent = {
      type: 'rate_limit',
      window: 'five_hour',
      status: 'warning',
      utilization: 0.87,
      resets_at: '2026-11-03T21:00:00.000Z',
      raw: { request_id: uuid, attempt: 7 },
      seq: 4,
      at: '2026-11-03T18:00:02.000Z',
      attempt_id: 'att_1',
      generation: 1,
    }
    const out = redactEvent(event, [], [])
    expect(out).toEqual(event)
    expect(out).not.toBe(event)
    expect(out.type === 'rate_limit' && out.utilization).toBe(0.87)
    expect(out.type === 'rate_limit' && out.raw).toEqual({ request_id: uuid, attempt: 7 })
  })

  it('never mutates the input event', () => {
    const event = messageEvent(`leaks ${ANTHROPIC_KEY} and ${UNPATTERNED_KEY}`)
    const snapshot = JSON.parse(JSON.stringify(event)) as EngineEvent
    deepFreeze(event)
    expect(() => redactEvent(event, [], [UNPATTERNED_KEY])).not.toThrow()
    expect(event).toEqual(snapshot) // still the original, secret and all
    const out = redactEvent(event, [], [UNPATTERNED_KEY])
    expect(out.type === 'message' && out.text).toBe('leaks [redacted:anthropic] and [redacted:exact]')
  })
})

/** Freezes every level, so a mutating walk would throw in strict mode instead of passing quietly. */
function deepFreeze(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry)
    Object.freeze(value)
  } else if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
    Object.freeze(value)
  }
}
