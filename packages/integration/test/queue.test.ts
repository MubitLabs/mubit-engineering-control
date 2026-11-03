import { describe, expect, it } from 'vitest'
import type { IntegrationTask } from '../src'
import { nextIntegrationStep } from '../src'

/** Minimal snapshot factory: a task fresh from acceptance, depending on nothing. */
const task = (taskId: string, overrides: Partial<IntegrationTask> = {}): IntegrationTask => ({
  taskId,
  dependsOn: [],
  basePolicy: 'contract',
  accepted: true,
  integrated: false,
  mergeFailed: false,
  ...overrides,
})

describe('nextIntegrationStep', () => {
  it('merges the first launchable task in dependency order', () => {
    const tasks = [task('task_b'), task('task_a')]
    expect(nextIntegrationStep(tasks)).toEqual({ action: 'merge', taskId: 'task_b' })
  })

  it('waits when an integration-policy dependency is not integrated', () => {
    const tasks = [
      task('task_dep', { accepted: false }),
      task('task_later', { dependsOn: ['task_dep'], basePolicy: 'integration' }),
    ]
    expect(nextIntegrationStep(tasks)).toEqual({ action: 'wait', reason: 'dependency_not_integrated' })
  })

  it('waits when an integration-policy dependency is absent from the snapshot', () => {
    const tasks = [task('task_later', { dependsOn: ['task_gone'], basePolicy: 'integration' })]
    expect(nextIntegrationStep(tasks)).toEqual({ action: 'wait', reason: 'dependency_not_integrated' })
  })

  it('merges a contract-policy task whose accepted dependency is not integrated', () => {
    // The dependency sits in repair (accepted, not integrated); §14 starts the contract
    // dependent anyway — only integration-policy dependents wait for the merged result.
    const tasks = [
      task('task_dep', { mergeFailed: true, conflictedPaths: ['src/dep.ts'] }),
      task('task_later', { dependsOn: ['task_dep'], basePolicy: 'contract' }),
    ]
    expect(nextIntegrationStep(tasks)).toEqual({ action: 'merge', taskId: 'task_later' })
  })

  it('waits when a contract-policy dependency is not accepted', () => {
    const tasks = [
      task('task_dep', { accepted: false }),
      task('task_later', { dependsOn: ['task_dep'], basePolicy: 'contract' }),
    ]
    expect(nextIntegrationStep(tasks)).toEqual({ action: 'wait', reason: 'not_accepted' })
  })

  it('repairs a merge conflict with its unmerged paths once nothing else can merge', () => {
    const tasks = [
      task('task_conflict', { mergeFailed: true, conflictedPaths: ['src/a.ts', 'src/b.ts'] }),
      task('task_pending', { accepted: false }),
    ]
    expect(nextIntegrationStep(tasks)).toEqual({
      action: 'repair',
      taskId: 'task_conflict',
      reason: 'conflict',
      conflictedPaths: ['src/a.ts', 'src/b.ts'],
    })
  })

  it('repairs failing checks on the merge SHA when no conflict paths exist', () => {
    const tasks = [task('task_checks', { mergeFailed: true })]
    const step = nextIntegrationStep(tasks)
    expect(step).toEqual({ action: 'repair', taskId: 'task_checks', reason: 'checks_failed' })
    expect(step.action === 'repair' && step.conflictedPaths).toBeUndefined()
  })

  it('merges a launchable task before repairing a failed one', () => {
    const tasks = [
      task('task_conflict', { mergeFailed: true, conflictedPaths: ['src/a.ts'] }),
      task('task_ok'),
    ]
    expect(nextIntegrationStep(tasks)).toEqual({ action: 'merge', taskId: 'task_ok' })
  })

  it('merges from the latest integration commit', () => {
    const tasks = [
      task('task_1', { integrated: true, integratedSha: 'sha_1' }),
      task('task_2', { integrated: true, integratedSha: 'sha_2' }),
      task('task_3', { dependsOn: ['task_2'], basePolicy: 'integration' }),
    ]
    expect(nextIntegrationStep(tasks)).toEqual({
      action: 'merge',
      taskId: 'task_3',
      fromIntegrationSha: 'sha_2',
    })
  })

  it('omits fromIntegrationSha for the first merge, which starts from the pinned base', () => {
    expect(nextIntegrationStep([task('task_1')])).toEqual({ action: 'merge', taskId: 'task_1' })
  })

  it('is done when every accepted task is integrated', () => {
    const tasks = [
      task('task_1', { integrated: true, integratedSha: 'sha_1' }),
      task('task_2', { integrated: true, integratedSha: 'sha_2' }),
    ]
    expect(nextIntegrationStep(tasks)).toEqual({ action: 'done' })
  })

  it('is done when no task is accepted and when the queue is empty', () => {
    expect(nextIntegrationStep([task('task_pending', { accepted: false })])).toEqual({ action: 'done' })
    expect(nextIntegrationStep([])).toEqual({ action: 'done' })
  })
})
