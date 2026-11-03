import { describe, expect, it } from 'vitest'
import type { Mandate } from '../src'
import { createMandate, expire, revalidate, withdraw } from '../src'

const mandate = (overrides: Partial<Mandate> = {}): Mandate =>
  createMandate({
    id: 'w1',
    originMessageId: 'm1',
    scope: 'add audit-log viewing',
    policyHash: 'sha:policy@1',
    budgetTurns: 40,
    expiresAt: '2026-11-10T00:00:00Z',
    ...overrides,
  })

describe('createMandate', () => {
  it('creates an active mandate carrying origin, scope, policy, budget and expiry', () => {
    const m = mandate()
    expect(m).toEqual({
      id: 'w1',
      originMessageId: 'm1',
      scope: 'add audit-log viewing',
      policyHash: 'sha:policy@1',
      budgetTurns: 40,
      expiresAt: '2026-11-10T00:00:00Z',
      status: 'active',
    })
  })

  it('accepts a null expiry (never expires)', () => {
    expect(mandate({ expiresAt: null }).expiresAt).toBeNull()
  })
})

describe('withdraw', () => {
  it('withdraws the mandate and records id and time in the events', () => {
    const { mandate: m, events } = withdraw(mandate(), '2026-11-03T12:00:00Z')
    expect(m.status).toBe('withdrawn')
    expect(events).toEqual(['mandate w1 withdrawn at 2026-11-03T12:00:00Z'])
  })

  it('is idempotent — a second stop adds no events', () => {
    const once = withdraw(mandate(), '2026-11-03T12:00:00Z')
    const twice = withdraw(once.mandate, '2026-11-03T13:00:00Z')
    expect(twice.mandate).toBe(once.mandate)
    expect(twice.events).toEqual([])
  })
})

describe('expire', () => {
  it('revokes a mandate whose revalidation failed', () => {
    const { mandate: m, events } = expire(mandate(), '2026-11-11T00:00:01Z')
    expect(m.status).toBe('expired')
    expect(events).toEqual(['mandate w1 expired at 2026-11-11T00:00:01Z'])
  })
})

describe('revalidate', () => {
  it('passes before expiry under the same policy', () => {
    expect(revalidate(mandate(), '2026-11-09T23:59:59Z', 'sha:policy@1')).toEqual({ ok: true })
  })

  it('passes a mandate with no expiry', () => {
    expect(revalidate(mandate({ expiresAt: null }), '2099-01-01T00:00:00Z', 'sha:policy@1')).toEqual({
      ok: true,
    })
  })

  it('passes exactly at the expiry instant — equality is still valid', () => {
    expect(revalidate(mandate(), '2026-11-10T00:00:00Z', 'sha:policy@1')).toEqual({ ok: true })
  })

  it('fails expired strictly after the expiry instant (ISO compare)', () => {
    expect(revalidate(mandate(), '2026-11-10T00:00:01Z', 'sha:policy@1')).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('fails expired for an already-revoked mandate', () => {
    const { mandate: m } = expire(mandate({ expiresAt: null }), '2026-11-03T12:00:00Z')
    expect(revalidate(m, '2026-11-03T12:00:01Z', 'sha:policy@1')).toEqual({ ok: false, reason: 'expired' })
  })

  it('fails withdrawn — a stop is final and never resumes, even past expiry', () => {
    const { mandate: m } = withdraw(mandate(), '2026-11-03T12:00:00Z')
    expect(revalidate(m, '2026-11-20T00:00:00Z', 'sha:policy@1')).toEqual({
      ok: false,
      reason: 'withdrawn',
    })
  })

  it('fails policy_changed on a policy hash change — and cancels nothing', () => {
    const m = mandate()
    const result = revalidate(m, '2026-11-04T00:00:00Z', 'sha:policy@2')
    expect(result).toEqual({ ok: false, reason: 'policy_changed' })
    // §27: live work is never cancelled on a policy change — reason only, mandate intact.
    expect(m.status).toBe('active')
    expect(m.policyHash).toBe('sha:policy@1')
  })

  it('is pure: never mutates the mandate it checks', () => {
    const m = mandate()
    revalidate(m, '2026-11-20T00:00:00Z', 'sha:policy@2')
    expect(m).toEqual(mandate())
  })
})
