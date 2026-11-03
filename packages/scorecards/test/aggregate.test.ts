import type { EngineEvent, EngineEventBody } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import type { AttemptOutcome } from '../src'
import { summariseByRole, utilisationLedger } from '../src'

function env(body: EngineEventBody, seq: number, at: string, attemptId = 'att_1'): EngineEvent {
  return { ...body, seq, at, attempt_id: attemptId, generation: 0 }
}

const T0 = Date.parse('2026-11-03T09:00:00.000Z')
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function outcome(
  overrides: Partial<AttemptOutcome> & Pick<AttemptOutcome, 'role' | 'result'>,
): AttemptOutcome {
  return {
    attemptId: 'att_1',
    turns: 1,
    durationMs: 1_000,
    inputTokens: 100,
    outputTokens: 100,
    costUsd: 'unknown',
    permissionRequests: 0,
    quotaParks: 0,
    errors: 0,
    coverage: { lifecycle: true, usage: true, rateLimit: false },
    ...overrides,
  }
}

describe('summariseByRole', () => {
  it('rolls up per role, averaging known costs only (unknown leaves the divisor)', () => {
    const outcomes: readonly AttemptOutcome[] = [
      outcome({ role: 'implementer', result: 'completed', costUsd: 0.25, turns: 2 }),
      outcome({ role: 'implementer', result: 'completed', costUsd: 0.75, turns: 3, quotaParks: 1 }),
      outcome({ role: 'implementer', result: 'api_error', costUsd: 'unknown', turns: 1, quotaParks: 2 }),
      outcome({ role: 'reviewer', result: 'completed', costUsd: 'unknown', turns: 4 }),
    ]
    expect(summariseByRole(outcomes)).toEqual([
      {
        role: 'implementer',
        attempts: 3,
        completed: 2,
        failed: 1, // not known to have completed counts as failed
        quotaParks: 3,
        avgCostUsd: 0.5, // (0.25 + 0.75) / 2 — the unknown cost left the divisor
        messagesSent: 6, // Σ turns: one assistant message per finished turn
      },
      {
        role: 'reviewer',
        attempts: 1,
        completed: 1,
        failed: 0,
        quotaParks: 0,
        avgCostUsd: 'unknown',
        messagesSent: 4,
      },
    ])
  })

  it('groups outcomes the attempt row could not decorate under unknown', () => {
    const outcomes: readonly AttemptOutcome[] = [
      outcome({ role: undefined, result: 'completed', costUsd: 1 }),
      outcome({ role: undefined, result: 'crashed' }),
    ]
    expect(summariseByRole(outcomes)).toEqual([
      {
        role: 'unknown',
        attempts: 2,
        completed: 1,
        failed: 1,
        quotaParks: 0,
        avgCostUsd: 1,
        messagesSent: 2,
      },
    ])
  })

  it('returns an empty rollup for no outcomes', () => {
    expect(summariseByRole([])).toEqual([])
  })
})

describe('utilisationLedger', () => {
  it('takes each window to the max utilization it reported, keeping unknown readings unknown', () => {
    const events: readonly EngineEvent[] = [
      env(
        {
          type: 'rate_limit',
          window: 'five_hour',
          status: 'allowed',
          utilization: 0.23,
          resets_at: '2026-11-03T13:40:00.000Z',
        },
        1,
        at(0),
      ),
      env(
        {
          type: 'rate_limit',
          window: 'seven_day',
          status: 'rejected',
          resets_at: 'unknown',
        },
        2,
        at(1_000),
        'att_2',
      ),
      env(
        {
          type: 'rate_limit',
          window: 'five_hour',
          status: 'warning',
          utilization: 0.71,
          resets_at: '2026-11-03T13:40:00.000Z',
        },
        3,
        at(2_000),
      ),
    ]
    expect(utilisationLedger(events)).toEqual([
      {
        window: 'five_hour',
        utilizationMax: 0.71,
        resetsAtLast: '2026-11-03T13:40:00.000Z',
      },
      { window: 'seven_day', utilizationMax: 'unknown' }, // events but no reading: unknown, not 0
    ])
  })

  it('keeps the last concrete reset time and drops unknown ones', () => {
    const events: readonly EngineEvent[] = [
      env(
        {
          type: 'rate_limit',
          window: 'five_hour',
          status: 'allowed',
          resets_at: '2026-11-03T13:40:00.000Z',
        },
        1,
        at(0),
      ),
      env(
        { type: 'rate_limit', window: 'five_hour', status: 'rejected', resets_at: 'unknown' },
        2,
        at(1_000),
      ),
      env(
        {
          type: 'rate_limit',
          window: 'five_hour',
          status: 'rejected',
          resets_at: '2026-11-03T18:40:00.000Z',
        },
        3,
        at(2_000),
      ),
    ]
    expect(utilisationLedger(events)).toEqual([
      { window: 'five_hour', utilizationMax: 'unknown', resetsAtLast: '2026-11-03T18:40:00.000Z' },
    ])
  })

  it('returns an empty ledger when no rate_limit event was surfaced', () => {
    const events: readonly EngineEvent[] = [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
        1,
        at(0),
      ),
      env({ type: 'exit', code: 0, terminal_reason: 'completed' }, 2, at(1_000)),
    ]
    expect(utilisationLedger(events)).toEqual([])
  })
})
