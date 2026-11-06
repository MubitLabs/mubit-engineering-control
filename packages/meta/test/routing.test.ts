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

  it.each([
    'Why is it blocked?',
    'what is it doing',
    'The build looks odd. Is that expected',
    'how far along\nis it?',
    'Done yet?',
  ])('a question beside live work gets a turn (§12.1, owner ruling): %s', (text) => {
    expect(routeMessage({ liveWork: [work('wi-1')], text })).toEqual({ action: 'question' })
  })

  it.each(['By the way, the demo is Friday', 'Thanks', 'the logo is in the shared drive.'])(
    'a note beside live work stays context: %s',
    (text) => {
      expect(routeMessage({ liveWork: [work('wi-1')], text })).toEqual({ action: 'conversation' })
    },
  )

  it('a question that names live work still goes to that work', () => {
    expect(routeMessage({ referencesWorkItem: 'wi-1', liveWork: [work('wi-1')], text: 'Why?' })).toEqual({
      action: 'attach',
      workItemId: 'wi-1',
    })
  })

  it('a question with nothing live is new work, as any message is', () => {
    expect(routeMessage({ liveWork: [work('wi-1', true)], text: 'Why?' })).toEqual({ action: 'new_work' })
  })

  it('explicitNew starts new work with live work present', () => {
    expect(routeMessage({ explicitNew: true, liveWork: [work('wi-1')] })).toEqual({ action: 'new_work' })
  })

  it('explicitNew never overrides a stopped reference', () => {
    expect(
      routeMessage({ explicitNew: true, referencesWorkItem: 'wi-1', liveWork: [work('wi-1', true)] }),
    ).toEqual({ action: 'stopped_refused', workItemId: 'wi-1' })
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
