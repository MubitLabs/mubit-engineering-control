import type { EngineEvent, EngineEventBody } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import type { AttemptOutcome } from '../src'
import { projectAttempt, projectTiers, summariseByRole } from '../src'

/** Accounting (§19): process, validation and delivery are three facts, and a subtotal says so. */

const AT = '2026-11-03T09:00:00.000Z'
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)

let nextSeq = 0
function env(body: EngineEventBody, seq = ++nextSeq, generation = 1): EngineEvent {
  return { ...body, seq, at: AT, attempt_id: 'att_1', generation }
}
const usage = (cost: number | undefined, seq?: number, tokens = 10): EngineEvent =>
  env(
    {
      type: 'usage',
      input_tokens: tokens,
      output_tokens: tokens,
      ...(cost !== undefined && { cost_usd: cost }),
    },
    seq,
  )
const exit = (): EngineEvent => env({ type: 'exit', code: 0, terminal_reason: 'completed' })

describe('process, validation and delivery are separate', () => {
  it('clean exit plus failed check is not delivered', () => {
    const outcome = projectAttempt('att_1', [exit()], {
      head: HEAD,
      checks: [{ name: 'unit', status: 'failed', sha: HEAD }],
      deliveryStage: 'merged',
    })
    expect(outcome.result).toBe('completed')
    expect(outcome.validation).toBe('failed')
    expect(outcome.delivery).toBe('not-delivered')
  })

  it('a clean exit with nothing else recorded is unknown, never delivered', () => {
    const outcome = projectAttempt('att_1', [exit()])
    expect(outcome.result).toBe('completed')
    expect(outcome.validation).toBe('unknown')
    expect(outcome.delivery).toBe('unknown')
  })

  it('passed checks on the exact head and a ready PR are delivered', () => {
    const outcome = projectAttempt('att_1', [exit()], {
      head: HEAD,
      checks: [{ name: 'unit', status: 'passed', sha: HEAD }],
      deliveryStage: 'ready',
    })
    expect(outcome.validation).toBe('passed')
    expect(outcome.delivery).toBe('delivered')
  })

  it('passed checks and a local result are not delivered yet', () => {
    const outcome = projectAttempt('att_1', [exit()], {
      head: HEAD,
      checks: [{ name: 'unit', status: 'passed', sha: HEAD }],
      deliveryStage: 'local_complete',
    })
    expect(outcome.delivery).toBe('not-delivered')
  })

  it('stale check SHA does not count', () => {
    const outcome = projectAttempt('att_1', [exit()], {
      head: HEAD,
      checks: [{ name: 'unit', status: 'passed', sha: OLD }],
      deliveryStage: 'merged',
    })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.delivery).toBe('unknown')
  })

  it('a check that errored is a failed validation', () => {
    const outcome = projectAttempt('att_1', [exit()], {
      head: HEAD,
      checks: [{ name: 'unit', status: 'error', sha: HEAD }],
    })
    expect(outcome.validation).toBe('failed')
  })
})

describe('cost is one mode-aware calculation', () => {
  it('delta mode sums, in costUsd and spend alike', () => {
    const outcome = projectAttempt('att_1', [usage(0.5), usage(0.25)], { usageMode: 'delta' })
    expect(outcome.costUsd).toBe(0.75)
    expect(outcome.spend).toBe(0.75)
    expect(outcome.spendCoverage).toBe('total')
  })

  it('delta tokens are summed too', () => {
    const outcome = projectAttempt('att_1', [usage(0.5, undefined, 3), usage(0.25, undefined, 4)], {
      usageMode: 'delta',
    })
    expect(outcome.inputTokens).toBe(7)
    expect(outcome.outputTokens).toBe(7)
  })

  it('partial delta usage is a labelled subtotal', () => {
    const outcome = projectAttempt('att_1', [usage(0.5), usage(undefined), usage(0.25)], {
      usageMode: 'delta',
    })
    expect(outcome.spend).toBe(0.75)
    expect(outcome.spendCoverage).toBe('subtotal')
  })

  it('a later cumulative reading with no cost is a subtotal', () => {
    const outcome = projectAttempt('att_1', [usage(0.5), usage(undefined)], { usageMode: 'cumulative' })
    expect(outcome.spend).toBe(0.5)
    expect(outcome.spendCoverage).toBe('subtotal')
  })

  it('no reported cost is unknown, never 0', () => {
    const outcome = projectAttempt('att_1', [usage(undefined)], { usageMode: 'delta' })
    expect(outcome.spend).toBe('unknown')
    expect(outcome.costUsd).toBe('unknown')
    expect(outcome.spendCoverage).toBe('unknown')
  })

  it('cumulative reset does not double count', () => {
    const outcome = projectAttempt('att_1', [usage(0.5), usage(0.75), usage(0.25), usage(0.5)], {
      usageMode: 'cumulative',
    })
    // Never the sum of the readings. The counter restarted, so the freshest reading is a floor.
    expect(outcome.spend).toBe(0.5)
    expect(outcome.costUsd).toBe(0.5)
    expect(outcome.spendCoverage).toBe('subtotal')
  })

  it('duplicate replay does not double count', () => {
    const outcome = projectAttempt('att_1', [usage(0.5, 7), usage(0.5, 7), usage(0.25, 8)], {
      usageMode: 'delta',
    })
    expect(outcome.spend).toBe(0.75)
    expect(outcome.turns).toBe(2)
  })

  it('the same seq in a later generation is a different event', () => {
    const first = env({ type: 'usage', input_tokens: 1, output_tokens: 1, cost_usd: 0.5 }, 1, 1)
    const second = env({ type: 'usage', input_tokens: 1, output_tokens: 1, cost_usd: 0.25 }, 1, 2)
    expect(projectAttempt('att_1', [first, second], { usageMode: 'delta' }).spend).toBe(0.75)
  })
})

describe('rollups read validation, not a clean exit', () => {
  const row = (overrides: Partial<AttemptOutcome>): AttemptOutcome => ({
    ...projectAttempt('att_1', []),
    role: 'implementer',
    tier: 'fast',
    repository: 'repo_a',
    ...overrides,
  })

  it('a role summary counts process completion under that name, and validation apart', () => {
    const [summary] = summariseByRole([
      row({ result: 'completed', validation: 'failed' }),
      row({ result: 'completed', validation: 'passed' }),
      row({ result: 'crashed' }),
    ])
    expect(summary).toMatchObject({ processCompleted: 2, processFailed: 1, validated: 1 })
  })

  it('a tier cell does not call a clean exit with failed checks a success', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row({ result: 'completed', validation: 'failed' })),
      ...Array.from({ length: 2 }, () => row({ result: 'completed', validation: 'passed' })),
    ]
    expect(projectTiers(rows)[0]?.successRate).toBe(0.4)
  })

  it('a tier cell with no validation on record has no success rate', () => {
    const rows = Array.from({ length: 5 }, () => row({ result: 'completed' }))
    expect(projectTiers(rows)[0]?.successRate).toBeNull()
  })
})
