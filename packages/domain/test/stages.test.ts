import { describe, expect, it } from 'vitest'
import type { WorkItemView } from '../src'
import { STAGE_TABLE, stageOf } from '../src'

/** The neutral view: no hold, no question, mid-execution, no PR — the 'working' base. */
const view = (overrides: Partial<WorkItemView> = {}): WorkItemView => ({
  state: 'executing',
  openQuestions: 0,
  awaitingConfirmation: false,
  holdStatus: 'free',
  integratedAll: false,
  prState: 'none',
  ...overrides,
})

// One fixture per row, in table order. Fixture i matches row i and no row before it,
// which is what the exhaustiveness test below asserts mechanically.
const fixtures: readonly WorkItemView[] = [
  view({ holdStatus: 'held' }),
  view({ openQuestions: 2 }),
  view({ awaitingConfirmation: true }),
  view({ state: 'blocked', blockedReason: 'confirmation' }),
  view({ state: 'blocked', blockedReason: 'dependency' }),
  view({ state: 'integrating', integratedAll: true }),
  view({ prState: 'ci_green' }),
  view({ prState: 'pr_open' }),
  view(),
  view({ state: 'planning' }),
  view({ state: 'done' }),
  view({ state: 'stopped' }),
]

describe('STAGE_TABLE', () => {
  it('matches the reviewed order of stages', () => {
    expect(STAGE_TABLE.map((row) => row.stage)).toEqual([
      'waiting on you (held)',
      'waiting on you (question)',
      'waiting on you (confirmation)',
      'waiting on you (confirmation)',
      'blocked',
      'awaiting merge',
      'ready to merge',
      'PR open',
      'working',
      'planning',
      'done',
      'stopped',
    ])
  })

  it.each(fixtures.map((w, i) => [STAGE_TABLE[i]?.stage ?? `row ${i}`, w, i] as const))(
    'row %s: first match wins',
    (stage, w) => {
      expect(stageOf(w)).toBe(stage)
    },
  )

  it('every row is reachable and no fixture matches an earlier row', () => {
    fixtures.forEach((w, i) => {
      for (let j = 0; j < i; j++) {
        expect(STAGE_TABLE[j]?.match(w), `row ${j} should not match fixture ${i}`).toBe(false)
      }
      expect(STAGE_TABLE[i]?.match(w), `row ${i} should match its fixture`).toBe(true)
      expect(stageOf(w)).toBe(STAGE_TABLE[i]?.stage)
    })
  })
})

describe('stageOf', () => {
  it('falls back to unknown when no row matches', () => {
    expect(stageOf(view({ state: 'reviewing' }))).toBe('unknown')
  })

  it('held outranks questions, confirmations and blocked', () => {
    expect(
      stageOf(view({ state: 'blocked', blockedReason: 'quota', openQuestions: 1, holdStatus: 'held' })),
    ).toBe('waiting on you (held)')
  })

  it('an open question outranks a pending confirmation', () => {
    expect(stageOf(view({ openQuestions: 1, awaitingConfirmation: true }))).toBe('waiting on you (question)')
  })

  it('blocked (other reason) outranks a green PR', () => {
    expect(stageOf(view({ state: 'blocked', blockedReason: 'auth', prState: 'ci_green' }))).toBe('blocked')
  })

  it('a fully integrated item is awaiting merge even when CI is green', () => {
    expect(stageOf(view({ state: 'integrating', integratedAll: true, prState: 'ci_green' }))).toBe(
      'awaiting merge',
    )
  })

  it('an open PR outranks an executing state', () => {
    expect(stageOf(view({ prState: 'pr_open' }))).toBe('PR open')
  })

  it('ci_pending is also an open PR, not ready to merge', () => {
    expect(stageOf(view({ prState: 'ci_pending' }))).toBe('PR open')
  })

  it('integrating with tasks outstanding and no PR is unknown to the table', () => {
    expect(stageOf(view({ state: 'integrating' }))).toBe('unknown')
  })
})
