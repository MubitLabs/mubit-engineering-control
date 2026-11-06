// CONTRACTS §6 on the store: a fact may not be refused, and state moves only through the machines.
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { StoreFacts } from '../src/core-facts'

const REF = { attempt_id: 'att_1', generation: 2 }
const HEAD = 'c'.repeat(40)

function rig(state: string, taskStatus = 'active', workState = 'executing') {
  const db = new Database(':memory:')
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  store.atomic(() => {
    store.workItems.save({ id: 'wi_1', state: workState })
    store.tasks.save({ id: 'task_1', workItemId: 'wi_1', status: taskStatus })
    store.attempts.save({ id: 'att_1', taskId: 'task_1', workItemId: 'wi_1', state, generation: 2 })
  })
  const facts = new StoreFacts(store, (_attemptId, value) => value)
  return { store, facts, state: () => store.attempts.get('att_1')?.state }
}

describe('StoreFacts', () => {
  it('walks a clean attempt, moving the task with it', () => {
    const { store, facts, state } = rig('queued', 'ready')
    facts.attemptStarted(REF, 2, 'session-1')
    expect(state()).toBe('running')
    expect(store.tasks.get('task_1')?.status).toBe('active')
    facts.workCompleted(REF, HEAD)
    expect(state()).toBe('work_complete')
    expect(store.tasks.get('task_1')?.status).toBe('awaiting_review')
    facts.checksFinished(
      REF,
      HEAD,
      [{ name: 'unit', status: 'passed', exitCode: 0, durationMs: 5, logTail: 'ok' }],
      true,
    )
    expect(state()).toBe('succeeded')
    expect(store.engines.get('check/att_1/unit')).toMatchObject({ status: 'passed', sha: HEAD })
  })

  it('a late session does not bring a stopped attempt back', () => {
    const { store, facts, state } = rig('interrupted', 'active')
    expect(() => facts.attemptStarted(REF, 2, 'session-1')).not.toThrow()
    expect(state()).toBe('interrupted')
    expect(store.attempts.get('att_1')?.session_id).toBeUndefined()
  })

  it('a fact from an older generation moves nothing', () => {
    const { facts, state } = rig('running')
    facts.attemptFailed({ attempt_id: 'att_1', generation: 1 }, 'late')
    facts.workCompleted({ attempt_id: 'att_1', generation: 1 }, HEAD)
    expect(state()).toBe('running')
  })

  it('a failed attempt gives its task back and blocks its work with the reason', () => {
    const { store, facts, state } = rig('running')
    facts.attemptFailed(REF, 'engine_crashed')
    expect(state()).toBe('failed')
    expect(store.attempts.get('att_1')?.terminal_reason).toBe('engine_crashed')
    expect(store.tasks.get('task_1')?.status).toBe('ready')
    expect(store.workItems.get('wi_1')).toMatchObject({
      state: 'blocked',
      blockedReason: 'engine_crashed',
    })
  })

  it('failed work stays as it was when it had already stopped', () => {
    const { store, facts } = rig('running', 'active', 'stopped')
    facts.attemptFailed(REF, 'engine_crashed')
    expect(store.workItems.get('wi_1')?.state).toBe('stopped')
  })

  it('parks through the machine, and only from running', () => {
    const parked = rig('running')
    parked.facts.attemptParked(REF, 'quota_wait', 'window')
    expect(parked.state()).toBe('quota_wait')
    const done = rig('work_complete')
    done.facts.attemptParked(REF, 'auth_required', 'late')
    expect(done.state()).toBe('work_complete')
  })

  it('interrupts once, and records it once', () => {
    const { store, facts, state } = rig('running')
    facts.attemptInterrupted(REF, 'wall_clock')
    facts.attemptInterrupted(REF, 'stop_requested')
    expect(state()).toBe('interrupted')
    expect(store.attempts.get('att_1')?.terminal_reason).toBe('wall_clock')
    const types = store.events.read('attempt:att_1').map((event) => event.type)
    expect(types.filter((type) => type === 'attempt.interrupted')).toHaveLength(1)
  })

  it('numbers reports and runs them through the cleaner', () => {
    const db = new Database(':memory:')
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    store.atomic(() => store.attempts.save({ id: 'att_1', state: 'running', generation: 2 }))
    const facts = new StoreFacts(store, <T>(_attemptId: string, value: T): T => {
      const report = value as { summary: string }
      return { ...report, summary: report.summary.replace('secret', '[redacted]') } as T
    })
    expect(facts.reportReceived(REF, 2, { kind: 'progress', summary: 'one secret' })).toBe(1)
    expect(facts.reportReceived(REF, 2, { kind: 'ready', summary: 'two', head_sha: HEAD }, HEAD)).toBe(2)
    expect(store.engines.get('report/att_1/1')?.report).toMatchObject({ summary: 'one [redacted]' })
    expect(store.engines.get('report/att_1/2')).toMatchObject({ head_matches: true, observed_head: HEAD })
    expect(JSON.stringify(store.events.read('attempt:att_1'))).not.toContain('secret')
  })
})
