import type { Store, StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS, stageOf, workViewOf } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import { plannerContextFromStore } from '../src'

/** One stage everywhere (§10): the planner reads the projector, never a stored `doc.stage`. */

const AT = '2026-11-05T12:00:00.000Z'

const context = (store: Store) =>
  plannerContextFromStore(store, {
    turn: { wake: 'user message' } as never,
    policyText: '{"preAuthorised":{}}',
    caps: DEFAULT_CAPS,
    now: () => AT,
  })

const stageIn = (store: Store): string | undefined => context(store).work[0]?.stage

const storeWith = (work: StoreDoc): Store => {
  const store = new MemoryRepositories() as unknown as Store
  store.workItems.save({ id: 'wi_1', state: 'executing', updatedAt: AT, ...work })
  return store
}

describe('planner context stage', () => {
  it('a stored stage or a raw state is not what the planner reads', () => {
    expect(stageIn(storeWith({ id: 'wi_1', stage: 'made up' }))).toBe('Working')
  })

  it('an open question is the same stage Work shows', () => {
    const store = storeWith({ id: 'wi_1' })
    store.engines.save({ id: 'question/q', status: 'open', workItemId: 'wi_1' })
    expect(stageIn(store)).toBe('Needs your answer')
  })

  it('a pending card joined by workItemId is the same stage Work shows', () => {
    const store = storeWith({ id: 'wi_1' })
    store.confirmations.save({
      id: 'conf_1',
      status: 'pending',
      workItemId: 'wi_1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
    expect(stageIn(store)).toBe('Needs your approval')
  })

  it('a pending card joined by mandate counts, and one that lapsed does not', () => {
    const store = storeWith({ id: 'wi_1', mandate: { id: 'm_1' } })
    store.confirmations.save({
      id: 'conf_1',
      status: 'pending',
      mandateId: 'm_1',
      expiresAt: '2020-01-01T00:00:00.000Z',
    })
    expect(stageIn(store)).toBe('Working')
    store.confirmations.save({
      id: 'conf_2',
      status: 'pending',
      mandateId: 'm_1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
    expect(stageIn(store)).toBe('Needs your approval')
  })

  it('a hold and a lifted hold read as Work reads them', () => {
    expect(stageIn(storeWith({ id: 'wi_1', hold: { at: AT } }))).toBe('Held by you')
    expect(stageIn(storeWith({ id: 'wi_1', hold: { at: AT, liftedAt: AT } }))).toBe('Working')
  })

  it('a declined push reads as Work reads it, not Working', () => {
    const store = storeWith({ id: 'wi_1', state: 'integrating' })
    store.engines.save({ id: 'delivery/wi_1', stage: 'declined', pushCardId: 'conf_1', answer: 'denied' })
    expect(stageIn(store)).toBe('Push declined')
  })

  it('a branch that changed on GitHub reads as Work reads it, not Working (owner, 9 November 2026)', () => {
    const store = storeWith({ id: 'wi_1', state: 'integrating' })
    store.engines.save({ id: 'delivery/wi_1', stage: 'pr_open', headMoved: { sha: 'c'.repeat(40) } })
    expect(stageIn(store)).toBe('Branch changed on GitHub')
  })

  it('checks GitHub has not finished read as a wait on GitHub, not Working', () => {
    const store = storeWith({ id: 'wi_1', state: 'integrating' })
    store.engines.save({ id: 'delivery/wi_1', stage: 'pr_open', ci: 'ci_pending' })
    expect(stageIn(store)).toBe('Waiting for GitHub checks')
  })

  it('every attempt on quota is the quota stage', () => {
    const store = storeWith({ id: 'wi_1' })
    store.attempts.save({ id: 'att_1', workItemId: 'wi_1', state: 'quota_wait' })
    expect(stageIn(store)).toContain('Waiting for quota')
  })
})

describe('workViewOf', () => {
  const facts = { openQuestions: 0, awaitingConfirmation: false, attempts: [], merged: false }

  it('an absent state reads admitted and a live attempt not on quota is no quota wait', () => {
    const view = workViewOf({}, { ...facts, attempts: [{ state: 'quota_wait' }, { state: 'running' }] })
    expect(view).toMatchObject({ state: 'admitted', holdStatus: 'free' })
    expect(view.quotaWait).toBeUndefined()
  })

  it('the earliest reset is the one shown', () => {
    const later = new Date(2026, 10, 5, 18, 0).toISOString()
    const sooner = new Date(2026, 10, 5, 16, 30).toISOString()
    const view = workViewOf(
      {},
      {
        ...facts,
        attempts: [
          { state: 'quota_wait', resetsAt: later },
          { state: 'quota_wait', resetAt: sooner },
        ],
      },
    )
    expect(stageOf(view).label).toBe('Waiting for quota (resets 16:30)')
  })
})
