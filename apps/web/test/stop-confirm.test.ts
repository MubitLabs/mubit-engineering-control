import { describe, expect, it } from 'vitest'
import { ARM_WINDOW_MS, armedNote, LAPSED_NOTE } from '../src/next/Decision'
import { stopInView, type WorkAction } from '../src/next/work-model'

/** The pure halves of the stop confirm: the clicks themselves are in work-live.screens.playwright.ts. */

const stop: WorkAction = {
  kind: 'stop',
  label: 'Stop in sample-console',
  workItemId: 'work_a',
  repoId: 'repo_a',
}

describe('the stop being confirmed', () => {
  it('stays with its own delivery, whichever group the row is filed under', () => {
    expect(stopInView(stop, 'work_a')).toBe(stop)
  })

  it('is never inherited by another selection, or by none', () => {
    expect(stopInView(stop, 'work_b')).toBeNull()
    expect(stopInView(stop, null)).toBeNull()
    expect(stopInView(null, 'work_a')).toBeNull()
  })
})

describe('the armed note', () => {
  it('names what is armed while it is', () => {
    expect(armedNote('Confirm: stop this delivery in sample-console', true)).toBe(
      'Armed: Confirm: stop this delivery in sample-console. Escape or any other action cancels.',
    )
  })

  it('says a confirm lapsed, so the press after it does not read as a dead button', () => {
    expect(armedNote(null, true)).toBe(LAPSED_NOTE)
    expect(LAPSED_NOTE).toBe('Not done: the confirm lapsed after 8 seconds. Press it again to arm.')
    expect(ARM_WINDOW_MS).toBe(8000)
  })

  it('is empty at rest and after a cancel the owner made', () => {
    expect(armedNote(null, false)).toBe('')
    expect(armedNote(undefined, false)).toBe('')
  })
})
