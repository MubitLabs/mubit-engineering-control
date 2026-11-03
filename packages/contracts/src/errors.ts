import { z } from 'zod'

/** Every refusal a person or an agent can cause (CONTRACTS §8, codes v0); the panel words each code. */
export const ERROR_CODES = z.enum([
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
])

/** A refusal the caller can understand and possibly fix; `values` carries machine-readable context. */
export class UserError extends Error {
  readonly code: ErrorCode
  readonly values: Record<string, unknown>

  constructor(code: ErrorCode, values: Record<string, unknown> = {}) {
    super(code)
    this.name = 'UserError'
    this.code = code
    this.values = values
  }
}

/** CONTRACTS §8: the API answers `missing` with 404, `stale_revision` with 409, the rest with 400. */
export function httpStatusFor(code: ErrorCode): 404 | 409 | 400 {
  if (code === 'missing') return 404
  if (code === 'stale_revision') return 409
  return 400
}

export type ErrorCode = z.infer<typeof ERROR_CODES>
