import { describe, expect, it } from 'vitest'
import type { RoledTaskNode } from '../src'
import { validateGraph } from '../src'

const opts = { knownChecks: ['lint', 'typecheck', 'test'], knownRoles: ['implementer', 'reviewer'] }

const node = (id: string, over: Partial<RoledTaskNode> = {}): RoledTaskNode => ({
  id: `task_${id}`,
  dependsOn: [],
  ownedPaths: [`src/${id}/`],
  acceptanceChecks: ['test'],
  maxAttempts: 2,
  basePolicy: 'contract',
  ...over,
})

const kinds = (issues: readonly { kind: string }[]) => issues.map((issue) => issue.kind)

describe('validateGraph', () => {
  it('accepts a valid three-task graph', () => {
    const issues = validateGraph(
      [
        node('c', { dependsOn: ['task_a', 'task_b'] }),
        node('b', { dependsOn: ['task_a'], role: 'implementer' }),
        node('a', { basePolicy: 'integration', acceptanceChecks: ['lint', 'test'] }),
      ],
      opts,
    )
    expect(issues).toEqual([])
  })

  it('detects a cycle and reports its path', () => {
    const issues = validateGraph(
      [
        node('a', { dependsOn: ['task_c'] }),
        node('b', { dependsOn: ['task_a'] }),
        node('c', { dependsOn: ['task_b'] }),
      ],
      opts,
    )
    expect(kinds(issues)).toEqual(['cycle'])
    expect(issues[0]?.detail).toBe('Dependency cycle: task_a -> task_c -> task_b -> task_a')
    expect(issues[0]?.taskId).toBe('task_a')
  })

  it('reports a self dependency as a one-node cycle', () => {
    const issues = validateGraph([node('a', { dependsOn: ['task_a'] })], opts)
    expect(kinds(issues)).toEqual(['cycle'])
    expect(issues[0]?.detail).toBe('Dependency cycle: task_a -> task_a')
  })

  it('rejects a dependency on a task outside the plan', () => {
    const issues = validateGraph([node('a', { dependsOn: ['task_gone'] })], opts)
    expect(kinds(issues)).toEqual(['missing_dependency'])
    expect(issues[0]?.detail).toBe("Task 'task_a' depends on 'task_gone', which is not in this plan")
    expect(issues[0]?.taskId).toBe('task_a')
  })

  it('rejects an acceptance check the repository does not define', () => {
    const issues = validateGraph([node('a', { acceptanceChecks: ['e2e'] })], opts)
    expect(kinds(issues)).toEqual(['unknown_check'])
    expect(issues[0]?.detail).toBe("Task 'task_a' uses check 'e2e', which is not defined for this repository")
  })

  it('rejects a role outside the registry', () => {
    const issues = validateGraph([node('a', { role: 'shadow' })], opts)
    expect(kinds(issues)).toEqual(['unknown_role'])
    expect(issues[0]?.detail).toBe("Task 'task_a' names role 'shadow', which is not in the registry")
  })

  it('accepts a task with no role at all', () => {
    expect(validateGraph([node('a')], opts)).toEqual([])
  })

  it('flags overlapping owned paths on independent tasks', () => {
    const issues = validateGraph(
      [node('a', { ownedPaths: ['src/shared/**'] }), node('b', { ownedPaths: ['src/shared/api'] })],
      opts,
    )
    expect(kinds(issues)).toEqual(['path_conflict'])
    expect(issues[0]?.detail).toBe(
      "Tasks 'task_a' and 'task_b' can run concurrently but own overlapping paths: src/shared/** ~ src/shared/api",
    )
  })

  it('does not flag shared paths when one task depends on the other', () => {
    const issues = validateGraph(
      [
        node('a', { ownedPaths: ['src/shared/**'] }),
        node('b', { dependsOn: ['task_a'], ownedPaths: ['src/shared/api'] }),
      ],
      opts,
    )
    expect(issues).toEqual([])
  })

  it('rejects zero attempts as a budget violation', () => {
    const issues = validateGraph([node('a', { maxAttempts: 0 })], opts)
    expect(kinds(issues)).toEqual(['budget'])
    expect(issues[0]?.detail).toBe("Task 'task_a' has maxAttempts 0; at least 1 is required")
  })
})
