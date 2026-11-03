import { describe, expect, it } from 'vitest'
import type { CandidateEvent } from '../src'
import { classifyWake } from '../src'

/** One row per CandidateEvent kind, both branches where they exist (plan §6). */
const cases: readonly [string, CandidateEvent, 'wake' | 'note' | 'ignore'][] = [
  ['user message without a reference', { kind: 'user_message', message: { id: 'm1' } }, 'wake'],
  [
    'user message with a reference',
    { kind: 'user_message', message: { id: 'm2', referencesWorkItem: 'wi-1' } },
    'wake',
  ],
  ['progress report', { kind: 'report', workItemId: 'wi-1', reportKind: 'progress' }, 'note'],
  ['waiting report', { kind: 'report', workItemId: 'wi-1', reportKind: 'waiting' }, 'note'],
  ['ready report', { kind: 'report', workItemId: 'wi-1', reportKind: 'ready' }, 'wake'],
  ['blocked report', { kind: 'report', workItemId: 'wi-1', reportKind: 'blocked' }, 'wake'],
  ['failed report', { kind: 'report', workItemId: 'wi-1', reportKind: 'failed' }, 'wake'],
  ['dropped report', { kind: 'report', workItemId: 'wi-1', reportKind: 'dropped' }, 'wake'],
  ['structured question', { kind: 'question', workItemId: 'wi-1' }, 'wake'],
  [
    'confirmation resolved by someone else',
    { kind: 'confirmation_resolved', confirmationId: 'c1', selfInitiated: false },
    'wake',
  ],
  [
    'confirmation the meta agent itself initiated',
    { kind: 'confirmation_resolved', confirmationId: 'c1', selfInitiated: true },
    'note',
  ],
  [
    'work parked with an automatic resolution',
    { kind: 'work_parked', workItemId: 'wi-1', autoResolvable: true },
    'note',
  ],
  [
    'work parked with no automatic resolution',
    { kind: 'work_parked', workItemId: 'wi-1', autoResolvable: false },
    'wake',
  ],
  ['integration conflict', { kind: 'integration_conflict', workItemId: 'wi-1' }, 'wake'],
  ['slot degraded affecting a live plan', { kind: 'slot_degraded', affectsLivePlan: true }, 'wake'],
  ['slot degraded without live-plan impact', { kind: 'slot_degraded', affectsLivePlan: false }, 'note'],
  ['timer the meta agent asked for', { kind: 'timer', metaAgentAskedFor: true }, 'wake'],
  ['timer nobody asked for', { kind: 'timer', metaAgentAskedFor: false }, 'ignore'],
  ['settings saved', { kind: 'settings_saved' }, 'note'],
  ['prompt saved', { kind: 'prompt_saved' }, 'note'],
  ['attempt started by the meta agent', { kind: 'attempt_started', by: 'self' }, 'note'],
  ['attempt started by someone else', { kind: 'attempt_started', by: 'other' }, 'note'],
]

describe.each(cases)('classifyWake: %s', (_name, event, expected) => {
  it(`returns ${expected}`, () => {
    expect(classifyWake(event)).toBe(expected)
  })
})
