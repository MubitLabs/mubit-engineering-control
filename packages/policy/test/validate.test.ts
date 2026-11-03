import { describe, expect, it } from 'vitest'
import { loadPolicy, validateMandateAgainstPolicy } from '../src'

const policy = loadPolicy(
  JSON.stringify({
    capsOverride: { globalActiveAttempts: 4, budgetUsd: 20 },
    preAuthorised: {},
  }),
)

describe('validateMandateAgainstPolicy', () => {
  it('refuses global caps and budgets above the policy override ceiling', () => {
    const caps = validateMandateAgainstPolicy({
      budgetUsd: 10,
      caps: { globalActiveAttempts: 5 },
      policy,
    })
    expect(caps.ok).toBe(false)
    expect(caps.reason).toContain('globalActiveAttempts 5 exceeds the policy ceiling 4')

    const budget = validateMandateAgainstPolicy({
      budgetUsd: 21,
      caps: { globalActiveAttempts: 4 },
      policy,
    })
    expect(budget.ok).toBe(false)
    expect(budget.reason).toContain('budgetUsd 21 exceeds the policy ceiling 20')
  })

  it('accepts caps at or below the ceiling, and any cap when policy sets none', () => {
    expect(
      validateMandateAgainstPolicy({ budgetUsd: 20, caps: { globalActiveAttempts: 4 }, policy }),
    ).toEqual({ ok: true })
    expect(
      validateMandateAgainstPolicy({ budgetUsd: 10, caps: { globalActiveAttempts: 2 }, policy }),
    ).toEqual({ ok: true })

    const unbounded = loadPolicy(JSON.stringify({ preAuthorised: {} }))
    expect(validateMandateAgainstPolicy({ caps: { globalActiveAttempts: 99 }, policy: unbounded })).toEqual({
      ok: true,
    })
  })
})
