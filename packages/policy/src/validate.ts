/**
 * Mandate-vs-policy validation, plan §13: "mandates are revalidated against the current
 * version before any resume", and §11: caps are policy-settable from above, never from
 * below. A mandate may run under a *tighter* cap than policy allows, never a looser one.
 */

import type { PolicyDoc } from './policy'

export function validateMandateAgainstPolicy(input: {
  budgetUsd?: number
  caps: { globalActiveAttempts: number }
  policy: PolicyDoc
}): { ok: boolean; reason?: string } {
  const ceiling = input.policy.capsOverride?.globalActiveAttempts
  if (ceiling !== undefined && input.caps.globalActiveAttempts > ceiling) {
    return {
      ok: false,
      reason: `globalActiveAttempts ${input.caps.globalActiveAttempts} exceeds the policy ceiling ${ceiling} (policy ${input.policy.versionHash})`,
    }
  }

  const budgetCeiling = input.policy.capsOverride?.budgetUsd
  if (budgetCeiling !== undefined && input.budgetUsd !== undefined && input.budgetUsd > budgetCeiling) {
    return {
      ok: false,
      reason: `budgetUsd ${input.budgetUsd} exceeds the policy ceiling ${budgetCeiling} (policy ${input.policy.versionHash})`,
    }
  }

  return { ok: true }
}
