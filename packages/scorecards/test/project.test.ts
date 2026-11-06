import type { EngineEvent, EngineEventBody, Window } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { projectAttempt } from '../src'

/** Envelope the way the replayer does (contracts §1): seq in order, one `at`, one attempt. */
function env(body: EngineEventBody, seq: number, at: string, attemptId = 'att_1'): EngineEvent {
  return { ...body, seq, at, attempt_id: attemptId, generation: 0 }
}

const T0 = Date.parse('2026-11-03T09:00:00.000Z')
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function happyPath(): EngineEvent[] {
  return [
    env(
      { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
      1,
      at(0),
    ),
    env({ type: 'message', role: 'assistant', text: 'On it.' }, 2, at(10_000)),
    env({ type: 'tool_call', tool: 'Read', input: { path: '/repo/src/index.ts' } }, 3, at(15_000)),
    env({ type: 'usage', input_tokens: 2, output_tokens: 16, cost_usd: 0.06 }, 4, at(30_000)),
    env(
      {
        type: 'rate_limit',
        window: 'five_hour',
        status: 'allowed',
        utilization: 0.23,
        resets_at: '2026-11-03T13:40:00.000Z',
      },
      5,
      at(31_000),
    ),
    env({ type: 'exit', code: 0, terminal_reason: 'completed' }, 6, at(90_000)),
  ]
}

describe('projectAttempt — happy path', () => {
  it('projects turns, duration, tokens, cost, result and coverage from the synthetic sequence', () => {
    expect(projectAttempt('att_1', happyPath())).toEqual({
      attemptId: 'att_1',
      engine: 'claude',
      turns: 1, // one usage event — one completed turn
      durationMs: 90_000,
      inputTokens: 2,
      outputTokens: 16,
      costUsd: 0.06,
      result: 'completed',
      permissionRequests: 0,
      quotaParks: 0,
      errors: 0,
      coverage: { lifecycle: true, usage: true, rateLimit: true },
      resolvedModel: null, // no runtime resolution and no session_started echo
      tierDegraded: null,
      spend: 0.06, // cumulative default: the last usage reading is the total
      spendCoverage: 'total',
      validation: 'unknown', // a clean exit is not validation evidence
      delivery: 'unknown',
      utilisationDelta: null, // one five_hour reading — no genuine pair, never a fake 0
    })
  })
})

describe('projectAttempt — crash', () => {
  const crash = (exitAt: string) => [
    env(
      { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
      1,
      at(0),
    ),
    env({ type: 'exit', code: 137, terminal_reason: 'crashed' }, 2, exitAt),
  ]

  it('an immediate crash: duration unknown, tokens unknown (not 0), usage not covered', () => {
    const outcome = projectAttempt('att_1', crash(at(0)))
    expect(outcome.durationMs).toBe('unknown')
    expect(outcome.inputTokens).toBe('unknown')
    expect(outcome.outputTokens).toBe('unknown')
    expect(outcome.costUsd).toBe('unknown')
    expect(outcome.coverage.usage).toBe(false)
    expect(outcome.result).toBe('crashed')
    expect(outcome.coverage.lifecycle).toBe(true)
  })

  it('a crash the supervisor saw later still measures the span it observed', () => {
    expect(projectAttempt('att_1', crash(at(1500))).durationMs).toBe(1500)
  })
})

describe('projectAttempt — quota', () => {
  it('counts only rejected rate_limit events as quota parks', () => {
    const events = [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
        1,
        at(0),
      ),
      env({ type: 'usage', input_tokens: 2, output_tokens: 16, cost_usd: 0.06 }, 2, at(5_000)),
      env({ type: 'rate_limit', window: 'five_hour', status: 'allowed', utilization: 0.23 }, 3, at(6_000)),
      env(
        {
          type: 'rate_limit',
          window: 'five_hour',
          status: 'rejected',
          resets_at: '2026-11-03T13:40:00.000Z',
        },
        4,
        at(7_000),
      ),
      env({ type: 'exit', code: 1, terminal_reason: 'aborted' }, 5, at(8_000)),
    ]
    const outcome = projectAttempt('att_1', events)
    expect(outcome.quotaParks).toBe(1)
    expect(outcome.result).toBe('aborted')
    expect(outcome.coverage.rateLimit).toBe(true)
  })
})

describe('projectAttempt — turns', () => {
  it('falls back to assistant messages when the adapter surfaced no usage', () => {
    const events = [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'codex', engine_version: '0.66.0' },
        1,
        at(0),
      ),
      env({ type: 'message', role: 'assistant', text: 'First turn.' }, 2, at(1_000)),
      env({ type: 'message', role: 'user', text: 'And then?' }, 3, at(2_000)),
      env({ type: 'message', role: 'assistant', text: 'Second turn.' }, 4, at(3_000)),
      env({ type: 'message', role: 'assistant', text: 'Third turn.' }, 5, at(4_000)),
      env({ type: 'exit', code: 0, terminal_reason: 'completed' }, 6, at(5_000)),
    ]
    const outcome = projectAttempt('att_1', events)
    expect(outcome.turns).toBe(3)
    expect(outcome.inputTokens).toBe('unknown')
    expect(outcome.coverage.usage).toBe(false)
  })

  it('takes tokens and cost from the last usage event (cumulative usage_mode)', () => {
    const events = [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
        1,
        at(0),
      ),
      env({ type: 'usage', input_tokens: 2, output_tokens: 16, cost_usd: 0.06 }, 2, at(1_000)),
      env({ type: 'usage', input_tokens: 10, output_tokens: 40, cost_usd: 0.25 }, 3, at(2_000)),
      env({ type: 'exit', code: 0, terminal_reason: 'completed' }, 4, at(3_000)),
    ]
    const outcome = projectAttempt('att_1', events)
    expect(outcome.turns).toBe(2)
    expect(outcome.inputTokens).toBe(10)
    expect(outcome.outputTokens).toBe(40)
    expect(outcome.costUsd).toBe(0.25)
  })

  it('keeps cost unknown when the engine reported tokens but no cost', () => {
    const events = [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'opencode', engine_version: '2.2.5' },
        1,
        at(0),
      ),
      env({ type: 'usage', input_tokens: 5, output_tokens: 7 }, 2, at(1_000)),
      env({ type: 'exit', code: 0, terminal_reason: 'completed' }, 3, at(2_000)),
    ]
    const outcome = projectAttempt('att_1', events)
    expect(outcome.inputTokens).toBe(5)
    expect(outcome.costUsd).toBe('unknown')
  })
})

describe('projectAttempt — incomplete and foreign facts', () => {
  it('a stream with no exit is result unknown and lifecycle not covered', () => {
    const events = [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
        1,
        at(0),
      ),
      env({ type: 'message', role: 'assistant', text: 'Working…' }, 2, at(1_000)),
    ]
    const outcome = projectAttempt('att_1', events)
    expect(outcome.result).toBe('unknown')
    expect(outcome.coverage.lifecycle).toBe(false)
    expect(outcome.durationMs).toBe(1000)
  })

  it('borrows nothing from another attempt in the same log', () => {
    const own = [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
        1,
        at(0),
      ),
    ]
    const foreign = [
      env({ type: 'usage', input_tokens: 99, output_tokens: 99, cost_usd: 9 }, 2, at(1_000), 'att_2'),
      env({ type: 'exit', code: 0, terminal_reason: 'completed' }, 3, at(2_000), 'att_2'),
    ]
    const outcome = projectAttempt('att_1', [...own, ...foreign])
    expect(outcome.inputTokens).toBe('unknown')
    expect(outcome.result).toBe('unknown')

    const other = projectAttempt('att_2', [...own, ...foreign])
    expect(other.attemptId).toBe('att_2')
    expect(other.inputTokens).toBe(99)
    expect(other.result).toBe('completed')
  })

  it('counts permission requests and error events', () => {
    const events = [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
        1,
        at(0),
      ),
      env(
        {
          type: 'permission_request',
          request_id: 'pr_1',
          operation: { kind: 'shell', summary: 'pnpm test', command: ['pnpm', 'test'] },
          evidence: { raw: null, worktree: '/repo/work/a1' },
        },
        2,
        at(1_000),
      ),
      env({ type: 'permission_result', request_id: 'pr_1', decision: 'allow' }, 3, at(2_000)),
      env({ type: 'error', class: 'provider_down', detail: 'overloaded' }, 4, at(3_000)),
      env({ type: 'exit', code: 0, terminal_reason: 'completed' }, 5, at(4_000)),
    ]
    const outcome = projectAttempt('att_1', events)
    expect(outcome.permissionRequests).toBe(1)
    expect(outcome.errors).toBe(1)
  })
})

describe('projectAttempt — tier context', () => {
  it('carries the tier-era facts the stream does not hold onto the row', () => {
    const outcome = projectAttempt('att_1', happyPath(), {
      tier: 'strong',
      resolvedModel: { id: 'opus', effort: 'high' },
      tierDegraded: 'strong→balanced (provider has no strong)',
      repository: 'mec',
      taskId: 'task_9',
      reviewFindings: 2,
    })
    expect(outcome.tier).toBe('strong')
    expect(outcome.resolvedModel).toEqual({ id: 'opus', effort: 'high' })
    expect(outcome.tierDegraded).toBe('strong→balanced (provider has no strong)')
    expect(outcome.repository).toBe('mec')
    expect(outcome.taskId).toBe('task_9')
    expect(outcome.reviewFindings).toBe(2)
  })

  it('an explicit-model ask carries no tier, and no degradation reads null', () => {
    const outcome = projectAttempt('att_1', happyPath(), {
      resolvedModel: { id: 'glm-5.3', variant: 'max' },
    })
    expect(outcome.tier).toBeUndefined()
    expect(outcome.resolvedModel).toEqual({ id: 'glm-5.3', variant: 'max' })
    expect(outcome.tierDegraded).toBeNull()
  })

  it("falls back to the engine's own session_started echo when the runtime resolution is absent", () => {
    const events = [
      env(
        {
          type: 'session_started',
          session_id: 's_1',
          engine: 'claude',
          engine_version: '2.1.317',
          model: 'opus',
        },
        1,
        at(0),
      ),
      env({ type: 'exit', code: 0, terminal_reason: 'completed' }, 2, at(1_000)),
    ]
    expect(projectAttempt('att_1', events).resolvedModel).toEqual({ id: 'opus' })
    expect(projectAttempt('att_1', events, { resolvedModel: { id: 'sonnet' } }).resolvedModel).toEqual({
      id: 'sonnet',
    })
  })
})

describe('projectAttempt — spend', () => {
  const spent = (usages: { cost_usd?: number | 'unknown' }[], usageMode?: 'cumulative' | 'delta' | 'none') =>
    projectAttempt(
      'att_1',
      [
        env(
          { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
          1,
          at(0),
        ),
        ...usages.map((usage, index) =>
          env(
            { type: 'usage', input_tokens: 2, output_tokens: 16, cost_usd: usage.cost_usd },
            index + 2,
            at((index + 1) * 1_000),
          ),
        ),
        env({ type: 'exit', code: 0, terminal_reason: 'completed' }, usages.length + 2, at(10_000)),
      ],
      usageMode === undefined ? {} : { usageMode },
    ).spend

  it('cumulative mode (the default) reads the freshest running total', () => {
    expect(spent([{ cost_usd: 0.06 }, { cost_usd: 0.25 }, { cost_usd: 0.1 }])).toBe(0.1)
  })

  it('delta mode sums per-turn spend, and none stays unknown', () => {
    expect(spent([{ cost_usd: 0.06 }, { cost_usd: 0.25 }, { cost_usd: 0.1 }], 'delta')).toBeCloseTo(0.41, 10)
    expect(spent([{ cost_usd: 0.25 }], 'none')).toBe('unknown')
  })

  it('keeps spend unknown when no usage event reported a cost', () => {
    expect(spent([{ cost_usd: undefined }, { cost_usd: 'unknown' }])).toBe('unknown')
    expect(spent([])).toBe('unknown')
  })
})

describe('projectAttempt — utilisation delta', () => {
  const delta = (readings: { window: Window; utilization?: number }[]) =>
    projectAttempt('att_1', [
      env(
        { type: 'session_started', session_id: 's_1', engine: 'claude', engine_version: '2.1.317' },
        1,
        at(0),
      ),
      ...readings.map((reading, index) =>
        env(
          {
            type: 'rate_limit',
            window: reading.window,
            status: 'allowed',
            utilization: reading.utilization,
          },
          index + 2,
          at((index + 1) * 1_000),
        ),
      ),
      env({ type: 'exit', code: 0, terminal_reason: 'completed' }, readings.length + 2, at(10_000)),
    ]).utilisationDelta

  it('reads last − before from a genuine pair; a lone reading never fakes a 0', () => {
    expect(
      delta([
        { window: 'five_hour', utilization: 0.23 },
        { window: 'five_hour', utilization: 0.71 },
      ]),
    ).toBeCloseTo(0.48, 10)
    expect(
      delta([
        { window: 'five_hour', utilization: 0.23 },
        { window: 'five_hour', utilization: 0.23 },
      ]),
    ).toBe(0) // a real pair may read 0
    expect(delta([{ window: 'five_hour', utilization: 0.23 }])).toBeNull()
    expect(delta([])).toBeNull()
  })

  it("keeps a window reset's real negative", () => {
    expect(
      delta([
        { window: 'five_hour', utilization: 0.8 },
        { window: 'five_hour', utilization: 0.05 },
      ]),
    ).toBeCloseTo(-0.75, 10)
  })

  it('takes the first window in stream order that reported a genuine pair', () => {
    expect(
      delta([
        { window: 'five_hour', utilization: 0.23 }, // lone reading — no pair
        { window: 'seven_day', utilization: 0.4 },
        { window: 'seven_day', utilization: 0.6 },
      ]),
    ).toBeCloseTo(0.2, 10)
  })
})
