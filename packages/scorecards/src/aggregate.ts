/**
 * Scorecard rollups, plan §19: which roles earn their keep, and what each provider window
 * actually showed. Pure functions over the records `project.ts` builds — no storage here.
 *
 * Unknown-handling (§19: missing data is unknown, not zero):
 * - `avgCostUsd` averages the costs that were reported; attempts with `'unknown'` cost leave
 *   the divisor, not a silent 0. With no reported cost at all it is `'unknown'`.
 * - `failed` counts every attempt whose result is not `'completed'` — including `'unknown'`,
 *   which is not known to have completed — so `completed + failed` always reconciles to
 *   `attempts`.
 * - `messagesSent` sums `turns`: each finished turn ends in one assistant message, and the
 *   outcome record carries no separate message counter.
 * - The utilisation ledger takes the maximum `utilization` each window actually reported and
 *   stays `'unknown'` when a window surfaced events but no reading — never 0 % (§5.9).
 */
import type { EngineEvent } from '@mec/contracts'
import type { AttemptOutcome } from './project'

export type RoleSummary = {
  role: string
  attempts: number
  completed: number
  failed: number
  quotaParks: number
  avgCostUsd: number | 'unknown'
  messagesSent: number
}

export function summariseByRole(outcomes: readonly AttemptOutcome[]): RoleSummary[] {
  const groups = new Map<string, AttemptOutcome[]>()
  for (const outcome of outcomes) {
    // An outcome the attempt row could not decorate still belongs to the rollup.
    const role = outcome.role ?? 'unknown'
    const bucket = groups.get(role)
    if (bucket === undefined) groups.set(role, [outcome])
    else bucket.push(outcome)
  }
  return [...groups.entries()].map(([role, bucket]) => {
    const knownCosts = bucket
      .map((outcome) => outcome.costUsd)
      .filter((cost): cost is number => cost !== 'unknown')
    return {
      role,
      attempts: bucket.length,
      completed: bucket.filter((outcome) => outcome.result === 'completed').length,
      failed: bucket.filter((outcome) => outcome.result !== 'completed').length,
      quotaParks: bucket.reduce((sum, outcome) => sum + outcome.quotaParks, 0),
      avgCostUsd:
        knownCosts.length === 0
          ? 'unknown'
          : knownCosts.reduce((sum, cost) => sum + cost, 0) / knownCosts.length,
      messagesSent: bucket.reduce((sum, outcome) => sum + outcome.turns, 0),
    }
  })
}

export type UtilisationRow = {
  window: string
  utilizationMax: number | 'unknown'
  /** The last concrete reset time the window reported; omitted when none was. */
  resetsAtLast?: string
}

export function utilisationLedger(events: readonly EngineEvent[]): UtilisationRow[] {
  const windows = new Map<string, UtilisationRow>()
  for (const event of events) {
    if (event.type !== 'rate_limit') continue
    const row = windows.get(event.window) ?? { window: event.window, utilizationMax: 'unknown' }
    if (event.utilization !== undefined) {
      row.utilizationMax =
        row.utilizationMax === 'unknown' ? event.utilization : Math.max(row.utilizationMax, event.utilization)
    }
    if (event.resets_at !== undefined && event.resets_at !== 'unknown') {
      row.resetsAtLast = event.resets_at
    }
    windows.set(event.window, row)
  }
  return [...windows.values()]
}
