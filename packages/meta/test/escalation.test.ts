import { describe, expect, it } from 'vitest'
import { EscalationCounter } from '../src'

describe('EscalationCounter (plan §6)', () => {
  it('continues through three invalid proposals and escalates on the fourth', () => {
    const counter = new EscalationCounter()
    expect(counter.addInvalid('turn-1')).toBe('continue')
    expect(counter.addInvalid('turn-1')).toBe('continue')
    expect(counter.addInvalid('turn-1')).toBe('continue')
    expect(counter.addInvalid('turn-1')).toBe('escalate')
  })

  it('keeps escalating past the limit until the streak resets', () => {
    const counter = new EscalationCounter()
    for (let i = 0; i < 4; i += 1) counter.addInvalid('turn-1')
    expect(counter.addInvalid('turn-1')).toBe('escalate')
  })

  it('a valid proposal resets the consecutive count', () => {
    const counter = new EscalationCounter()
    counter.addInvalid('turn-1')
    counter.addInvalid('turn-1')
    counter.addInvalid('turn-1')
    counter.reset('turn-1')
    expect(counter.addInvalid('turn-1')).toBe('continue')
    counter.reset('turn-1')
    expect(counter.addInvalid('turn-1')).toBe('continue')
    expect(counter.addInvalid('turn-1')).toBe('continue')
    expect(counter.addInvalid('turn-1')).toBe('continue')
    expect(counter.addInvalid('turn-1')).toBe('escalate')
  })

  it('counts are isolated per attempt', () => {
    const counter = new EscalationCounter()
    counter.addInvalid('turn-1')
    counter.addInvalid('turn-1')
    counter.addInvalid('turn-1')
    expect(counter.addInvalid('turn-2')).toBe('continue')
    counter.reset('turn-1')
    expect(counter.addInvalid('turn-2')).toBe('continue')
    expect(counter.addInvalid('turn-2')).toBe('continue')
    expect(counter.addInvalid('turn-2')).toBe('escalate')
  })

  it('honours a custom limit', () => {
    const counter = new EscalationCounter(2)
    expect(counter.addInvalid('turn-1')).toBe('continue')
    expect(counter.addInvalid('turn-1')).toBe('escalate')
  })
})
