import { describe, expect, it } from 'vitest'
import type { PlanTaskLike } from '../src'
import { computeImpact } from '../src'

const task = (id: string, over: Partial<PlanTaskLike> = {}): PlanTaskLike => ({
  id: `task_${id}`,
  dependsOn: [],
  ownedPaths: [`src/${id}/`],
  acceptanceChecks: ['test'],
  maxAttempts: 2,
  basePolicy: 'contract',
  ...over,
})

describe('computeImpact', () => {
  it('partitions a revision into added, changed, removed and unchanged', () => {
    const before = [
      task('a'),
      task('b'),
      task('c', { objective: 'Do c' }),
      task('e', { ownedPaths: ['src/e/'] }),
    ]
    const after = [
      task('a'),
      task('b', { maxAttempts: 3 }),
      task('c', { objective: 'Do c properly' }),
      task('d'),
    ]
    expect(computeImpact(before, after)).toEqual({
      added: ['task_d'],
      changed: ['task_b', 'task_c'],
      removed: ['task_e'],
      unchanged: ['task_a'],
    })
  })

  it('treats a reordered dependency list as a change', () => {
    const before = [task('a'), task('b'), task('c', { dependsOn: ['task_a', 'task_b'] })]
    const after = [task('a'), task('b'), task('c', { dependsOn: ['task_b', 'task_a'] })]
    expect(computeImpact(before, after)).toEqual({
      added: [],
      changed: ['task_c'],
      removed: [],
      unchanged: ['task_a', 'task_b'],
    })
  })

  it('treats a gained or lost objective as a change, and matching absence as equal', () => {
    const before = [task('a'), task('b', { objective: 'Do b' })]
    const after = [task('a'), task('b')]
    expect(computeImpact(before, after).changed).toEqual(['task_b'])
    expect(computeImpact([task('a')], [task('a')]).unchanged).toEqual(['task_a'])
  })
})
