/**
 * Stage projection, plan §10: an open work item has exactly one stage, computed
 * from facts and never stored. A first-match table in the order the plan fixes —
 * the earlier row wins, so a held item stays "waiting on you (held)" even while a
 * question or confirmation is also open. Labels say whom the item waits for and
 * what it needs; the inbox and the chat use these, not state codes.
 */

export type WorkItemView = {
  state: string
  blockedReason?: string
  openQuestions: number
  awaitingConfirmation: boolean
  holdStatus: 'held' | 'free'
  integratedAll: boolean
  prState: string | 'none'
}

export type StageRow = { match: (w: WorkItemView) => boolean; stage: string }

export const STAGE_TABLE: readonly StageRow[] = [
  { match: (w) => w.holdStatus === 'held', stage: 'waiting on you (held)' },
  { match: (w) => w.openQuestions > 0, stage: 'waiting on you (question)' },
  { match: (w) => w.awaitingConfirmation, stage: 'waiting on you (confirmation)' },
  {
    match: (w) => w.state === 'blocked' && w.blockedReason === 'confirmation',
    stage: 'waiting on you (confirmation)',
  },
  { match: (w) => w.state === 'blocked', stage: 'blocked' },
  { match: (w) => w.state === 'integrating' && w.integratedAll, stage: 'awaiting merge' },
  { match: (w) => w.prState === 'ci_green', stage: 'ready to merge' },
  { match: (w) => w.prState === 'pr_open' || w.prState === 'ci_pending', stage: 'PR open' },
  { match: (w) => w.state === 'executing', stage: 'working' },
  { match: (w) => w.state === 'planning', stage: 'planning' },
  { match: (w) => w.state === 'done', stage: 'done' },
  { match: (w) => w.state === 'stopped', stage: 'stopped' },
]

export function stageOf(w: WorkItemView): string {
  return STAGE_TABLE.find((row) => row.match(w))?.stage ?? 'unknown'
}
