import { describe, expect, it } from 'vitest'
import type { ParkedAttempt } from '../src'
import { planFailover } from '../src'

const NOW = '2026-11-03T18:40:00Z'

const parked = (slotId: string, over: Partial<ParkedAttempt> = {}): ParkedAttempt => ({
  attemptId: 'a1',
  taskId: 't1',
  workItemId: 'w1',
  slotId,
  parkState: 'quota_wait',
  generation: 1,
  worktree: '/worktrees/t1',
  openQuestions: 0,
  holds: 0,
  ...over,
})

const plan = (over: Partial<Parameters<typeof planFailover>[0]> = {}) =>
  planFailover({
    parked: [],
    pairings: [],
    healthySlots: [],
    resetsKnown: {},
    now: NOW,
    ...over,
  })

describe('planFailover', () => {
  it('switches on an auto pairing with a healthy target and records the handoff', () => {
    const attempt = parked('max-1', { openQuestions: 2, holds: 1 })
    const r = plan({
      parked: [attempt],
      pairings: [{ from: 'max-1', to: 'max-2', auto: true }],
      healthySlots: ['max-2'],
    })
    expect(r).toEqual([
      {
        attempt,
        action: 'switch',
        targetSlot: 'max-2',
        handoff: {
          fromSlot: 'max-1',
          toSlot: 'max-2',
          reason: 'quota_wait',
          at: NOW,
          pack: {
            worktree: '/worktrees/t1',
            plan: 'in_pack',
            diffSoFar: 'in_pack',
            transcriptSummary: 'in_pack',
            openQuestions: 2,
            holds: 1,
          },
        },
      },
    ])
  })

  it('waits when the auto-paired target is not healthy', () => {
    const r = plan({
      parked: [parked('max-1')],
      pairings: [{ from: 'max-1', to: 'max-2', auto: true }],
      healthySlots: ['glm-1'],
    })
    expect(r).toEqual([
      {
        attempt: parked('max-1'),
        action: 'wait',
        handoff: {
          fromSlot: 'max-1',
          reason: 'quota_wait: paired target not healthy',
          at: NOW,
          pack: {
            worktree: '/worktrees/t1',
            plan: 'in_pack',
            diffSoFar: 'in_pack',
            transcriptSummary: 'in_pack',
            openQuestions: 0,
            holds: 0,
          },
        },
      },
    ])
  })

  it('waits on an explicit-only pairing — the user clicks, no silent switch', () => {
    const r = plan({
      parked: [parked('max-1', { parkState: 'provider_down' })],
      pairings: [{ from: 'max-1', to: 'max-2', auto: false }],
      healthySlots: ['max-2'],
    })
    expect(r[0]?.action).toBe('wait')
    expect(r[0]?.targetSlot).toBeUndefined()
    expect(r[0]?.handoff.toSlot).toBeUndefined()
    expect(r[0]?.handoff.reason).toBe('provider_down: explicit pairing, the user switches')
  })

  it('resumes the same slot when a quota reset is known', () => {
    const r = plan({
      parked: [parked('max-1', { openQuestions: 3, holds: 4 })],
      resetsKnown: { 'max-1': true },
    })
    expect(r).toEqual([
      {
        attempt: parked('max-1', { openQuestions: 3, holds: 4 }),
        action: 'resume_same_slot',
        handoff: {
          fromSlot: 'max-1',
          reason: 'quota_wait: known reset lifts the park',
          at: NOW,
          pack: {
            worktree: '/worktrees/t1',
            plan: 'in_pack',
            diffSoFar: 'in_pack',
            transcriptSummary: 'in_pack',
            openQuestions: 3,
            holds: 4,
          },
        },
      },
    ])
  })

  it('waits on a quota park with an unknown reset and no pairing', () => {
    const r = plan({ parked: [parked('max-1', { attemptId: 'a9' })] })
    expect(r[0]?.action).toBe('wait')
    expect(r[0]?.handoff.reason).toBe('quota_wait: reset unknown')
    expect(r[0]?.handoff.fromSlot).toBe('max-1')
  })

  it('waits on auth even when an auto pairing is healthy — only a same-slot re-login resumes', () => {
    const r = plan({
      parked: [parked('max-1', { parkState: 'auth_required' })],
      pairings: [{ from: 'max-1', to: 'max-2', auto: true }],
      healthySlots: ['max-2'],
    })
    expect(r[0]?.action).toBe('wait')
    expect(r[0]?.targetSlot).toBeUndefined()
    expect(r[0]?.handoff.toSlot).toBeUndefined()
    expect(r[0]?.handoff.reason).toBe('auth_required: only a same-slot re-login resumes')
  })

  it('switches provider_down on an auto pairing with a healthy target', () => {
    const r = plan({
      parked: [parked('glm-1', { parkState: 'provider_down' })],
      pairings: [{ from: 'glm-1', to: 'gemini-1', auto: true }],
      healthySlots: ['gemini-1'],
    })
    expect(r[0]?.action).toBe('switch')
    expect(r[0]?.targetSlot).toBe('gemini-1')
    expect(r[0]?.handoff).toEqual({
      fromSlot: 'glm-1',
      toSlot: 'gemini-1',
      reason: 'provider_down',
      at: NOW,
      pack: {
        worktree: '/worktrees/t1',
        plan: 'in_pack',
        diffSoFar: 'in_pack',
        transcriptSummary: 'in_pack',
        openQuestions: 0,
        holds: 0,
      },
    })
  })

  it('waits on provider_down with no pairing', () => {
    const r = plan({ parked: [parked('glm-1', { parkState: 'provider_down' })] })
    expect(r[0]?.action).toBe('wait')
    expect(r[0]?.handoff.reason).toBe('provider_down: no pairing')
  })

  it('lets an opted-in auto pairing beat waiting out a known reset', () => {
    const r = plan({
      parked: [parked('max-1')],
      pairings: [{ from: 'max-1', to: 'max-2', auto: true }],
      healthySlots: ['max-2'],
      resetsKnown: { 'max-1': true },
    })
    expect(r[0]?.action).toBe('switch')
    expect(r[0]?.targetSlot).toBe('max-2')
  })

  it('still lifts a quota park at a known reset under an un-clicked explicit pairing', () => {
    const r = plan({
      parked: [parked('max-1')],
      pairings: [{ from: 'max-1', to: 'max-2', auto: false }],
      healthySlots: ['max-2'],
      resetsKnown: { 'max-1': true },
    })
    expect(r[0]?.action).toBe('resume_same_slot')
  })

  it('records one handoff per parked work item, each carrying its own pack counts', () => {
    const a1 = parked('max-1', { attemptId: 'a1', taskId: 't1', workItemId: 'w1', openQuestions: 1 })
    const a2 = parked('max-1', {
      attemptId: 'a2',
      taskId: 't2',
      workItemId: 'w2',
      parkState: 'provider_down',
      worktree: '/worktrees/t2',
      holds: 2,
    })
    const r = plan({
      parked: [a1, a2],
      pairings: [{ from: 'max-1', to: 'max-2', auto: true }],
      healthySlots: ['max-2'],
    })
    expect(r.map((p) => [p.attempt.attemptId, p.action, p.targetSlot])).toEqual([
      ['a1', 'switch', 'max-2'],
      ['a2', 'switch', 'max-2'],
    ])
    expect(r.map((p) => p.handoff.pack)).toEqual([
      {
        worktree: '/worktrees/t1',
        plan: 'in_pack',
        diffSoFar: 'in_pack',
        transcriptSummary: 'in_pack',
        openQuestions: 1,
        holds: 0,
      },
      {
        worktree: '/worktrees/t2',
        plan: 'in_pack',
        diffSoFar: 'in_pack',
        transcriptSummary: 'in_pack',
        openQuestions: 0,
        holds: 2,
      },
    ])
    expect(r.every((p) => p.handoff.fromSlot === 'max-1' && p.handoff.at === NOW)).toBe(true)
  })
})
