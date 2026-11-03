import { describe, expect, it } from 'vitest'
import type { ActiveAttempt, Caps, SchedulableTask, SlotView } from '../src'
import { DEFAULT_CAPS, planDispatches } from '../src'

const task = (taskId: string, over: Partial<SchedulableTask> = {}): SchedulableTask => ({
  taskId,
  workItemId: 'w1',
  workItemPinned: false,
  readyAt: Number(taskId.replace(/\D/g, '')) || 1,
  generation: 1,
  role: 'implementer',
  ...over,
})

const slot = (id: string, over: Partial<SlotView> = {}): SlotView => ({
  id,
  state: 'healthy',
  pinnedRoles: [],
  inUse: 0,
  concurrency: 2,
  ...over,
})

const attempt = (taskId: string, slotId: string, workItemId = 'w1'): ActiveAttempt => ({
  taskId,
  slotId,
  workItemId,
})

const caps = (over: Partial<Caps> = {}): Caps => ({ ...DEFAULT_CAPS, ...over })

const plan = (over: Partial<Parameters<typeof planDispatches>[0]> = {}) =>
  planDispatches({
    ready: [],
    slots: [slot('s1', { concurrency: 8 })],
    active: [],
    caps: caps({ perSlot: 8 }),
    utilisationCeiling: 0.8,
    reservedWakeSlot: false,
    ...over,
  })

describe('planDispatches', () => {
  it('launches up to the global cap and defers the rest as capacity', () => {
    const r = plan({
      ready: [task('t1'), task('t2'), task('t3')],
      caps: caps({ globalActiveAttempts: 2, perWorkItem: 3 }),
    })
    expect(r.launches).toEqual([
      { taskId: 't1', slotId: 's1' },
      { taskId: 't2', slotId: 's1' },
    ])
    expect(r.deferred).toEqual([{ taskId: 't3', reason: 'capacity' }])
  })

  it('starts the deferred task once a slot frees up', () => {
    const r = plan({
      ready: [task('t3')],
      slots: [slot('s1', { concurrency: 8, inUse: 1 })],
      active: [attempt('t2', 's1')],
      caps: caps({ globalActiveAttempts: 2, perWorkItem: 3, perSlot: 8 }),
    })
    expect(r.launches).toEqual([{ taskId: 't3', slotId: 's1' }])
    expect(r.deferred).toEqual([])
  })

  it('skips a task that already has an active attempt', () => {
    const r = plan({ ready: [task('t1')], active: [attempt('t1', 's1')] })
    expect(r.launches).toEqual([])
    expect(r.deferred).toEqual([])
  })

  it('launches a repeatedly dispatched task exactly once', () => {
    const t1 = task('t1')
    const r = plan({ ready: [t1, t1, t1, t1, t1] })
    expect(r.launches).toEqual([{ taskId: 't1', slotId: 's1' }])
    expect(r.deferred).toEqual([])
  })

  it('defers with slot_unhealthy when the only slot is degraded', () => {
    const r = plan({ ready: [task('t1')], slots: [slot('s1', { state: 'degraded' })] })
    expect(r.launches).toEqual([])
    expect(r.deferred).toEqual([{ taskId: 't1', reason: 'slot_unhealthy' }])
  })

  it('launches on the healthy slot among degraded ones', () => {
    const r = plan({
      ready: [task('t1')],
      slots: [slot('s1', { state: 'degraded' }), slot('s2')],
    })
    expect(r.launches).toEqual([{ taskId: 't1', slotId: 's2' }])
    expect(r.deferred).toEqual([])
  })

  it('blocks new placements above the utilisation ceiling but leaves existing attempts alone', () => {
    const hot = slot('s1', { concurrency: 2, inUse: 1, usageUtilization: 0.9 })
    const r = plan({ ready: [task('t1')], slots: [hot], active: [attempt('a1', 's1')] })
    expect(r.launches).toEqual([])
    expect(r.deferred).toEqual([{ taskId: 't1', reason: 'capacity' }])
  })

  it('routes around a ceilinged slot to one with headroom', () => {
    const r = plan({
      ready: [task('t1')],
      slots: [slot('s1', { inUse: 1, usageUtilization: 0.9 }), slot('s2', { usageUtilization: 0.5 })],
      active: [attempt('a1', 's1')],
    })
    expect(r.launches).toEqual([{ taskId: 't1', slotId: 's2' }])
  })

  it('defers as capacity when every slot’s capacity is consumed', () => {
    const r = plan({
      ready: [task('t1')],
      slots: [slot('s1', { concurrency: 1, inUse: 1 }), slot('s2', { concurrency: 1, inUse: 1 })],
      active: [attempt('a1', 's1'), attempt('a2', 's2')],
    })
    expect(r.launches).toEqual([])
    expect(r.deferred).toEqual([{ taskId: 't1', reason: 'capacity' }])
  })

  it('keeps one unit free for a follow-up when the reservation is on', () => {
    const over = {
      ready: [task('t1')],
      slots: [slot('s1', { concurrency: 1, inUse: 1 }), slot('s2', { concurrency: 1 })],
      active: [attempt('a1', 's1')],
      caps: caps({ globalActiveAttempts: 4 }),
    }
    expect(plan({ ...over, reservedWakeSlot: true }).launches).toEqual([])
    expect(plan({ ...over, reservedWakeSlot: true }).deferred).toEqual([{ taskId: 't1', reason: 'capacity' }])
    expect(plan({ ...over, reservedWakeSlot: false }).launches).toEqual([{ taskId: 't1', slotId: 's2' }])
  })

  it('still launches while more than one unit would remain free', () => {
    const r = plan({
      ready: [task('t1'), task('t2'), task('t3'), task('t4')],
      slots: [slot('s1', { concurrency: 2 }), slot('s2', { concurrency: 2 })],
      caps: caps({ globalActiveAttempts: 4, perWorkItem: 4 }),
      reservedWakeSlot: true,
    })
    expect(r.launches.map((l) => l.taskId)).toEqual(['t1', 't2', 't3'])
    expect(r.deferred).toEqual([{ taskId: 't4', reason: 'capacity' }])
  })

  it('schedules a pinned work item before older unpinned work', () => {
    const r = plan({
      ready: [
        task('a1', { workItemId: 'wa', readyAt: 100 }),
        task('p1', { workItemId: 'wp', workItemPinned: true, readyAt: 200 }),
      ],
      caps: caps({ globalActiveAttempts: 1, perWorkItem: 2 }),
    })
    expect(r.launches).toEqual([{ taskId: 'p1', slotId: 's1' }])
    expect(r.deferred).toEqual([{ taskId: 'a1', reason: 'capacity' }])
  })

  it('rotates fairly across work items', () => {
    const r = plan({
      ready: [
        task('a1', { workItemId: 'wa', readyAt: 100 }),
        task('a2', { workItemId: 'wa', readyAt: 110 }),
        task('b1', { workItemId: 'wb', readyAt: 105 }),
        task('b2', { workItemId: 'wb', readyAt: 115 }),
      ],
    })
    expect(r.launches.map((l) => l.taskId)).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(r.deferred).toEqual([])
  })

  it('prefers the lowest-utilisation slot', () => {
    const r = plan({
      ready: [task('t1')],
      slots: [slot('s1', { usageUtilization: 0.5 }), slot('s2', { usageUtilization: 0.2 })],
    })
    expect(r.launches).toEqual([{ taskId: 't1', slotId: 's2' }])
  })

  it('breaks utilisation ties by fewest attempts in use', () => {
    const r = plan({
      ready: [task('t1')],
      slots: [slot('s1', { usageUtilization: 0.4, inUse: 1 }), slot('s2', { usageUtilization: 0.4 })],
    })
    expect(r.launches).toEqual([{ taskId: 't1', slotId: 's2' }])
  })

  it('enforces the per-work-item cap', () => {
    const r = plan({
      ready: [
        task('a1', { workItemId: 'wa' }),
        task('a2', { workItemId: 'wa' }),
        task('a3', { workItemId: 'wa' }),
      ],
      caps: caps({ globalActiveAttempts: 4, perWorkItem: 2 }),
    })
    expect(r.launches.map((l) => l.taskId)).toEqual(['a1', 'a2'])
    expect(r.deferred).toEqual([{ taskId: 'a3', reason: 'capacity' }])
  })

  it('enforces the per-slot cap below a slot’s concurrency', () => {
    const tight = caps({ globalActiveAttempts: 4, perWorkItem: 4, perSlot: 1 })
    const spread = plan({
      ready: [task('t1'), task('t2')],
      slots: [slot('s1', { concurrency: 4 }), slot('s2', { concurrency: 4 })],
      caps: tight,
    })
    expect(spread.launches).toEqual([
      { taskId: 't1', slotId: 's1' },
      { taskId: 't2', slotId: 's2' },
    ])
    const solo = plan({
      ready: [task('t1'), task('t2')],
      slots: [slot('s1', { concurrency: 4 })],
      caps: tight,
    })
    expect(solo.launches.map((l) => l.taskId)).toEqual(['t1'])
    expect(solo.deferred).toEqual([{ taskId: 't2', reason: 'capacity' }])
  })

  it('honours slot class bindings', () => {
    const r = plan({
      ready: [task('r1', { slotClass: 'review', role: 'reviewer' })],
      slots: [slot('s1'), slot('s2', { slotClass: 'review' })],
    })
    expect(r.launches).toEqual([{ taskId: 'r1', slotId: 's2' }])
  })

  it('matches a slot’s role pinning and defers when nothing healthy matches', () => {
    const r = plan({
      ready: [task('r1', { slotClass: 'review', role: 'reviewer' }), task('i1', { role: 'implementer' })],
      slots: [slot('s1', { slotClass: 'review', pinnedRoles: ['reviewer'] })],
    })
    expect(r.launches).toEqual([{ taskId: 'r1', slotId: 's1' }])
    expect(r.deferred).toEqual([{ taskId: 'i1', reason: 'slot_unhealthy' }])
  })
})
