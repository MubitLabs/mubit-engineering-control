import { describe, expect, it } from 'vitest'
import {
  approvalMachine,
  attemptMachine,
  deliveryMachine,
  type Machine,
  planRevisionMachine,
  taskMachine,
} from '../src'

const machines = [
  deliveryMachine,
  planRevisionMachine,
  taskMachine,
  attemptMachine,
  approvalMachine,
] as Machine<string, string>[]

function run<S extends string, E extends string>(m: Machine<S, E>, from: S, events: E[]): S {
  let state = from
  for (const e of events) {
    const r = m.transition(state, e)
    if (!r.ok) throw new Error(r.error.message)
    state = r.value
  }
  return state
}

function edges(m: Machine<string, string>): string[] {
  const out: string[] = []
  for (const s of m.states) {
    for (const e of m.events) {
      const r = m.transition(s, e)
      if (r.ok) out.push(`${s} --${e}--> ${r.value}`)
    }
  }
  return out
}

describe.each(machines)('$name machine', (m) => {
  it('matches the reviewed transition table', () => {
    expect(edges(m)).toMatchSnapshot()
  })

  it('has no transitions out of terminal states', () => {
    for (const s of m.terminal) expect(m.allowedEvents(s)).toEqual([])
  })

  it('reaches every state from the initial state', () => {
    const seen = new Set([m.states[0]!])
    const queue = [m.states[0]!]
    while (queue.length > 0) {
      const s = queue.shift()!
      for (const e of m.allowedEvents(s)) {
        const r = m.transition(s, e)
        if (r.ok && !seen.has(r.value)) {
          seen.add(r.value)
          queue.push(r.value)
        }
      }
    }
    expect([...seen].sort()).toEqual([...m.states].sort())
  })

  it('rejects a transition outside the table with a descriptive error', () => {
    const from = m.terminal[0]!
    const event = m.events[0]!
    expect(m.transition(from, event)).toEqual({
      ok: false,
      error: {
        code: 'invalid_transition',
        machine: m.name,
        from,
        event,
        message: `${m.name}: cannot apply '${event}' in state '${from}'`,
      },
    })
  })
})

describe('normal progressions from PDF §11', () => {
  it('task: proposed to integrated', () => {
    expect(
      run(taskMachine, 'proposed', [
        'plan_approved',
        'dependencies_satisfied',
        'attempt_started',
        'attempt_succeeded',
        'review_accepted',
        'integrated',
      ]),
    ).toBe('integrated')
  })

  it('task: a send-back and a conflict both return to ready for a repair attempt', () => {
    expect(run(taskMachine, 'awaiting_review', ['review_sent_back'])).toBe('ready')
    expect(run(taskMachine, 'accepted', ['integration_conflict'])).toBe('ready')
  })

  it('task: exhausting attempts needs an explicit human retry', () => {
    expect(run(taskMachine, 'active', ['attempt_failed_final'])).toBe('failed')
    expect(run(taskMachine, 'failed', ['retry'])).toBe('ready')
  })

  it('attempt: queued to succeeded through a question', () => {
    expect(
      run(attemptMachine, 'queued', [
        'lease_granted',
        'runner_accepted',
        'agent_started',
        'input_requested',
        'input_resolved',
        'agent_finished',
        'checks_started',
        'checks_passed',
      ]),
    ).toBe('succeeded')
  })

  it('attempt: quota and auth waits preserve the attempt and resume under a new lease', () => {
    expect(run(attemptMachine, 'running', ['quota_exhausted', 'resume'])).toBe('leased')
    expect(run(attemptMachine, 'running', ['auth_expired', 'resume'])).toBe('leased')
  })

  it('attempt: lease expiry reconciles instead of replacing', () => {
    expect(run(attemptMachine, 'running', ['lease_expired'])).toBe('stalled')
    expect(attemptMachine.transition('stalled', 'resume').ok).toBe(false)
    expect(run(attemptMachine, 'stalled', ['runner_reconciled_stopped', 'resume'])).toBe('leased')
    expect(run(attemptMachine, 'stalled', ['runner_reconciled_running'])).toBe('running')
  })

  it('delivery: planning to merged, and a closed PR returns to integration', () => {
    expect(
      run(deliveryMachine, 'planning', [
        'plan_approved',
        'work_started',
        'integration_started',
        'pr_opened',
        'pr_merged',
      ]),
    ).toBe('merged')
    expect(run(deliveryMachine, 'awaiting_merge', ['pr_closed'])).toBe('integrating')
  })

  it('plan revision: an approved revision cannot be edited, only superseded', () => {
    expect(planRevisionMachine.transition('approved', 'edit').ok).toBe(false)
    expect(run(planRevisionMachine, 'approved', ['supersede'])).toBe('superseded')
  })
})
