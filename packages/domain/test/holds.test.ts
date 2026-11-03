import { describe, expect, it } from 'vitest'
import { HoldStore } from '../src'

describe('HoldStore', () => {
  it('holds an item and reports it held', () => {
    const store = new HoldStore()
    const hold = store.hold('w1', 'user said wait', '2026-11-03T09:00:00Z')
    expect(hold).toEqual({ workItemId: 'w1', reason: 'user said wait', at: '2026-11-03T09:00:00Z' })
    expect(store.status('w1')).toBe('held')
  })

  it('an unknown item is free', () => {
    expect(new HoldStore().status('w1')).toBe('free')
  })

  it('lifts once when the user says go, recording liftedAt', () => {
    const store = new HoldStore()
    store.hold('w1', 'user said wait', '2026-11-03T09:00:00Z')
    expect(store.lift('w1', '2026-11-03T10:00:00Z')).toBe(true)
    expect(store.status('w1')).toBe('free')
    expect(store.entries()).toEqual([
      {
        workItemId: 'w1',
        reason: 'user said wait',
        at: '2026-11-03T09:00:00Z',
        liftedAt: '2026-11-03T10:00:00Z',
      },
    ])
  })

  it('a second lift returns false — the go lifts only once', () => {
    const store = new HoldStore()
    store.hold('w1', 'user said wait', '2026-11-03T09:00:00Z')
    expect(store.lift('w1', '2026-11-03T10:00:00Z')).toBe(true)
    expect(store.lift('w1', '2026-11-03T11:00:00Z')).toBe(false)
    expect(store.entries()[0]?.liftedAt).toBe('2026-11-03T10:00:00Z')
  })

  it('lifting a never-held item returns false', () => {
    expect(new HoldStore().lift('w1', '2026-11-03T10:00:00Z')).toBe(false)
  })

  it('answers a status question without resuming — the hold stays put', () => {
    const store = new HoldStore()
    store.hold('w1', 'user said wait', '2026-11-03T09:00:00Z')
    expect(store.answerStatusQuestion('w1')).toBe('answered_without_resume')
    expect(store.status('w1')).toBe('held')
    expect(store.entries()[0]?.liftedAt).toBeUndefined()
  })

  it('a follow-up does not lift the hold; the latest wait refreshes the reason', () => {
    const store = new HoldStore()
    store.hold('w1', 'user said wait', '2026-11-03T09:00:00Z')
    store.hold('w1', 'still waiting on the deploy', '2026-11-03T09:05:00Z')
    expect(store.status('w1')).toBe('held')
    expect(store.entries()).toEqual([
      { workItemId: 'w1', reason: 'still waiting on the deploy', at: '2026-11-03T09:05:00Z' },
    ])
  })

  it('holds on separate items are independent', () => {
    const store = new HoldStore()
    store.hold('w1', 'wait', '2026-11-03T09:00:00Z')
    store.hold('w2', 'wait', '2026-11-03T09:00:00Z')
    expect(store.lift('w1', '2026-11-03T10:00:00Z')).toBe(true)
    expect(store.status('w1')).toBe('free')
    expect(store.status('w2')).toBe('held')
  })
})
