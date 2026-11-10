import { describe, expect, it } from 'vitest'
import type { WorkItemView } from '../src'
import { deliveryStopped, deliveryWaiting, plannerTurnEnded, STAGE_TABLE, stageOf, workViewOf } from '../src'

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
  view({ deliveryStopped: { step: 'push', outcome: 'declined' } }),
  view({ branchMoved: '63865a9' }),
  view({ hostRunUnagreed: true }),
  view({ quotaWait: { resetAt: '2026-11-05T14:05:00.000Z' } }),
  view({ checksWaiting: { queued: true, since: '2026-11-05T14:02:00.000Z' } }),
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
      'person/blocked',
      'person/branch-moved',
      'person/agreement',
      'waiting/quota',
      'waiting/checks',
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

describe('a delivery whose card was declined or whose step failed (walkthrough, 9 November 2026)', () => {
  const facts = { openQuestions: 0, awaitingConfirmation: false, attempts: [], merged: false }
  const declinedPush = { stage: 'declined', pushCardId: 'conf_1', answer: 'denied' }

  it('reads what stopped it, waiting on you, never Working', () => {
    const stage = stageOf(
      workViewOf({ state: 'integrating' }, { ...facts, deliveryStopped: deliveryStopped(declinedPush) }),
    )
    expect(stage).toEqual({ key: 'person/blocked', label: 'Push declined', waitingOn: 'person' })
  })

  it('names the step and how it stopped', () => {
    const label = (record: Record<string, unknown>) =>
      stageOf(workViewOf({ state: 'integrating' }, { ...facts, deliveryStopped: deliveryStopped(record) }))
        .label
    expect(label({ stage: 'failed', error: 'remote hung up' })).toBe('Push failed')
    expect(label({ stage: 'declined', prCardId: 'conf_2', answer: 'denied' })).toBe('Pull request declined')
    expect(label({ stage: 'failed', prCardId: 'conf_2', error: 'no token' })).toBe('Pull request failed')
  })

  it('any other delivery stage is no stop', () => {
    for (const stage of ['local_complete', 'push_card', 'pushed', 'pr_card', 'pr_open', 'ready']) {
      expect(deliveryStopped({ stage })).toBeUndefined()
    }
    expect(deliveryStopped(undefined)).toBeUndefined()
  })

  it('work running after the decline reads as Working, and Push declined comes back when it stops', () => {
    const stopped = deliveryStopped(declinedPush)
    const at = (more: Partial<Parameters<typeof workViewOf>[1]>) =>
      stageOf(workViewOf({ state: 'integrating' }, { ...facts, deliveryStopped: stopped, ...more }))
    // The 9 November walkthrough: a fix task ran for minutes under "Push declined".
    expect(at({ attempts: [{ state: 'running' }] })).toMatchObject({ key: 'working', label: 'Working' })
    expect(at({ attempts: [{ state: 'queued' }] }).key).toBe('working')
    // A task ready for a slot is work under way too, with no attempt yet.
    expect(at({ tasksOpen: true }).key).toBe('working')
    expect(at({ attempts: [{ state: 'quota_wait' }] }).key).toBe('waiting/quota')
    expect(at({ attempts: [{ state: 'succeeded' }], tasksOpen: false }).label).toBe('Push declined')
  })

  it('a hold outranks it, and an ended item shows its outcome', () => {
    const stopped = deliveryStopped(declinedPush)
    const held = workViewOf(
      { state: 'integrating', hold: { at: '2026-11-09T09:00:00.000Z' } },
      { ...facts, deliveryStopped: stopped },
    )
    expect(stageOf(held).key).toBe('held')
    expect(stageOf(workViewOf({ state: 'stopped' }, { ...facts, deliveryStopped: stopped })).key).toBe(
      'ended/stopped',
    )
  })
})

describe('a planner turn that ended with no plan (§10: `waiting`, the turn ended with nothing pending)', () => {
  const AT = '2026-11-05T12:00:00.000Z'
  const LATER = '2026-11-05T12:05:00.000Z'
  const ack = { routing: 'new_work', ackText: 'Answered.', updatedAt: AT }

  it('has ended when its last message has a receipt and nothing came after', () => {
    expect(plannerTurnEnded([ack], [])).toBe(true)
  })

  it('has not ended without a message, or with one still in its turn', () => {
    expect(plannerTurnEnded([], [])).toBe(false)
    expect(plannerTurnEnded([ack, { routing: 'new_work', updatedAt: LATER }], [])).toBe(false)
  })

  it('an attached follow-up may start a turn, so it is not an end', () => {
    expect(plannerTurnEnded([{ routing: 'attach', ackText: 'Noted.', updatedAt: AT }], [])).toBe(false)
  })

  it('an answer after the last turn has a wake on its way', () => {
    expect(plannerTurnEnded([ack], [{ status: 'answered', answeredAt: LATER }])).toBe(false)
    expect(plannerTurnEnded([{ ...ack, updatedAt: LATER }], [{ status: 'answered', answeredAt: AT }])).toBe(
      true,
    )
  })

  it('reads as idle only while planning', () => {
    const facts = { openQuestions: 0, awaitingConfirmation: false, attempts: [], merged: false }
    const stage = (state: string, turnEnded: boolean) =>
      stageOf(workViewOf({ state }, { ...facts, turnEnded })).key
    expect(stage('planning', true)).toBe('idle')
    expect(stage('planning', false)).toBe('working')
    expect(stage('executing', true)).toBe('working')
  })
})

describe('an open pull request that waits on GitHub, not on MEC (owner, 9 November 2026)', () => {
  const facts = { openQuestions: 0, awaitingConfirmation: false, attempts: [], merged: false }
  const stage = (record: Record<string, unknown>) =>
    stageOf(workViewOf({ state: 'integrating' }, { ...facts, ...deliveryWaiting(record) }))
  const local = (iso: string): string => {
    const at = new Date(iso)
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  }

  it('a branch that changed on GitHub waits on you, with the head it is on now', () => {
    const record = { stage: 'pr_open', headMoved: { sha: '63865a9'.padEnd(40, '0'), at: 'x' } }
    expect(deliveryWaiting(record)).toEqual({ branchMoved: '63865a9' })
    expect(stage(record)).toEqual({
      key: 'person/branch-moved',
      label: 'Branch changed on GitHub',
      waitingOn: 'person',
    })
  })

  it('a branch someone else pushed to says so in its stage (owner, 10 November 2026)', () => {
    const record = { stage: 'pr_open', headMoved: { sha: '63865a9'.padEnd(40, '0'), foreign: true } }
    expect(deliveryWaiting(record)).toEqual({ branchMoved: '63865a9', branchForeign: true })
    expect(stage(record)).toEqual({
      key: 'person/branch-moved',
      label: 'Someone else pushed to the branch',
      waitingOn: 'person',
    })
  })

  it('pending required checks read as a wait on GitHub, queued or running, and since when', () => {
    const since = '2026-11-05T14:02:00.000Z'
    const queued = { stage: 'pr_open', ci: 'ci_pending', ciSince: since, ciQueued: true }
    expect(stage(queued)).toEqual({
      key: 'waiting/checks',
      label: `Waiting for GitHub checks (queued since ${local(since)})`,
      waitingOn: 'system',
    })
    expect(stage({ ...queued, ciQueued: false }).label).toBe(
      `Waiting for GitHub checks (running since ${local(since)})`,
    )
    expect(stage({ stage: 'pr_open', ci: 'ci_pending' }).label).toBe('Waiting for GitHub checks')
  })

  it('nothing else is a wait on GitHub: failing, green, unread, or another stage', () => {
    for (const record of [
      { stage: 'pr_open', ci: 'ci_failed' },
      { stage: 'pr_open' },
      { stage: 'ready', ci: 'green' },
      { stage: 'push_card', ci: 'ci_pending' },
      { stage: 'local_complete', headMoved: { sha: 'a'.repeat(40) } },
    ]) {
      expect(deliveryWaiting(record)).toEqual({})
    }
    expect(deliveryWaiting(undefined)).toEqual({})
  })

  it('a moved branch outranks its checks: they no longer speak for the head MEC pushed', () => {
    const record = { stage: 'pr_open', ci: 'ci_pending', headMoved: { sha: 'b'.repeat(40) } }
    expect(deliveryWaiting(record)).toEqual({ branchMoved: 'bbbbbbb' })
  })
})
