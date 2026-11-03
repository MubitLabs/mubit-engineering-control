import { describe, expect, it } from 'vitest'
import { handBack } from '../src'

describe('handBack (plan §12.3)', () => {
  it('hands back a message a live ticket owns, carrying the reason', () => {
    expect(
      handBack({
        messageId: 'm1',
        reason: 'Beyond my task: it changes the public API surface',
        alreadyHandedBack: [],
        ticketLive: true,
      }),
    ).toEqual({ action: 'hand_back', reason: 'Beyond my task: it changes the public API surface' })
  })

  it('refuses a second hand-back of the same message', () => {
    expect(
      handBack({
        messageId: 'm1',
        reason: 'Beyond my task',
        alreadyHandedBack: ['m0', 'm1'],
        ticketLive: true,
      }),
    ).toEqual({ action: 'refuse', reason: 'already handed back' })
  })

  it('refuses a hand-back from a ticket that is not live: not owned', () => {
    expect(
      handBack({
        messageId: 'm1',
        reason: 'Beyond my task',
        alreadyHandedBack: [],
        ticketLive: false,
      }),
    ).toEqual({ action: 'refuse', reason: 'not owned' })
  })

  it('once-only wins over ownership: an ended ticket re-handing a handed-back message is already handed back', () => {
    expect(
      handBack({
        messageId: 'm1',
        reason: 'Beyond my task',
        alreadyHandedBack: ['m1'],
        ticketLive: false,
      }),
    ).toEqual({ action: 'refuse', reason: 'already handed back' })
  })
})
