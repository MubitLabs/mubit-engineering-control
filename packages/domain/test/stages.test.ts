import { describe, expect, it } from 'vitest'
import type { WorkItemView } from '../src'
import { STAGE_TABLE, stageOf, workViewOf } from '../src'

/** The neutral view: open, mid-execution, no hold, no question, nothing reported. */
const view = (overrides: Partial<WorkItemView> = {}): WorkItemView => ({
  state: 'executing',
  openQuestions: 0,
  awaitingConfirmation: false,
  holdStatus: 'free',
  ...overrides,
})

// One fixture per row, in table order. Fixture i matches row i and no row before it,
// which the exhaustiveness test below asserts mechanically.
const fixtures: readonly WorkItemView[] = [
  view({ openQuestions: 1 }),
  view({ awaitingConfirmation: true }),
  view({ loginNeeded: 'sign-in' }),
  view({ loginNeeded: 'replace-key' }),
  view({ latestReport: 'ready' }),
  view({ latestReport: 'blocked' }),
  view({ latestReport: 'failed' }),
  view({ state: 'blocked' }),
  view({ holdStatus: 'held' }),
  view({ quotaWait: { resetAt: '2026-11-05T14:05:00.000Z' } }),
  view({ queued: true }),
  view({ latestReport: 'waiting' }),
  view(),
]

describe('STAGE_TABLE', () => {
  it('matches the spec order of stages (§10)', () => {
    expect(STAGE_TABLE.map((row) => row.key)).toEqual([
      'person/decision',
      'person/decision',
      'person/login',
      'person/login',
      'person/review',
      'person/blocked',
      'person/blocked',
      'person/blocked',
      'held',
      'waiting/quota',
      'working/queued',
      'idle',
      'working',
    ])
  })

  it('every row is reachable and no fixture matches an earlier row', () => {
    expect(fixtures).toHaveLength(STAGE_TABLE.length)
    fixtures.forEach((w, i) => {
      for (let j = 0; j < i; j++) {
        expect(STAGE_TABLE[j]?.match(w), `row ${j} should not match fixture ${i}`).toBe(false)
      }
      expect(STAGE_TABLE[i]?.match(w), `row ${i} should match its fixture`).toBe(true)
      expect(stageOf(w).key).toBe(STAGE_TABLE[i]?.key)
    })
  })

  it('says whom each stage waits for', () => {
    expect(stageOf(view({ openQuestions: 1 })).waitingOn).toBe('person')
    expect(stageOf(view({ holdStatus: 'held' })).waitingOn).toBe('person')
    expect(stageOf(view({ quotaWait: {} })).waitingOn).toBe('system')
    expect(stageOf(view({ queued: true })).waitingOn).toBe('system')
    expect(stageOf(view({ latestReport: 'waiting' })).waitingOn).toBe('none')
    expect(stageOf(view()).waitingOn).toBe('none')
  })
})

describe('stageOf', () => {
  it('a pending confirmation outranks a hold', () => {
    const stage = stageOf(view({ awaitingConfirmation: true, holdStatus: 'held' }))
    expect(stage.key).toBe('person/decision')
    expect(stage.label).toBe('Needs your approval')
  })

  it('an open question outranks a hold', () => {
    const stage = stageOf(view({ openQuestions: 2, holdStatus: 'held' }))
    expect(stage.key).toBe('person/decision')
    expect(stage.label).toBe('Needs your answer')
  })

  it('an open question is an answer even when a confirmation is also pending', () => {
    expect(stageOf(view({ openQuestions: 1, awaitingConfirmation: true })).label).toBe('Needs your answer')
  })

  it('a person stage outranks the hold, and the hold outranks quota and queue', () => {
    expect(stageOf(view({ holdStatus: 'held', quotaWait: {}, queued: true })).key).toBe('held')
    expect(stageOf(view({ holdStatus: 'held', latestReport: 'ready' })).key).toBe('person/review')
    expect(stageOf(view({ holdStatus: 'held', latestReport: 'blocked' })).key).toBe('person/blocked')
  })

  it('labels login, review and blocked as the spec words them', () => {
    expect(stageOf(view({ loginNeeded: 'sign-in' })).label).toBe('Sign in again')
    expect(stageOf(view({ loginNeeded: 'replace-key' })).label).toBe('Replace key')
    expect(stageOf(view({ latestReport: 'ready' })).label).toBe('Ready for review')
    expect(stageOf(view({ latestReport: 'blocked' })).label).toBe('Blocked')
    expect(stageOf(view({ latestReport: 'failed' })).label).toBe('Failed')
    expect(stageOf(view({ holdStatus: 'held' })).label).toBe('Held by you')
  })

  it('a blocked or failed report releases once a user message reached the item', () => {
    expect(stageOf(view({ latestReport: 'blocked', userMessageSinceReport: true })).key).toBe('working')
    expect(stageOf(view({ latestReport: 'failed', userMessageSinceReport: true })).key).toBe('working')
  })

  it('quota wait shows reset time or unknown', () => {
    const resetAt = new Date(2026, 10, 5, 14, 5, 0)
    expect(stageOf(view({ quotaWait: { resetAt: resetAt.toISOString() } })).label).toBe(
      'Waiting for quota (resets 14:05)',
    )
    expect(stageOf(view({ quotaWait: {} })).label).toBe('Waiting for quota (reset time unknown)')
    expect(stageOf(view({ quotaWait: { resetAt: 'not a time' } })).label).toBe(
      'Waiting for quota (reset time unknown)',
    )
  })

  it('everything else is Working', () => {
    for (const state of ['proposed', 'admitted', 'planning', 'executing', 'reviewing', 'integrating']) {
      const stage = stageOf(view({ state }))
      expect(stage).toEqual({ key: 'working', label: 'Working', waitingOn: 'none' })
    }
    expect(stageOf(view({ latestReport: 'progress' })).key).toBe('working')
    expect(stageOf(view({ latestReport: 'dropped' })).key).toBe('working')
  })

  it('a fact that is not recorded cannot match its row', () => {
    // No login, report, quota or queue facts at all: the item is Working, never a person stage.
    expect(
      stageOf({ state: 'executing', openQuestions: 0, awaitingConfirmation: false, holdStatus: 'free' }).key,
    ).toBe('working')
  })

  it('an ended item shows its outcome, not an open stage', () => {
    expect(stageOf(view({ state: 'done', merged: true }))).toEqual({
      key: 'ended/merged',
      label: 'Merged',
      waitingOn: 'none',
    })
    expect(stageOf(view({ state: 'done' })).label).toBe('Done')
    expect(stageOf(view({ state: 'stopped' }))).toEqual({
      key: 'ended/stopped',
      label: 'Stopped by you',
      waitingOn: 'none',
    })
    expect(stageOf(view({ state: 'dropped' })).label).toBe('Dropped')
    expect(stageOf(view({ state: 'closed' })).label).toBe('Closed')
    // Open facts on a finished item do not bring it back.
    expect(stageOf(view({ state: 'stopped', openQuestions: 3, holdStatus: 'held' })).key).toBe(
      'ended/stopped',
    )
  })
})

describe('a delivery ready for review (§10)', () => {
  const facts = { openQuestions: 0, awaitingConfirmation: false, attempts: [], merged: false }

  it('reads Ready for review on the row, though no worker reported ready', () => {
    const stage = stageOf(workViewOf({ state: 'executing' }, { ...facts, deliveryReady: true }))
    expect(stage).toEqual({ key: 'person/review', label: 'Ready for review', waitingOn: 'person' })
  })

  it('stays Working while the delivery is any other stage', () => {
    expect(stageOf(workViewOf({ state: 'executing' }, { ...facts, deliveryReady: false })).key).toBe(
      'working',
    )
    expect(stageOf(workViewOf({ state: 'executing' }, facts)).key).toBe('working')
  })

  it('an approval still outranks it, and a merged item shows its outcome', () => {
    const asked = workViewOf(
      { state: 'executing' },
      { ...facts, awaitingConfirmation: true, deliveryReady: true },
    )
    expect(stageOf(asked).label).toBe('Needs your approval')
    const merged = workViewOf({ state: 'done' }, { ...facts, merged: true, deliveryReady: true })
    expect(stageOf(merged).key).toBe('ended/merged')
  })
})
