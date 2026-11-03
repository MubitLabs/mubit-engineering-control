import { describe, expect, it } from 'vitest'
import type { BasePolicy } from '../src'
import { dependencySatisfied } from '../src'

const matrix: readonly [BasePolicy, 'accepted' | 'integrated', boolean][] = [
  ['integration', 'integrated', true],
  ['integration', 'accepted', false],
  ['contract', 'accepted', true],
  ['contract', 'integrated', true],
]

describe.each(matrix)('dependencySatisfied(%s dependency, prerequisite %s)', (policy, state, expected) => {
  it(`returns ${expected}`, () => {
    expect(dependencySatisfied('task_dep', state, policy)).toBe(expected)
  })
})
