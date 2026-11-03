import { describe, expect, it } from 'vitest'
import { assertNoCrossSlotResume } from '../src'

describe('assertNoCrossSlotResume', () => {
  it('refuses a session resume aimed at a different slot', () => {
    expect(
      assertNoCrossSlotResume({
        originalSessionSlot: 'max-1',
        newAttemptSlot: 'max-2',
        resumeRequested: true,
      }),
    ).toEqual({ ok: false, reason: 'engine sessions are never resumed across slots' })
  })

  it('refuses a resume across engines on different slots', () => {
    expect(
      assertNoCrossSlotResume({
        originalSessionSlot: 'max-1',
        newAttemptSlot: 'glm-1',
        resumeRequested: true,
      }),
    ).toEqual({ ok: false, reason: 'engine sessions are never resumed across slots' })
  })

  it('allows a resume on the same slot', () => {
    expect(
      assertNoCrossSlotResume({
        originalSessionSlot: 'max-1',
        newAttemptSlot: 'max-1',
        resumeRequested: true,
      }),
    ).toEqual({ ok: true })
  })

  it('allows a new attempt on another slot when no session resume is requested', () => {
    expect(
      assertNoCrossSlotResume({
        originalSessionSlot: 'max-1',
        newAttemptSlot: 'glm-1',
        resumeRequested: false,
      }),
    ).toEqual({ ok: true })
  })
})
