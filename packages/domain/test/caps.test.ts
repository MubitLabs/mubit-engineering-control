import { describe, expect, it } from 'vitest'
import type { Caps } from '../src'
import { DEFAULT_CAPS, withinGlobalCaps, withinPerSlotCaps, withinPerWorkItemCaps } from '../src'

describe('DEFAULT_CAPS', () => {
  it('matches plan §11', () => {
    expect(DEFAULT_CAPS).toEqual({
      globalActiveAttempts: 4,
      perWorkItem: 2,
      perSlot: 2,
      fanOut: 3,
      agentDepth: 1,
      repairAttemptsPerTask: 2,
    })
  })
})

const globalTable: readonly [number, boolean][] = [
  [0, true],
  [4, true],
  [5, false],
]

const perWorkItemTable: readonly [number, boolean][] = [
  [1, true],
  [2, true],
  [3, false],
]

const perSlotTable: readonly [number, boolean][] = [
  [2, true],
  [3, false],
]

describe.each(globalTable)('withinGlobalCaps(active = %i)', (active, expected) => {
  it(`returns ${expected}`, () => {
    expect(withinGlobalCaps(active, DEFAULT_CAPS)).toBe(expected)
  })
})

describe.each(perWorkItemTable)('withinPerWorkItemCaps(active = %i)', (active, expected) => {
  it(`returns ${expected}`, () => {
    expect(withinPerWorkItemCaps(active, DEFAULT_CAPS)).toBe(expected)
  })
})

describe.each(perSlotTable)('withinPerSlotCaps(active = %i)', (active, expected) => {
  it(`returns ${expected}`, () => {
    expect(withinPerSlotCaps(active, DEFAULT_CAPS)).toBe(expected)
  })
})

describe('tightened policy', () => {
  const caps: Caps = { ...DEFAULT_CAPS, globalActiveAttempts: 2, perWorkItem: 1, perSlot: 1 }

  it('honours the policy file over the defaults', () => {
    expect(withinGlobalCaps(3, caps)).toBe(false)
    expect(withinPerWorkItemCaps(2, caps)).toBe(false)
    expect(withinPerSlotCaps(2, caps)).toBe(false)
    expect(withinGlobalCaps(2, caps)).toBe(true)
  })
})
