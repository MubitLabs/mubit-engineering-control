import { describe, expect, it } from 'vitest'
import type { PrEvent, PrState } from '../src'
import { prTransition } from '../src'

const legal: readonly (readonly [PrState, PrEvent, PrState])[] = [
  ['idle', 'integration_complete', 'ready_for_pr'],
  ['ready_for_pr', 'pr_created', 'pr_open'],
  ['pr_open', 'ci_passed', 'ci_green'],
  ['pr_open', 'ci_failed', 'ci_pending'],
  ['ci_pending', 'ci_passed', 'ci_green'],
  ['ci_green', 'merged_on_github', 'merged'],
  ['pr_open', 'pr_closed', 'closed'],
  ['ci_pending', 'pr_closed', 'closed'],
  ['ci_green', 'pr_closed', 'closed'],
  // §14: a closed PR returns the delivery to integrating.
  ['closed', 'integration_complete', 'ready_for_pr'],
  // §14: target-branch movement re-runs the required checks.
  ['ci_green', 'target_moved', 'ci_pending'],
]

describe.each(legal)('%s --%s--> %s', (from, event, to) => {
  it('is legal', () => {
    expect(prTransition(from, event)).toBe(to)
  })
})

const illegal: readonly (readonly [PrState, PrEvent])[] = [
  ['idle', 'pr_created'],
  ['ready_for_pr', 'ci_passed'],
  // §14: only GitHub confirms a merge, and only from green checks.
  ['pr_open', 'merged_on_github'],
  ['ci_pending', 'merged_on_github'],
  ['ci_green', 'ci_failed'],
  ['merged', 'pr_closed'],
]

describe.each(illegal)('%s --%s--> throws', (from, event) => {
  it('is invalid', () => {
    expect(() => prTransition(from, event)).toThrowError(
      new Error(`invalid pr transition ${from} --${event}-->`),
    )
  })
})

it('delivers: integration completes, the PR opens, CI passes, GitHub confirms the merge', () => {
  let state: PrState = 'idle'
  state = prTransition(state, 'integration_complete')
  state = prTransition(state, 'pr_created')
  state = prTransition(state, 'ci_passed')
  state = prTransition(state, 'merged_on_github')
  expect(state).toBe('merged')
})

it('greens again after a CI failure passes on re-run', () => {
  let state: PrState = prTransition('pr_open', 'ci_failed')
  expect(state).toBe('ci_pending')
  state = prTransition(state, 'ci_passed')
  expect(state).toBe('ci_green')
})

it('re-runs checks when the target branch moves under a green PR', () => {
  let state: PrState = prTransition('pr_open', 'ci_passed')
  state = prTransition(state, 'target_moved')
  expect(state).toBe('ci_pending')
  state = prTransition(state, 'ci_passed')
  expect(state).toBe('ci_green')
})

it('returns a closed PR to integrating and onwards to a new PR', () => {
  let state: PrState = prTransition('pr_open', 'pr_closed')
  state = prTransition(state, 'integration_complete')
  state = prTransition(state, 'pr_created')
  expect(state).toBe('pr_open')
})
