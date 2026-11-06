import { describe, expect, it } from 'vitest'
import type { AttemptOutcome } from '../src'
import { hintsFor, MIN_TIER_CELL_ATTEMPTS, projectTiers } from '../src'

/** A tier-era row: everything the projection reads, decorated per test. */
function row(overrides: Partial<AttemptOutcome> & Pick<AttemptOutcome, 'role' | 'result'>): AttemptOutcome {
  return {
    attemptId: 'att_x',
    turns: 1,
    durationMs: 1_000,
    inputTokens: 100,
    outputTokens: 100,
    costUsd: 'unknown',
    resolvedModel: null,
    tierDegraded: null,
    spend: 'unknown',
    utilisationDelta: null,
    permissionRequests: 0,
    quotaParks: 0,
    errors: 0,
    coverage: { lifecycle: true, usage: true, rateLimit: false },
    ...overrides,
    // The success rate reads validation now (§19); here a row's checks went the way its exit did.
    spendCoverage: 'unknown',
    delivery: 'unknown',
    validation: overrides.result === 'completed' ? 'passed' : 'failed',
  }
}

/** `count` identical attempts — enough to pass the gate inside one cell. */
function uniform(
  count: number,
  overrides: Partial<AttemptOutcome> & Pick<AttemptOutcome, 'role'>,
): AttemptOutcome[] {
  return Array.from({ length: count }, (_, index) =>
    row({ attemptId: `att_${index}`, result: 'completed', ...overrides }),
  )
}

/**
 * The §5.5 seeded scenario — repo_a · code_reviewer · fast, five attempts:
 * 3 of 5 completed (0.6), 2 of 5 linked tasks saw a repair_agent (0.4), 4 reviews reported
 * findings 2/3/4/4 (3.25), wall-clocks 1–4 s plus one unknown (mean 2500), dyadic spends
 * 0.125/0.25/0.375/unknown/0.25 (mean exactly 0.25). `seededBalanced` is the counterpart cell
 * the ranking reads beside it.
 */
function seededFast(): AttemptOutcome[] {
  const results = ['completed', 'completed', 'completed', 'api_error', 'aborted'] as const
  const clocks = [1_000, 2_000, 3_000, 4_000, 'unknown'] as const
  const spends = [0.125, 0.25, 0.375, 'unknown', 0.25] as const
  const findings = [2, 3, 4, 4, undefined] as const
  return results.map((result, index) =>
    row({
      attemptId: `att_fast_${index}`,
      role: 'code_reviewer',
      result,
      tier: 'fast',
      repository: 'repo_a',
      taskId: `task_${index}`,
      durationMs: clocks[index],
      spend: spends[index],
      reviewFindings: findings[index],
    }),
  )
}

function seededRepairs(): AttemptOutcome[] {
  return [
    row({
      attemptId: 'att_repair_0',
      role: 'repair_agent',
      result: 'completed',
      tier: 'balanced',
      repository: 'repo_a',
      taskId: 'task_0',
    }),
    row({
      attemptId: 'att_repair_1',
      role: 'repair_agent',
      result: 'completed',
      tier: 'strong',
      repository: 'repo_a',
      taskId: 'task_1',
    }),
  ]
}

function seededBalanced(): AttemptOutcome[] {
  return uniform(5, {
    role: 'code_reviewer',
    tier: 'balanced',
    repository: 'repo_a',
    durationMs: 8_000,
    spend: 1,
  })
}

describe('projectTiers', () => {
  it('emits only the count until a cell holds MIN_TIER_CELL_ATTEMPTS attempts', () => {
    const rows = uniform(4, { role: 'implementer', tier: 'fast', repository: 'repo_a' })
    expect(projectTiers(rows)).toEqual([
      {
        repository: 'repo_a',
        role: 'implementer',
        tier: 'fast',
        attempts: 4,
        successRate: null,
        repairRate: null,
        reviewFindings: null,
        meanWallClockMs: null,
        meanCostUsd: null,
      },
    ])
    expect(MIN_TIER_CELL_ATTEMPTS).toBe(5)
  })

  it('computes the seeded cell: 0.6 success, 0.4 repair, 3.25 findings, 2500 ms, $0.25', () => {
    const cells = projectTiers([...seededFast(), ...seededRepairs()])
    expect(cells).toEqual([
      {
        repository: 'repo_a',
        role: 'code_reviewer',
        tier: 'fast',
        attempts: 5,
        successRate: 0.6,
        repairRate: 0.4,
        reviewFindings: 3.25,
        meanWallClockMs: 2_500,
        meanCostUsd: 0.25,
      },
      {
        repository: 'repo_a',
        role: 'repair_agent',
        tier: 'balanced',
        attempts: 1,
        successRate: null,
        repairRate: null,
        reviewFindings: null,
        meanWallClockMs: null,
        meanCostUsd: null,
      },
      {
        repository: 'repo_a',
        role: 'repair_agent',
        tier: 'strong',
        attempts: 1,
        successRate: null,
        repairRate: null,
        reviewFindings: null,
        meanWallClockMs: null,
        meanCostUsd: null,
      },
    ])
  })

  it('repair linkage: unlinked rows leave the divisor, and no linkage at all reads null', () => {
    const partial = [
      ...uniform(5, { role: 'implementer', tier: 'fast', repository: 'repo_l' }).map((each, index) =>
        row({ ...each, taskId: index < 3 ? `task_${index}` : undefined }),
      ),
      row({
        attemptId: 'att_repair_l',
        role: 'repair_agent',
        result: 'completed',
        tier: 'strong',
        repository: 'repo_l',
        taskId: 'task_1',
      }),
      ...uniform(5, { role: 'implementer', tier: 'fast', repository: 'repo_n' }),
    ]
    const cells = projectTiers(partial)
    const linked = cells.find((cell) => cell.repository === 'repo_l' && cell.role === 'implementer')
    const unlinked = cells.find((cell) => cell.repository === 'repo_n' && cell.role === 'implementer')
    expect(linked?.attempts).toBe(5)
    expect(linked?.repairRate).toBeCloseTo(1 / 3, 10) // 1 repaired of the 3 attempts a task linked
    expect(unlinked?.repairRate).toBeNull() // no linkage at all — never a fake 0
  })

  it('groups per repository × role × tier, bucketing roleless rows and skipping rows without a repository', () => {
    const rows = [
      row({ role: 'implementer', result: 'completed', repository: 'repo_a', tier: 'fast' }),
      row({ role: 'implementer', result: 'completed', repository: 'repo_b', tier: 'fast' }),
      row({ role: 'implementer', result: 'completed', repository: 'repo_a', tier: 'balanced' }),
      row({ role: undefined, result: 'completed', repository: 'repo_a', tier: 'fast' }),
      row({ role: 'implementer', result: 'completed', repository: 'repo_a', tier: undefined }),
      row({ role: 'implementer', result: 'completed' }), // no repository — cannot join
    ]
    expect(projectTiers(rows).map((cell) => [cell.repository, cell.role, cell.tier])).toEqual([
      ['repo_a', 'implementer', 'fast'],
      ['repo_a', 'implementer', 'balanced'],
      ['repo_a', 'implementer', undefined], // an explicit-model / pre-tier ask keeps its own cell
      ['repo_a', 'unknown', 'fast'],
      ['repo_b', 'implementer', 'fast'],
    ])
  })

  it('returns an empty projection for no rows, and hints stay unknown for an unseen repository', () => {
    expect(projectTiers([])).toEqual([])
    expect(hintsFor('repo_none', 'implementer', seededFast())).toEqual({
      known: false,
      reason: 'not_enough_data',
      attemptsSeen: 0,
      attemptsNeeded: 5,
    })
  })
})

describe('hintsFor', () => {
  it('below the threshold: not_enough_data with attemptsSeen and attemptsNeeded', () => {
    const rows = uniform(4, { role: 'implementer', tier: 'fast', repository: 'repo_a' })
    expect(hintsFor('repo_a', 'implementer', rows)).toEqual({
      known: false,
      reason: 'not_enough_data',
      attemptsSeen: 4,
      attemptsNeeded: 5,
    })
  })

  it('unknown-tier attempts count towards attemptsSeen but never rank', () => {
    const rows = [
      ...uniform(3, { role: 'implementer', tier: 'fast', repository: 'repo_a' }),
      ...uniform(2, { role: 'implementer', tier: undefined, repository: 'repo_a' }),
    ]
    expect(hintsFor('repo_a', 'implementer', rows)).toEqual({
      known: true,
      orderings: [
        {
          role: 'implementer',
          ordering: [], // the fast cell (3) is still below the gate; the tierless never rank
          confidence: 0,
          tiers: [
            {
              tier: 'fast',
              attempts: 3,
              successRate: null,
              repairRate: null,
              reviewFindings: null,
              meanWallClockMs: null,
              meanCostUsd: null,
            },
          ],
        },
      ],
    })
  })

  it('ranks the seeded repository: balanced above fast on success, confidence 5', () => {
    const rows = [...seededFast(), ...seededRepairs(), ...seededBalanced()]
    expect(hintsFor('repo_a', 'code_reviewer', rows)).toEqual({
      known: true,
      orderings: [
        {
          role: 'code_reviewer',
          ordering: ['balanced', 'fast'],
          confidence: 5,
          tiers: [
            {
              tier: 'fast',
              attempts: 5,
              successRate: 0.6,
              repairRate: 0.4,
              reviewFindings: 3.25,
              meanWallClockMs: 2_500,
              meanCostUsd: 0.25,
            },
            {
              tier: 'balanced',
              attempts: 5,
              successRate: 1,
              repairRate: null,
              reviewFindings: null,
              meanWallClockMs: 8_000,
              meanCostUsd: 1,
            },
          ],
        },
      ],
    })
  })

  it('equal success breaks on fewer repairs — before speed or cost', () => {
    const taskIds = ['x', 'x', 'x', 'n', 'n'] as const
    const fast = uniform(5, { role: 'implementer', tier: 'fast', repository: 'repo_t' }).map((each, index) =>
      row({
        ...each,
        result: index === 0 ? 'api_error' : 'completed',
        taskId: taskIds[index],
        durationMs: 1_000,
        spend: 1,
      }),
    )
    const balanced = uniform(5, {
      role: 'implementer',
      tier: 'balanced',
      repository: 'repo_t',
      durationMs: 9_000,
      spend: 9,
    }).map((each, index) =>
      row({ ...each, result: index === 0 ? 'api_error' : 'completed', taskId: index === 0 ? 'y' : 'n' }),
    )
    const repairs = [
      row({
        attemptId: 'att_r_x',
        role: 'repair_agent',
        result: 'completed',
        tier: 'strong',
        repository: 'repo_t',
        taskId: 'x',
      }),
      row({
        attemptId: 'att_r_y',
        role: 'repair_agent',
        result: 'completed',
        tier: 'strong',
        repository: 'repo_t',
        taskId: 'y',
      }),
    ]
    const hints = hintsFor('repo_t', 'implementer', [...fast, ...balanced, ...repairs])
    expect(hints.known).toBe(true)
    if (hints.known) expect(hints.orderings[0]?.ordering).toEqual(['balanced', 'fast'])
  })

  it('repair-less ties break on speed, then cost, then the cheapest rung', () => {
    const slowerFast = uniform(5, {
      role: 'implementer',
      tier: 'fast',
      repository: 'repo_s',
      durationMs: 9_000,
      spend: 1,
    })
    const quickerBalanced = uniform(5, {
      role: 'implementer',
      tier: 'balanced',
      repository: 'repo_s',
      durationMs: 1_000,
      spend: 1,
    })
    expect(hintsFor('repo_s', 'implementer', [...slowerFast, ...quickerBalanced])).toEqual({
      known: true,
      orderings: [
        { role: 'implementer', ordering: ['balanced', 'fast'], confidence: 5, tiers: expect.anything() },
      ],
    })

    const fullTieFast = uniform(5, {
      role: 'implementer',
      tier: 'fast',
      repository: 'repo_g',
      durationMs: 1_000,
      spend: 1,
    })
    const fullTieBalanced = uniform(5, {
      role: 'implementer',
      tier: 'balanced',
      repository: 'repo_g',
      durationMs: 1_000,
      spend: 1,
    })
    expect(hintsFor('repo_g', 'implementer', [...fullTieFast, ...fullTieBalanced])).toEqual({
      known: true,
      orderings: [
        { role: 'implementer', ordering: ['fast', 'balanced'], confidence: 5, tiers: expect.anything() },
      ],
    })
  })

  it('without a role, one ordering per role the repository saw, sorted by role', () => {
    const rows = [
      ...uniform(5, { role: 'implementer', tier: 'fast', repository: 'repo_x', durationMs: 1_000, spend: 1 }),
      ...uniform(2, { role: 'code_reviewer', tier: 'balanced', repository: 'repo_x' }),
    ]
    const hints = hintsFor('repo_x', undefined, rows)
    expect(hints.known).toBe(true)
    if (hints.known) {
      expect(hints.orderings.map((ordering) => ordering.role)).toEqual(['code_reviewer', 'implementer'])
      expect(hints.orderings[0]?.ordering).toEqual([]) // 2 attempts — its own gate is not met
      expect(hints.orderings[1]?.ordering).toEqual(['fast'])
      expect(hints.orderings[1]?.confidence).toBe(5)
    }
  })

  it('sub-threshold tier cells stay visible in tiers, with null metrics, and never rank', () => {
    const rows = [
      ...uniform(5, { role: 'implementer', tier: 'fast', repository: 'repo_c' }).map((each, index) =>
        row({ ...each, result: index < 3 ? 'completed' : 'api_error' }),
      ),
      ...uniform(4, { role: 'implementer', tier: 'balanced', repository: 'repo_c' }),
    ]
    const hints = hintsFor('repo_c', 'implementer', rows)
    expect(hints.known).toBe(true)
    if (hints.known) {
      const entry = hints.orderings[0]
      expect(entry?.ordering).toEqual(['fast'])
      expect(entry?.confidence).toBe(5)
      expect(entry?.tiers).toEqual([
        {
          tier: 'fast',
          attempts: 5,
          successRate: 0.6,
          repairRate: null,
          reviewFindings: null,
          meanWallClockMs: 1_000,
          meanCostUsd: null,
        },
        {
          tier: 'balanced',
          attempts: 4,
          successRate: null,
          repairRate: null,
          reviewFindings: null,
          meanWallClockMs: null,
          meanCostUsd: null,
        },
      ])
    }
  })
})
