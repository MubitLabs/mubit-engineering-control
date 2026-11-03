import type { SlotState } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import type { SlotEvent, SlotSignal } from '../src/lifecycle'
import { SlotMachine } from '../src/lifecycle'

function machine(): { machine: SlotMachine; events: SlotEvent[] } {
  const events: SlotEvent[] = []
  return { machine: new SlotMachine((event) => events.push(event)), events }
}

const slot = (state: SlotState) => ({ id: 'max-1', state })

const EDGES: readonly [SlotState, SlotSignal, SlotState][] = [
  ['draft', 'home_created', 'home_ready'],
  ['home_ready', 'login_started', 'login_pending'],
  ['login_pending', 'probe_ok', 'healthy'],
  ['login_pending', 'probe_failed', 'degraded'],
  ['login_pending', 'login_cancelled', 'degraded'],
  ['healthy', 'probe_failed', 'degraded'],
  ['degraded', 'probe_ok', 'healthy'],
  ['healthy', 'retire', 'retired'],
  ['degraded', 'retire', 'retired'],
]

describe('slot lifecycle (§5.5)', () => {
  it.each(EDGES)('%s --%s--> %s', (from, event, to) => {
    const { machine: m, events } = machine()
    const input = slot(from)
    expect(m.apply(input, event)).toBe(to)
    expect(input.state).toBe(from) // the input is never mutated
    const expected: SlotEvent = { slot: 'max-1', from, to, at: expect.any(String) }
    if (to === 'degraded') expected.reason = 'auth_expired'
    expect(events).toEqual([expected])
  })

  it('healthy -> degraded carries the classified reason when one is given', () => {
    const { machine: m, events } = machine()
    expect(m.apply(slot('healthy'), 'probe_failed', 'quota_exhausted')).toBe('degraded')
    expect(events[0]?.reason).toBe('quota_exhausted')
  })

  it('walks the happy path and emits one ordered event per transition', () => {
    const { machine: m, events } = machine()
    let state: SlotState = 'draft'
    for (const signal of ['home_created', 'login_started', 'probe_ok'] as const) {
      state = m.apply(slot(state), signal)
    }
    expect(state).toBe('healthy')
    expect(events.map((event) => [event.from, event.to])).toEqual([
      ['draft', 'home_ready'],
      ['home_ready', 'login_pending'],
      ['login_pending', 'healthy'],
    ])
    for (const event of events) {
      expect(new Date(event.at).toISOString()).toBe(event.at)
    }
  })

  it.each([
    ['draft', 'login_started'],
    ['home_ready', 'probe_ok'],
    ['home_ready', 'retire'],
    ['degraded', 'probe_failed'],
    ['retired', 'retire'],
  ] as const)('refuses %s --%s-->', (from, event) => {
    const { machine: m, events } = machine()
    expect(() => m.apply(slot(from), event)).toThrow(`invalid transition ${from} --${event}-->`)
    expect(events).toEqual([]) // refused transitions emit nothing
  })
})
