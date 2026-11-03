/**
 * Pull-request delivery machine, plan §14: integration completing makes the delivery ready
 * for its PR; the PR opens once, watches CI, and is merged only when GitHub confirms it —
 * never as an assumption drawn from an API call. A closed PR returns the delivery to
 * integrating, and target-branch movement re-runs the required checks on the updated
 * integration branch.
 *
 * Explicit table, states.ts discipline: anything not listed is invalid and throws.
 */
export type PrState = 'idle' | 'ready_for_pr' | 'pr_open' | 'ci_pending' | 'ci_green' | 'merged' | 'closed'

export type PrEvent =
  | 'integration_complete'
  | 'pr_created'
  | 'pr_closed'
  | 'ci_passed'
  | 'ci_failed'
  | 'merged_on_github'
  | 'target_moved'

const PR_MACHINE: readonly { from: PrState; event: PrEvent; to: PrState }[] = [
  { from: 'idle', event: 'integration_complete', to: 'ready_for_pr' },
  // A closed PR returns the delivery to integrating (§14); the next completion re-opens.
  { from: 'closed', event: 'integration_complete', to: 'ready_for_pr' },
  { from: 'ready_for_pr', event: 'pr_created', to: 'pr_open' },
  // CI: a failure parks the PR pending; a pass (first run or re-run) greens it.
  { from: 'pr_open', event: 'ci_passed', to: 'ci_green' },
  { from: 'pr_open', event: 'ci_failed', to: 'ci_pending' },
  { from: 'ci_pending', event: 'ci_passed', to: 'ci_green' },
  // ONLY GitHub confirms the merge (§14), and only from green checks.
  { from: 'ci_green', event: 'merged_on_github', to: 'merged' },
  // The PR can be closed while open or while checks are pending or green.
  { from: 'pr_open', event: 'pr_closed', to: 'closed' },
  { from: 'ci_pending', event: 'pr_closed', to: 'closed' },
  { from: 'ci_green', event: 'pr_closed', to: 'closed' },
  // Target-branch movement re-runs the required checks on the updated branch (§14).
  { from: 'ci_green', event: 'target_moved', to: 'ci_pending' },
]

export function prTransition(state: PrState, event: PrEvent): PrState {
  const row = PR_MACHINE.find((r) => r.from === state && r.event === event)
  if (row === undefined) {
    throw new Error(`invalid pr transition ${state} --${event}-->`)
  }
  return row.to
}
