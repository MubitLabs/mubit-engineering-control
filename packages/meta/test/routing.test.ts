import { describe, expect, it } from 'vitest'
import type { LiveWork } from '../src'
import { routeMessage } from '../src'

const work = (workItemId: string, stopped = false): LiveWork => ({
  workItemId,
  tasks: [{ taskId: `${workItemId}-t1`, status: 'active' }],
  openQuestions: [],
  stopped,
})

describe('routeMessage (plan §12.1)', () => {
  it('an explicit reference binds to the live item it names', () => {
    expect(routeMessage({ referencesWorkItem: 'wi-2', liveWork: [work('wi-1'), work('wi-2')] })).toEqual({
      action: 'attach',
      workItemId: 'wi-2',
    })
  })

  it('a reference to a stopped item is refused', () => {
    expect(
      routeMessage({ referencesWorkItem: 'wi-1', liveWork: [work('wi-1', true), work('wi-2')] }),
    ).toEqual({ action: 'stopped_refused', workItemId: 'wi-1' })
  })

  it('no reference with live work is conversation: context only, no authority', () => {
    expect(routeMessage({ liveWork: [work('wi-1')] })).toEqual({ action: 'conversation' })
  })

  it('no reference with nothing live is new work', () => {
    expect(routeMessage({ liveWork: [] })).toEqual({ action: 'new_work' })
  })

  it('no reference with only stopped items is new work — stopped is not live', () => {
    expect(routeMessage({ liveWork: [work('wi-1', true)] })).toEqual({ action: 'new_work' })
  })

  it('a reference that resolves to nothing does not bind and falls through', () => {
    expect(routeMessage({ referencesWorkItem: 'wi-gone', liveWork: [work('wi-1')] })).toEqual({
      action: 'conversation',
    })
    expect(routeMessage({ referencesWorkItem: 'wi-gone', liveWork: [] })).toEqual({
      action: 'new_work',
    })
  })
})
