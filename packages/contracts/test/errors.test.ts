import { describe, expect, it } from 'vitest'
import { ERROR_CODES, type ErrorCode, httpStatusFor, UserError } from '../src/errors'

// CONTRACTS §8, codes v0 — written out so a drifted enum fails here first.
const CODES_V0 = [
  'missing',
  'stale_revision',
  'invalid_plan',
  'cap_exceeded',
  'budget_exceeded',
  'slot_unhealthy',
  'slot_full',
  'mandate_withdrawn',
  'work_item_held',
  'not_owner',
  'already_handled',
  'confirmation_stale',
  'confirmation_expired',
  'policy_violation',
  'secret_in_input',
  'engine_unsupported',
  'login_in_progress',
  'invalid_key',
  'repo_untrusted',
]

// §8: missing answers 404, stale_revision 409, the rest 400. One row per code, so nothing is unmapped.
const STATUS_TABLE: readonly (readonly [ErrorCode, number])[] = [
  ['missing', 404],
  ['stale_revision', 409],
  ['invalid_plan', 400],
  ['cap_exceeded', 400],
  ['budget_exceeded', 400],
  ['slot_unhealthy', 400],
  ['slot_full', 400],
  ['mandate_withdrawn', 400],
  ['work_item_held', 400],
  ['not_owner', 400],
  ['already_handled', 400],
  ['confirmation_stale', 400],
  ['confirmation_expired', 400],
  ['policy_violation', 400],
  ['secret_in_input', 400],
  ['engine_unsupported', 400],
  ['login_in_progress', 400],
  ['invalid_key', 400],
  ['repo_untrusted', 400],
]

describe('ERROR_CODES', () => {
  it('is exactly the CONTRACTS §8 codes v0 list', () => {
    expect([...ERROR_CODES.options].sort()).toEqual([...CODES_V0].sort())
  })
})

describe('httpStatusFor', () => {
  it.each(STATUS_TABLE)('answers %s with %i', (code, status) => {
    expect(httpStatusFor(code)).toBe(status)
  })

  it('maps every code in the enum', () => {
    expect(STATUS_TABLE.map(([code]) => code).sort()).toEqual([...ERROR_CODES.options].sort())
  })
})

describe('UserError', () => {
  it('is an Error that carries its code and values', () => {
    const error = new UserError('slot_full', { slot: 'slot_max-1', attempt: 'att_01' })
    expect(error instanceof Error).toBe(true)
    expect(error.code).toBe('slot_full')
    expect(error.values).toEqual({ slot: 'slot_max-1', attempt: 'att_01' })
  })

  it('defaults values to an empty record', () => {
    expect(new UserError('missing').values).toEqual({})
  })
})
