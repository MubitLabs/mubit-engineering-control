import { describe, expect, it } from 'vitest'
import type { TransitionTable } from '../src'
import {
  ATTEMPT_MACHINE,
  ATTEMPT_TERMINAL,
  CONFIRMATION_MACHINE,
  CONFIRMATION_TERMINAL,
  canTransition,
  TASK_MACHINE,
  TASK_TERMINAL,
  transition,
  WORK_ITEM_MACHINE,
  WORK_ITEM_TERMINAL,
} from '../src'

/** The whole machine as sorted `from --event--> to` strings; reviewed like a snapshot. */
const edges = (table: TransitionTable): string[] =>
  table.map((row) => `${row.from} --${row.event}--> ${row.to}`).sort()

describe('work item machine', () => {
  it('matches the reviewed transition table', () => {
    expect(edges(WORK_ITEM_MACHINE)).toEqual([
      'admitted --planning_started--> planning',
      'admitted --stop--> stopped',
      'blocked --resume_executing--> executing',
      'blocked --resume_integrating--> integrating',
      'blocked --resume_planning--> planning',
      'blocked --resume_reviewing--> reviewing',
      'blocked --stop--> stopped',
      'executing --block--> blocked',
      'executing --review_started--> reviewing',
      'executing --stop--> stopped',
      'integrating --block--> blocked',
      'integrating --stop--> stopped',
      'integrating --work_done--> done',
      'planning --block--> blocked',
      'planning --execution_started--> executing',
      'planning --stop--> stopped',
      'proposed --admit--> admitted',
      'proposed --stop--> stopped',
      'reviewing --block--> blocked',
      'reviewing --integration_started--> integrating',
      'reviewing --stop--> stopped',
    ])
  })

  it('allows the documented transitions', () => {
    expect(canTransition(WORK_ITEM_MACHINE, 'proposed', 'admit')).toBe(true)
    expect(canTransition(WORK_ITEM_MACHINE, 'integrating', 'work_done')).toBe(true)
    expect(canTransition(WORK_ITEM_MACHINE, 'blocked', 'resume_integrating')).toBe(true)
  })

  it('rejects transitions outside the table', () => {
    expect(canTransition(WORK_ITEM_MACHINE, 'done', 'admit')).toBe(false)
    expect(canTransition(WORK_ITEM_MACHINE, 'proposed', 'work_done')).toBe(false)
    expect(canTransition(WORK_ITEM_MACHINE, 'executing', 'resume_executing')).toBe(false)
  })

  it('applies a transition and names from and event when refusing', () => {
    expect(transition(WORK_ITEM_MACHINE, 'proposed', 'admit')).toBe('admitted')
    expect(transition(WORK_ITEM_MACHINE, 'blocked', 'resume_planning')).toBe('planning')
    expect(() => transition(WORK_ITEM_MACHINE, 'done', 'admit')).toThrowError(
      "cannot apply 'admit' in state 'done'",
    )
  })
})

describe('task machine', () => {
  it('matches the reviewed transition table', () => {
    expect(edges(TASK_MACHINE)).toEqual([
      'accepted --block--> blocked',
      'accepted --cancel--> cancelled',
      'accepted --integrated--> integrated',
      'accepted --integration_conflict--> ready',
      'active --attempt_failed--> ready',
      'active --block--> blocked',
      'active --cancel--> cancelled',
      'active --work_complete--> awaiting_review',
      'awaiting_review --block--> blocked',
      'awaiting_review --cancel--> cancelled',
      'awaiting_review --review_accepted--> accepted',
      'awaiting_review --review_sent_back--> ready',
      'blocked --cancel--> cancelled',
      'blocked --unblock--> ready',
      'ready --attempt_started--> active',
      'ready --block--> blocked',
      'ready --cancel--> cancelled',
    ])
  })

  it('allows the documented transitions', () => {
    expect(canTransition(TASK_MACHINE, 'ready', 'attempt_started')).toBe(true)
    expect(canTransition(TASK_MACHINE, 'awaiting_review', 'review_sent_back')).toBe(true)
    expect(canTransition(TASK_MACHINE, 'accepted', 'integrated')).toBe(true)
  })

  it('rejects transitions outside the table', () => {
    expect(canTransition(TASK_MACHINE, 'integrated', 'retry')).toBe(false)
    expect(canTransition(TASK_MACHINE, 'ready', 'integrated')).toBe(false)
    expect(canTransition(TASK_MACHINE, 'cancelled', 'unblock')).toBe(false)
  })

  it('applies a transition and names from and event when refusing', () => {
    expect(transition(TASK_MACHINE, 'accepted', 'integrated')).toBe('integrated')
    expect(transition(TASK_MACHINE, 'accepted', 'integration_conflict')).toBe('ready')
    expect(() => transition(TASK_MACHINE, 'ready', 'integrated')).toThrowError(
      "cannot apply 'integrated' in state 'ready'",
    )
  })
})

describe('attempt machine', () => {
  it('matches the reviewed transition table', () => {
    expect(edges(ATTEMPT_MACHINE)).toEqual([
      'auth_required --resume--> running',
      'interrupted --resume--> running',
      'provider_down --resume--> running',
      'queued --agent_started--> running',
      'queued --attempt_failed--> failed',
      'queued --interrupt_confirmed--> interrupted',
      'quota_wait --resume--> running',
      'running --agent_finished--> work_complete',
      'running --attempt_failed--> failed',
      'running --auth_expired--> auth_required',
      'running --interrupt_confirmed--> interrupted',
      'running --provider_unreachable--> provider_down',
      'running --quota_exhausted--> quota_wait',
      'running --stall_detected--> stalled',
      'stalled --reconciled_running--> running',
      'stalled --reconciled_stopped--> interrupted',
      'work_complete --checks_failed--> checks_failed',
      'work_complete --checks_passed--> succeeded',
    ])
  })

  it('allows the documented transitions', () => {
    expect(canTransition(ATTEMPT_MACHINE, 'queued', 'agent_started')).toBe(true)
    expect(canTransition(ATTEMPT_MACHINE, 'work_complete', 'checks_failed')).toBe(true)
    expect(canTransition(ATTEMPT_MACHINE, 'stalled', 'reconciled_stopped')).toBe(true)
  })

  it('rejects transitions outside the table', () => {
    expect(canTransition(ATTEMPT_MACHINE, 'succeeded', 'resume')).toBe(false)
    expect(canTransition(ATTEMPT_MACHINE, 'queued', 'agent_finished')).toBe(false)
    expect(canTransition(ATTEMPT_MACHINE, 'quota_wait', 'reconciled_running')).toBe(false)
    expect(canTransition(ATTEMPT_MACHINE, 'failed', 'resume')).toBe(false)
    expect(ATTEMPT_TERMINAL).toContain('failed')
  })

  it('applies a transition and names from and event when refusing', () => {
    expect(transition(ATTEMPT_MACHINE, 'queued', 'agent_started')).toBe('running')
    expect(transition(ATTEMPT_MACHINE, 'stalled', 'reconciled_stopped')).toBe('interrupted')
    expect(() => transition(ATTEMPT_MACHINE, 'queued', 'agent_finished')).toThrowError(
      "cannot apply 'agent_finished' in state 'queued'",
    )
  })
})

describe('confirmation machine', () => {
  it('matches the reviewed transition table', () => {
    expect(edges(CONFIRMATION_MACHINE)).toEqual([
      'pending --approve--> approved',
      'pending --deny--> denied',
      'pending --expire--> expired',
      'pending --invalidate--> stale',
    ])
  })

  it('allows the documented transitions', () => {
    expect(canTransition(CONFIRMATION_MACHINE, 'pending', 'approve')).toBe(true)
    expect(canTransition(CONFIRMATION_MACHINE, 'pending', 'deny')).toBe(true)
    expect(canTransition(CONFIRMATION_MACHINE, 'pending', 'invalidate')).toBe(true)
  })

  it('rejects transitions outside the table', () => {
    expect(canTransition(CONFIRMATION_MACHINE, 'approved', 'approve')).toBe(false)
    expect(canTransition(CONFIRMATION_MACHINE, 'denied', 'deny')).toBe(false)
    expect(canTransition(CONFIRMATION_MACHINE, 'stale', 'expire')).toBe(false)
  })

  it('applies a transition and names from and event when refusing', () => {
    expect(transition(CONFIRMATION_MACHINE, 'pending', 'invalidate')).toBe('stale')
    expect(transition(CONFIRMATION_MACHINE, 'pending', 'expire')).toBe('expired')
    expect(() => transition(CONFIRMATION_MACHINE, 'approved', 'approve')).toThrowError(
      "cannot apply 'approve' in state 'approved'",
    )
  })
})

describe('machine discipline', () => {
  it('has no transitions out of terminal states', () => {
    const machines: readonly { name: string; table: TransitionTable; terminal: readonly string[] }[] = [
      { name: 'work item', table: WORK_ITEM_MACHINE, terminal: WORK_ITEM_TERMINAL },
      { name: 'task', table: TASK_MACHINE, terminal: TASK_TERMINAL },
      { name: 'attempt', table: ATTEMPT_MACHINE, terminal: ATTEMPT_TERMINAL },
      { name: 'confirmation', table: CONFIRMATION_MACHINE, terminal: CONFIRMATION_TERMINAL },
    ]
    for (const machine of machines) {
      for (const row of machine.table) {
        expect(machine.terminal, `${machine.name}: ${row.from} --${row.event}--> ${row.to}`).not.toContain(
          row.from,
        )
      }
    }
  })
})
