// What a planner turn and the scheduler see of a Codex slot's models (§3 rule 2): the home's last
// listing when a launch has kept one, the table's own rows when none has.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plannerPlacement } from '../src/planner-placement'

afterEach(() => {
  vi.unstubAllEnvs()
})

const SLOT = { id: 'slot_c', engine: 'codex', kind: 'codex-sub', home: '/nowhere/slot' }

function placement(docs: Record<string, unknown>) {
  vi.stubEnv('MEC_REAL_RUNNER', undefined)
  vi.stubEnv('MEC_FAKE_ENGINE', undefined)
  const store = { slots: { list: () => [SLOT] }, engines: { get: (id: string) => docs[id] } }
  return plannerPlacement(store as never, '/nowhere')
}

describe('a Codex slot’s marks', () => {
  it('with no listing kept, every table row is declared available', () => {
    const marks = placement({}).marks().slot_c ?? {}
    expect(marks['gpt-6-luna']).toBe('available')
    expect(marks['gpt-5.6-luna']).toBe('available')
  })

  it('a kept listing marks what the home offers available and every other row unavailable', () => {
    const listing = { slotId: 'slot_c', engine: 'codex', listed: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.5'] }
    const marks = placement({ 'slot-models/slot_c': listing }).marks().slot_c ?? {}
    expect(marks).toMatchObject({
      'gpt-5.6-luna': 'available',
      'gpt-5.6-sol': 'available',
      'gpt-5.6-terra': 'unavailable',
      'gpt-6-luna': 'unavailable',
      'gpt-6-astra': 'unavailable',
    })
    expect(marks['gpt-5.5']).toBeUndefined()
  })

  it("a listing kept for another engine is not this slot's", () => {
    const listing = { slotId: 'slot_c', engine: 'claude', listed: ['opus'] }
    const marks = placement({ 'slot-models/slot_c': listing }).marks().slot_c ?? {}
    expect(marks['gpt-6-luna']).toBe('available')
  })
})
