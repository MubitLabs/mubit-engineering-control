import { describe, expect, it } from 'vitest'
import {
  type ApprovalView,
  canonicalJson,
  checkResolution,
  checkSequence,
  dependencyBlocker,
  dependencySatisfied,
  fence,
  type Lease,
  nextGeneration,
  renew,
} from '../src'

const now = new Date('2026-11-02T12:00:00Z')
const later = (ms: number) => new Date(now.getTime() + ms)

describe('approval resolution', () => {
  const pending: ApprovalView = {
    kind: 'tool',
    status: 'pending',
    allowedDeciderIds: ['owner'],
    expiresAt: later(60_000),
    bindingHash: 'h1',
  }
  const input = { deciderId: 'owner', decision: { kind: 'approve' as const }, now, currentBindingHash: 'h1' }

  it('lets a listed decider approve the exact operation', () => {
    expect(checkResolution(pending, input)).toEqual({ ok: true, value: 'approved' })
    expect(checkResolution(pending, { ...input, decision: { kind: 'reject' } })).toEqual({
      ok: true,
      value: 'rejected',
    })
  })

  it('never treats an expired request as consent', () => {
    const r = checkResolution(pending, { ...input, now: later(60_000) })
    expect(r).toEqual({ ok: false, error: { code: 'expired' } })
  })

  it('refuses anyone not listed, including admins', () => {
    expect(checkResolution(pending, { ...input, deciderId: 'admin' })).toEqual({
      ok: false,
      error: { code: 'not_authorised' },
    })
  })

  it('marks a changed input as stale', () => {
    expect(checkResolution(pending, { ...input, currentBindingHash: 'h2' })).toEqual({
      ok: false,
      error: { code: 'stale_binding' },
    })
  })

  it('reports the recorded status to a second answer', () => {
    expect(checkResolution({ ...pending, status: 'approved' }, input)).toEqual({
      ok: false,
      error: { code: 'not_pending', status: 'approved' },
    })
  })

  it('accepts only answers for questions, and rejects empty ones', () => {
    const q: ApprovalView = { ...pending, kind: 'question' }
    expect(checkResolution(q, input).ok).toBe(false)
    expect(checkResolution(q, { ...input, decision: { kind: 'answer', answer: 'use UTC' } })).toEqual({
      ok: true,
      value: 'answered',
    })
    expect(checkResolution(q, { ...input, decision: { kind: 'answer', answer: '  ' } }).ok).toBe(false)
  })
})

describe('lease fencing', () => {
  const lease: Lease = { attemptId: 'a1', runnerId: 'r1', generation: 3, expiresAt: later(60_000) }

  it('accepts the current runner and generation', () => {
    expect(fence(lease, { runnerId: 'r1', generation: 3 }, now, 'authoritative').ok).toBe(true)
  })

  it('fences older generations, other runners and invented generations', () => {
    expect(fence(lease, { runnerId: 'r1', generation: 2 }, now, 'telemetry')).toEqual({
      ok: false,
      error: 'stale_generation',
    })
    expect(fence(lease, { runnerId: 'r2', generation: 3 }, now, 'telemetry')).toEqual({
      ok: false,
      error: 'wrong_runner',
    })
    expect(fence(lease, { runnerId: 'r1', generation: 4 }, now, 'telemetry')).toEqual({
      ok: false,
      error: 'future_generation',
    })
  })

  it('keeps journalling telemetry after expiry but blocks authoritative writes', () => {
    const at = later(60_000)
    expect(fence(lease, { runnerId: 'r1', generation: 3 }, at, 'telemetry').ok).toBe(true)
    expect(fence(lease, { runnerId: 'r1', generation: 3 }, at, 'authoritative')).toEqual({
      ok: false,
      error: 'lease_expired',
    })
  })

  it('renews in place and bumps the generation on resume', () => {
    expect(renew(lease, later(30_000)).expiresAt).toEqual(later(90_000))
    const next = nextGeneration(lease, now)
    expect(next.generation).toBe(4)
    expect(fence(next, { runnerId: 'r1', generation: 3 }, now, 'authoritative').ok).toBe(false)
  })
})

describe('event sequences', () => {
  it('accepts the next sequence, flags gaps and rejects regressions', () => {
    expect(checkSequence(null, 0)).toEqual({ kind: 'next' })
    expect(checkSequence(4, 5)).toEqual({ kind: 'next' })
    expect(checkSequence(4, 8)).toEqual({ kind: 'gap', missing: 3 })
    expect(checkSequence(4, 4)).toEqual({ kind: 'out_of_order' })
    expect(checkSequence(4, 2)).toEqual({ kind: 'out_of_order' })
  })
})

describe('dependency blockers', () => {
  it('requires integration for code dependencies, acceptance for contract dependencies', () => {
    expect(dependencySatisfied('integration', 'accepted')).toBe(false)
    expect(dependencySatisfied('integration', 'integrated')).toBe(true)
    expect(dependencySatisfied('contract', 'accepted')).toBe(true)
    expect(dependencySatisfied('contract', 'awaiting_review')).toBe(false)
  })

  it('describes what a task is waiting for', () => {
    const b = dependencyBlocker('integration', [
      { key: 'T1', state: 'integrated' },
      { key: 'T2', state: 'active' },
    ])
    expect(b).toEqual({
      kind: 'dependency',
      detail: 'Waiting for T2 to be integrated',
      refs: ['T2'],
    })
    expect(dependencyBlocker('integration', [{ key: 'T1', state: 'integrated' }])).toBeNull()
  })
})

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    )
  })
})
