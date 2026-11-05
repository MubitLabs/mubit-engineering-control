import type { DecisionDetail, ResolveResult } from './api'

/**
 * §13: an approval is the action, so it waits until the server has said what it approves.
 * `null` is evidence still loading or failed to load; `absent` is the server's 404, a card with
 * no evidence to show. Neither can be approved; deny needs no evidence and stays live.
 */
export function canApprove(detail: DecisionDetail | null): boolean {
  return detail !== null && detail.absent !== true
}

/**
 * What an Approve click really did, in words (§13: a settled approval acts, and the UI says
 * how that went). `closes: false` means the card stays open and the answer was not spent.
 */
export type ApprovalShown = {
  closes: boolean
  kind: 'approved' | 'handled'
  note: string
  toast: string
}

/** The holds the server names: the card is still pending, nothing ran. */
const HOLDS: Record<string, string> = {
  ci_pending: 'Required checks are still running.',
  ci_failed: 'A required check failed.',
  ci_unreadable: 'GitHub’s checks could not be read.',
  no_required_checks: 'GitHub reports no required checks on this PR yet.',
  behind: 'The PR is behind its base branch. Update the branch, then approve again.',
  blocked: 'GitHub is blocking this merge, for example on a required review.',
  dirty: 'The PR has merge conflicts.',
  draft: 'The PR is still a draft.',
  merge_state_unknown: 'GitHub has not worked out whether this PR can merge.',
  pr_unreadable: 'The PR could not be read from GitHub.',
  pr_not_open: 'The PR is no longer open.',
  head_unreadable: 'The branch head could not be read.',
  remote_unreadable: 'The remote could not be read, or it is not the clone’s origin.',
  invalid_ref: 'The clone’s origin is not a plain owner/name repository.',
  card_unbound: 'This card has no bound head. Deny it and open a new one.',
}

const failed = (toast: string, note: string): ApprovalShown => ({
  closes: true,
  kind: 'handled',
  note,
  toast,
})

export function describeApproval(result: ResolveResult): ApprovalShown {
  const { status, reason, error } = result
  if (status === 'pending') {
    const why = (reason !== undefined && HOLDS[reason]) || `Held: ${reason ?? 'no reason given'}.`
    return { closes: false, kind: 'handled', note: why, toast: `${why} The card stays open.` }
  }
  if (status === 'stale') {
    return failed('The head moved after this card opened. Nothing ran; it needs a new card.', 'Stale')
  }
  if (status === 'expired') return failed('This card expired. Nothing ran.', 'Expired')
  if (reason === 'gh_merge_failed') {
    return failed(
      'GitHub did not merge this PR. The approval is spent; retrying needs a new card.',
      'Merge failed',
    )
  }
  if (result.merged === false) {
    return failed(
      `GitHub did not confirm the merge (${reason ?? 'no reason given'}). Check the PR.`,
      'Unconfirmed',
    )
  }
  if (error !== undefined) {
    return failed(`It failed: ${error}. The approval is spent; retrying needs a new card.`, 'Failed')
  }
  if (result.merged === true) return shown('Merged on GitHub', 'Merged on GitHub.')
  if (result.pushed === true) return shown('Pushed', 'Pushed.')
  if (result.prNumber !== undefined)
    return shown(`PR #${result.prNumber} opened`, `PR #${result.prNumber} opened.`)
  // §13: only the server knows whether an agent was waiting on this answer.
  if (result.continues === true) return shown('Approved', 'Approved — the agent was told to continue.')
  return shown('Approved', 'Approved. Your approval is on record; nothing runs from this click.')
}

const shown = (note: string, toast: string): ApprovalShown => ({
  closes: true,
  kind: 'approved',
  note,
  toast,
})

/**
 * The streams the workbench listens to: one per work item and slot, the fixed repositories
 * and wizard streams, and `inbox`, which every release card reports on (their own stream
 * names are per delivery, so the tray could not subscribe to them).
 */
export function liveStreams(work: Array<{ id: string }>, slots: Array<{ label: string }>): string[] {
  return [
    ...work.map((item) => `work:${item.id}`),
    ...slots.map((slot) => `slot:${slot.label}`),
    'repositories',
    'wizard',
    'inbox',
  ]
}
