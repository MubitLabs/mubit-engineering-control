import { describe, expect, it } from 'vitest'
import { type Candidate, type Load, orderCandidates, planDispatches, type RunnerSlot } from '../src'

const cand = (taskId: string, over: Partial<Candidate> = {}): Candidate => ({
  taskId,
  deliveryId: 'd1',
  projectId: 'p1',
  priority: 0,
  createdAt: Number(taskId.replace(/\D/g, '')) || 0,
  agentKind: 'fake',
  profileId: null,
  runnerId: null,
  ...over,
})
const runner = (runnerId: string, over: Partial<RunnerSlot> = {}): RunnerSlot => ({
  runnerId,
  name: runnerId,
  ownerId: `owner-${runnerId}`,
  active: 0,
  capacity: 2,
  agentKinds: ['fake', 'claude-code'],
  ...over,
})
const idle: Load = { total: 0, byEmployee: {}, byDelivery: {}, byProfile: {} }
const limits = { global: 6, perEmployee: 2, perDelivery: 3, perProfile: 1 }

describe('orderCandidates', () => {
  it('puts higher priority first', () => {
    expect(orderCandidates([cand('t1'), cand('t2', { priority: 5 })]).map((c) => c.taskId)).toEqual([
      't2',
      't1',
    ])
  })

  it('rotates across projects at equal priority', () => {
    const order = orderCandidates([
      cand('t1', { projectId: 'a' }),
      cand('t2', { projectId: 'a' }),
      cand('t3', { projectId: 'a' }),
      cand('t4', { projectId: 'b' }),
      cand('t5', { projectId: 'b' }),
    ]).map((c) => c.taskId)
    expect(order).toEqual(['t1', 't4', 't2', 't5', 't3'])
  })

  it('is deterministic regardless of input order', () => {
    const cs = [cand('t3'), cand('t1'), cand('t2', { projectId: 'b' })]
    expect(orderCandidates(cs)).toEqual(orderCandidates([...cs].reverse()))
  })
})

describe('planDispatches', () => {
  it('dispatches up to the global limit and holds the rest with a reason', () => {
    const r = planDispatches([cand('t1'), cand('t2'), cand('t3')], [runner('r1', { capacity: 5 })], idle, {
      ...limits,
      global: 2,
    })
    expect(r.dispatches.map((d) => d.taskId)).toEqual(['t1', 't2'])
    expect(r.held).toEqual([{ taskId: 't3', limit: 'global', detail: 'global limit of 2 active attempts' }])
  })

  it('counts existing load', () => {
    const r = planDispatches([cand('t1')], [runner('r1')], { ...idle, total: 6 }, limits)
    expect(r.dispatches).toEqual([])
    expect(r.held[0]?.limit).toBe('global')
  })

  it('respects runner capacity and prefers the least loaded runner', () => {
    const r = planDispatches(
      [cand('t1'), cand('t2'), cand('t3')],
      [runner('r1', { active: 1, capacity: 2 }), runner('r2', { active: 0, capacity: 1 })],
      idle,
      limits,
    )
    expect(r.dispatches).toEqual([
      { taskId: 't1', runnerId: 'r2' },
      { taskId: 't2', runnerId: 'r1' },
    ])
    expect(r.held[0]).toMatchObject({ taskId: 't3', limit: 'runner' })
  })

  it('enforces the per-employee limit across that employee’s runners', () => {
    const r = planDispatches(
      [cand('t1'), cand('t2'), cand('t3')],
      [runner('r1', { ownerId: 'eve', capacity: 4 }), runner('r2', { ownerId: 'eve', capacity: 4 })],
      idle,
      limits,
    )
    expect(r.dispatches).toHaveLength(2)
    expect(r.held[0]).toMatchObject({ taskId: 't3', limit: 'employee' })
  })

  it('enforces per-delivery and per-profile limits', () => {
    const many = [cand('t1'), cand('t2'), cand('t3'), cand('t4')]
    const big = [runner('r1', { capacity: 10 }), runner('r2', { capacity: 10 })]
    expect(planDispatches(many, big, idle, { ...limits, perEmployee: 10 }).held[0]).toMatchObject({
      taskId: 't4',
      limit: 'delivery',
    })
    const profiled = [cand('t1', { profileId: 'p' }), cand('t2', { profileId: 'p' })]
    expect(planDispatches(profiled, big, idle, limits).held[0]).toMatchObject({
      taskId: 't2',
      limit: 'profile',
    })
  })

  it('only uses runners that offer the agent and the bound runner', () => {
    const r = planDispatches(
      [cand('t1', { agentKind: 'codex' }), cand('t2', { runnerId: 'r2' })],
      [runner('r1'), runner('r2')],
      idle,
      limits,
    )
    expect(r.held[0]).toMatchObject({ taskId: 't1', limit: 'no_runner' })
    expect(r.dispatches).toEqual([{ taskId: 't2', runnerId: 'r2' }])
  })
})
