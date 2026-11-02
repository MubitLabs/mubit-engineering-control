import { TaskSpec } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { describeImpact, planImpact } from '../src'

const t = (key: string, objective = 'x') =>
  TaskSpec.parse({ key, title: key, objective, acceptanceChecks: ['test'] })

describe('planImpact', () => {
  it('classifies added, removed, changed and unchanged tasks', () => {
    const impact = planImpact([t('A'), t('B'), t('C')], [t('A'), t('B', 'different'), t('D')])
    expect(impact).toEqual({ added: ['D'], removed: ['C'], changed: ['B'], unchanged: ['A'] })
  })

  it('describes which in-progress work would stop', () => {
    const text = describeImpact(
      { added: [], removed: ['C'], changed: ['B'], unchanged: ['A'] },
      new Set(['B']),
    )
    expect(text).toBe('Changed: B (work in progress will be stopped)\nRemoved: C\nUnchanged, continuing: A')
  })
})
