import { describe, expect, it } from 'vitest'
import { canApprove, describeApproval, liveStreams } from '../src/release-cards'

describe('canApprove: a card with no evidence on screen cannot be approved', () => {
  it('holds while the evidence is loading or failed to load', () => {
    expect(canApprove(null)).toBe(false)
  })

  it('opens once the server has answered, including that a card has no detail', () => {
    expect(canApprove({ absent: true } as never)).toBe(true)
    expect(canApprove({ what: 'Push' } as never)).toBe(true)
  })
})

describe('describeApproval: the toast says what happened, never more', () => {
  it('a merged card says merged', () => {
    expect(describeApproval({ status: 'approved', merged: true })).toMatchObject({
      closes: true,
      note: 'Merged on GitHub',
    })
  })

  it('an opened PR names its number', () => {
    expect(describeApproval({ status: 'approved', prNumber: 12 }).toast).toContain('#12')
  })

  it('a push names what happened', () => {
    expect(describeApproval({ status: 'approved', pushed: true }).note).toBe('Pushed')
  })

  it.each(['ci_pending', 'ci_failed', 'ci_unreadable', 'behind', 'blocked', 'dirty', 'draft'])(
    'a card held by %s stays open and never claims approval',
    (reason) => {
      const shown = describeApproval({ status: 'pending', reason })
      expect(shown.closes).toBe(false)
      expect(shown.toast.toLowerCase()).not.toContain('approved')
      expect(shown.toast.toLowerCase()).toContain('stays open')
    },
  )

  it('ci_pending and behind each say what to wait for', () => {
    expect(describeApproval({ status: 'pending', reason: 'ci_pending' }).toast).toContain('still running')
    expect(describeApproval({ status: 'pending', reason: 'behind' }).toast).toContain('behind')
  })

  it('an unknown hold still stays open, and names the reason', () => {
    const shown = describeApproval({ status: 'pending', reason: 'something_new' })
    expect(shown.closes).toBe(false)
    expect(shown.toast).toContain('something_new')
  })

  it('gh_merge_failed says the card is spent and nothing merged', () => {
    const shown = describeApproval({ status: 'approved', merged: false, reason: 'gh_merge_failed' })
    expect(shown.closes).toBe(true)
    expect(shown.toast).toContain('did not merge')
    expect(shown.toast).toContain('new card')
    expect(shown.note).not.toBe('Approved')
  })

  it('an unconfirmed merge is not reported as merged', () => {
    const shown = describeApproval({
      status: 'approved',
      merged: false,
      reason: 'merge unconfirmed by GitHub',
    })
    expect(shown.note).not.toContain('Merged')
    expect(shown.toast).toContain('not confirm')
  })

  it('a failed push or PR shows the failure', () => {
    const shown = describeApproval({ status: 'approved', pushed: false, error: 'rejected: non-fast-forward' })
    expect(shown.closes).toBe(true)
    expect(shown.toast).toContain('rejected: non-fast-forward')
    expect(shown.note).not.toBe('Approved')
  })

  it('a stale card says nothing ran', () => {
    const shown = describeApproval({ status: 'stale', reason: 'stale_head' })
    expect(shown.closes).toBe(true)
    expect(shown.toast).toContain('Nothing ran')
  })

  it('an expired answer says nothing ran', () => {
    expect(describeApproval({ status: 'expired' }).toast).toContain('Nothing ran')
  })

  it('a card with no external action keeps the agent wording', () => {
    expect(describeApproval({ status: 'approved' })).toEqual({
      closes: true,
      kind: 'approved',
      note: 'Approved',
      toast: 'Approved — the agent was told to continue.',
    })
  })
})

describe('liveStreams', () => {
  it('subscribes the fixed inbox stream beside the work and slot streams', () => {
    expect(liveStreams([{ id: 'wi_1' }], [{ label: 'max-1' }])).toEqual([
      'work:wi_1',
      'slot:max-1',
      'repositories',
      'wizard',
      'inbox',
    ])
  })
})
