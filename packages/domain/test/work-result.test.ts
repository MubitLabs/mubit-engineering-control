import { describe, expect, it } from 'vitest'
import { type WorkResultInput, workResult } from '../src'

const HEAD = 'c'.repeat(40)

const integrated = (id: string) => ({ id, status: 'integrated', sha: HEAD })

const input = (over: Partial<WorkResultInput> = {}): WorkResultInput => ({
  tasks: [integrated('a'), integrated('b')],
  head: HEAD,
  combined: { sha: HEAD, passed: true, checks: [{ name: 'unit', status: 'passed' }] },
  findings: [],
  ...over,
})

describe('workResult (§15 definition of done)', () => {
  it('every required task integrated and combined checks on the head is complete', () => {
    expect(workResult(input())).toMatchObject({ complete: true, head: HEAD, remaining: [] })
  })

  it('accepted subset is not complete', () => {
    const result = workResult(input({ tasks: [integrated('a'), { id: 'b', status: 'accepted' }] }))
    expect(result.complete).toBe(false)
    expect(result.remaining).toEqual(['b is accepted, not integrated'])
  })

  it('missing required task prevents success', () => {
    const result = workResult(input({ tasks: [integrated('a'), { id: 'b', status: 'blocked' }] }))
    expect(result.complete).toBe(false)
    expect(result.remaining[0]).toContain('b')
  })

  it('excluded task needs a reason', () => {
    const bare = workResult(input({ tasks: [integrated('a'), { id: 'b', status: 'cancelled' }] }))
    expect(bare.complete).toBe(false)
    const reasoned = workResult(
      input({ tasks: [integrated('a'), { id: 'b', status: 'cancelled', excludedReason: 'superseded' }] }),
    )
    expect(reasoned.complete).toBe(true)
    expect(reasoned.excluded).toEqual([{ id: 'b', reason: 'superseded' }])
  })

  it('nothing accepted is not complete', () => {
    expect(workResult(input({ tasks: [] })).complete).toBe(false)
    const allExcluded = [{ id: 'a', status: 'cancelled', excludedReason: 'already done' }]
    expect(workResult(input({ tasks: allExcluded })).complete).toBe(false)
  })

  it('combined checks on another head are not checks on this one', () => {
    const stale = { sha: 'd'.repeat(40), passed: true, checks: [] }
    expect(workResult(input({ combined: stale })).complete).toBe(false)
  })

  it('failing or absent combined checks are not complete', () => {
    const red = { sha: HEAD, passed: false, checks: [{ name: 'unit', status: 'failed' }] }
    expect(workResult(input({ combined: red })).complete).toBe(false)
    const { combined: _combined, ...none } = input()
    expect(workResult(none).complete).toBe(false)
  })

  it('an undispositioned finding is not complete, a dispositioned one is', () => {
    expect(workResult(input({ findings: [{ text: 'x' }] })).complete).toBe(false)
    expect(workResult(input({ findings: [{ text: 'x', disposition: 'declined' }] })).complete).toBe(true)
  })
})
