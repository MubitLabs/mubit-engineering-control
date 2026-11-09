// Owner decision #66 (9 November 2026, "A"): where a task's fresh worktree starts. Pure, so every
// row of the rule runs here with no git; delivery-flow's journey proves it on a real repository.
import { describe, expect, it } from 'vitest'
import { taskBase } from '../src/attempt-launch'

const PINNED = 'p'.repeat(40)
const HEAD = 'h'.repeat(40)
const integrated = { head: HEAD, integrated: { task_1: HEAD } }

describe('taskBase', () => {
  it('a task with no dependencies starts from the integration head once a task is integrated', () => {
    expect(taskBase({ dependsOn: [], basePolicy: 'integration' }, PINNED, integrated, true)).toBe(HEAD)
    // Absent is `integration`, as everywhere else.
    expect(taskBase({ dependsOn: [] }, PINNED, integrated, true)).toBe(HEAD)
  })

  it('with nothing integrated yet it starts from the pinned base, as before', () => {
    expect(taskBase({ dependsOn: [] }, PINNED, undefined, true)).toBe(PINNED)
    expect(taskBase({ dependsOn: [] }, PINNED, { head: HEAD, integrated: {} }, true)).toBe(PINNED)
  })

  it('`contract` opts a truly independent task out: it starts from the pinned base', () => {
    expect(taskBase({ dependsOn: [], basePolicy: 'contract' }, PINNED, integrated, true)).toBe(PINNED)
  })

  it('a dependent keeps its rule: integration from the head, contract from the pin', () => {
    const waits = { dependsOn: ['task_1'] }
    expect(taskBase({ ...waits, basePolicy: 'integration' }, PINNED, integrated, true)).toBe(HEAD)
    expect(taskBase({ ...waits, basePolicy: 'contract' }, PINNED, integrated, true)).toBe(PINNED)
    expect(taskBase(waits, PINNED, { head: HEAD, integrated: {} }, false)).toBe(HEAD)
  })

  it('a continuation in an existing worktree keeps the rule its worktree was made under', () => {
    // A repair works on what its attempt left (§15): moving its base would misread its changes.
    expect(taskBase({ dependsOn: [] }, PINNED, integrated, false)).toBe(PINNED)
  })
})
