// What a connection offers decides the model (review 2026-11-04 §3 rules 1 and 2): a model the
// slot's engine does not list is never chosen, the walk stays on the ladder, and a substitution is
// said on the attempt. Observed on 0.3.4: a ChatGPT sign-in refused the table's first fast model.
import type { CapabilityTable } from '@mec/prompts'
import { describe, expect, it } from 'vitest'
import { ModelResolutionError, resolveModel } from '../src/model'

const TABLE = {
  version: 1,
  tiers: ['fast', 'balanced', 'strong', 'frontier'],
  engines: {
    codex: {
      select: { flag: '-m', effort_override: '-c model_reasoning_effort="<level>"' },
      effort_levels: ['low', 'medium', 'high'],
      models: {
        'gpt-6-luna': { tier: 'fast', effort: 'low', speed: 4, cost: 1, vendor_says: 'x' },
        'gpt-5.6-luna': { tier: 'fast', effort: 'low', speed: 4, cost: 1, vendor_says: 'x' },
        'gpt-6.1-sol': { tier: 'balanced', effort: 'medium', speed: 3, cost: 3, vendor_says: 'x' },
      },
    },
  },
} as unknown as CapabilityTable

const CODEX = { engine: 'codex' as const }

describe('resolveModel against what the connection offers', () => {
  it('without a listing, the table order decides, as before', () => {
    expect(resolveModel({ tier: 'fast', reason: 'r' }, CODEX, TABLE).model).toBe('gpt-6-luna')
  })

  it('a model the connection does not offer is passed over for the next one at the tier', () => {
    const resolved = resolveModel({ tier: 'fast', reason: 'r' }, CODEX, TABLE, {
      unavailable: new Set(['gpt-6-luna']),
    })
    expect(resolved.model).toBe('gpt-5.6-luna')
    expect(resolved.argv_additions).toEqual(['-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"'])
    expect(resolved.passed_over).toEqual(['gpt-6-luna'])
    expect(resolved.tier_degraded).toBeUndefined()
  })

  // Seen in Codex run 6: the chosen row led the table, and the unoffered rows after it were
  // reported as passed over. Only a row that would have been chosen first was.
  it('an unoffered row after the chosen one is not passed over', () => {
    const resolved = resolveModel({ tier: 'fast', reason: 'r' }, CODEX, TABLE, {
      unavailable: new Set(['gpt-5.6-luna']),
    })
    expect(resolved.model).toBe('gpt-6-luna')
    expect(resolved.passed_over).toBeUndefined()
  })

  it('a tier the connection offers nothing at walks down the ladder and says why', () => {
    const resolved = resolveModel({ tier: 'balanced', reason: 'r' }, CODEX, TABLE, {
      unavailable: new Set(['gpt-6.1-sol', 'gpt-6-luna']),
    })
    expect(resolved.model).toBe('gpt-5.6-luna')
    expect(resolved.tier_degraded).toBe('balanced→fast (this connection offers no balanced model)')
    expect(resolved.passed_over).toEqual(['gpt-6.1-sol'])
  })

  it('a provider that has no model at a tier still says so in its own words', () => {
    const resolved = resolveModel({ tier: 'strong', reason: 'r' }, CODEX, TABLE, {
      unavailable: new Set(['gpt-6-luna']),
    })
    expect(resolved.model).toBe('gpt-6.1-sol')
    expect(resolved.tier_degraded).toBe('strong→balanced (provider has no strong)')
  })

  it('nothing offered at or below the tier refuses, naming what was not offered', () => {
    const refuse = () =>
      resolveModel({ tier: 'fast', reason: 'r' }, CODEX, TABLE, {
        unavailable: new Set(['gpt-6-luna', 'gpt-5.6-luna']),
      })
    expect(refuse).toThrow(ModelResolutionError)
    expect(refuse).toThrow(/not offered on this connection: gpt-6-luna, gpt-5.6-luna/)
  })

  it('a named model the connection does not offer refuses, and is never swapped', () => {
    const refuse = () =>
      resolveModel({ model: 'gpt-6-luna', reason: 'r' }, CODEX, TABLE, {
        unavailable: new Set(['gpt-6-luna']),
      })
    expect(refuse).toThrow(/'gpt-6-luna' is not offered on this connection/)
  })
})
