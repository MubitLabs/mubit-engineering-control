import { TaskSpec, type TaskSpecInput } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { hotspotCategory, pathsOverlap, validateTaskGraph } from '../src'

const task = (input: Partial<TaskSpecInput> & { key: string }): TaskSpec =>
  TaskSpec.parse({
    title: input.key,
    objective: `Do ${input.key}`,
    acceptanceChecks: ['test'],
    requirementIds: ['R1'],
    ownedPaths: [`src/${input.key.toLowerCase()}`],
    ...input,
  })

const ctx = { requirementIds: ['R1', 'R2'], availableProfileIds: ['p1'], knownCheckNames: ['test', 'lint'] }

const codes = (issues: { code: string }[]) => issues.map((i) => i.code)

describe('validateTaskGraph', () => {
  it('accepts a valid graph and orders dependencies first', () => {
    const v = validateTaskGraph(
      [
        task({ key: 'T3', dependsOn: ['T1', 'T2'], requirementIds: ['R2'] }),
        task({ key: 'T2', dependsOn: ['T1'] }),
        task({ key: 'T1' }),
      ],
      ctx,
    )
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.order).toEqual(['T1', 'T2', 'T3'])
    expect(v.levels).toEqual({ T1: 0, T2: 1, T3: 2 })
    expect(v.maxParallelism).toBe(1)
  })

  it('computes parallelism from independent tasks', () => {
    const v = validateTaskGraph(
      [
        task({ key: 'A' }),
        task({ key: 'B' }),
        task({ key: 'C', dependsOn: ['A', 'B'], requirementIds: ['R2'] }),
      ],
      ctx,
    )
    expect(v.maxParallelism).toBe(2)
  })

  it('rejects an empty plan', () => {
    expect(codes(validateTaskGraph([], ctx).errors)).toEqual(['empty_graph'])
  })

  it('rejects a cycle and reports its path', () => {
    const v = validateTaskGraph(
      [
        task({ key: 'A', dependsOn: ['C'] }),
        task({ key: 'B', dependsOn: ['A'] }),
        task({ key: 'C', dependsOn: ['B'] }),
      ],
      ctx,
    )
    expect(codes(v.errors)).toEqual(['cycle'])
    expect(v.errors[0]?.message).toBe('Dependency cycle: A -> C -> B -> A')
    expect(v.order).toEqual([])
  })

  it('rejects a self dependency', () => {
    expect(codes(validateTaskGraph([task({ key: 'A', dependsOn: ['A'] })], ctx).errors)).toEqual([
      'self_dependency',
    ])
  })

  it('rejects a dependency outside the delivery', () => {
    const v = validateTaskGraph([task({ key: 'A', dependsOn: ['OTHER'] })], ctx)
    expect(codes(v.errors)).toEqual(['unknown_dependency'])
  })

  it('rejects a requirement outside the plan', () => {
    const v = validateTaskGraph([task({ key: 'A', requirementIds: ['R9'] })], ctx)
    expect(codes(v.errors)).toContain('unknown_requirement')
  })

  it('rejects missing acceptance checks and unknown check names', () => {
    expect(codes(validateTaskGraph([task({ key: 'A', acceptanceChecks: [] })], ctx).errors)).toContain(
      'missing_acceptance_checks',
    )
    expect(codes(validateTaskGraph([task({ key: 'A', acceptanceChecks: ['e2e'] })], ctx).errors)).toContain(
      'unknown_check',
    )
  })

  it('rejects an unavailable profile', () => {
    const v = validateTaskGraph([task({ key: 'A', executionProfileId: 'someone-else' })], ctx)
    expect(codes(v.errors)).toContain('unavailable_profile')
    expect(validateTaskGraph([task({ key: 'A', executionProfileId: 'p1' })], ctx).ok).toBe(true)
  })

  it('rejects duplicate keys, empty objectives and out-of-range budgets', () => {
    const v = validateTaskGraph(
      [
        task({ key: 'A' }),
        task({ key: 'A' }),
        task({ key: 'B', objective: ' ', maxAttempts: 0, timeBudgetMinutes: 9999 }),
      ],
      ctx,
    )
    expect(codes(v.errors).sort()).toEqual([
      'duplicate_task',
      'invalid_budget',
      'invalid_budget',
      'missing_objective',
    ])
  })

  it('warns about overlapping owned paths only for tasks that can run in parallel', () => {
    const parallel = validateTaskGraph(
      [task({ key: 'A', ownedPaths: ['src/api/**'] }), task({ key: 'B', ownedPaths: ['src/api/users.ts'] })],
      ctx,
    )
    expect(codes(parallel.warnings)).toContain('owned_path_overlap')

    const ordered = validateTaskGraph(
      [
        task({ key: 'A', ownedPaths: ['src/api/**'] }),
        task({ key: 'B', ownedPaths: ['src/api/users.ts'], dependsOn: ['A'] }),
      ],
      ctx,
    )
    expect(codes(ordered.warnings)).not.toContain('owned_path_overlap')
  })

  it('warns about hotspots, and more strongly when parallel tasks share one', () => {
    const v = validateTaskGraph(
      [
        task({ key: 'A', ownedPaths: ['db/migrations/0003_a.sql', 'pnpm-lock.yaml'] }),
        task({ key: 'B', ownedPaths: ['db/migrations/0003_b.sql'] }),
      ],
      ctx,
    )
    expect(codes(v.warnings).filter((c) => c === 'hotspot')).toHaveLength(3)
    expect(v.warnings.find((w) => w.code === 'concurrent_hotspot')?.taskKeys).toEqual(['A', 'B'])
  })

  it('warns about uncovered requirements and tasks without owned paths', () => {
    const v = validateTaskGraph([task({ key: 'A', ownedPaths: [] })], ctx)
    expect(codes(v.warnings)).toEqual(expect.arrayContaining(['uncovered_requirement', 'no_owned_paths']))
    expect(v.ok).toBe(true)
  })
})

describe('path helpers', () => {
  it('treats glob suffixes as directory prefixes', () => {
    expect(pathsOverlap('src/api/**', 'src/api/users.ts')).toBe(true)
    expect(pathsOverlap('src/api', 'src/apix/users.ts')).toBe(false)
    expect(pathsOverlap('./src/a/', 'src/a')).toBe(true)
    expect(pathsOverlap('**', 'anything')).toBe(true)
  })

  it('classifies hotspot files', () => {
    expect(hotspotCategory('pnpm-lock.yaml')).toBe('lockfile')
    expect(hotspotCategory('apps/control/migrations/0002_x.sql')).toBe('migration')
    expect(hotspotCategory('src/__generated__/types.ts')).toBe('generated')
    expect(hotspotCategory('src/api.gen.ts')).toBe('generated')
    expect(hotspotCategory('packages/web/package.json')).toBe('shared_config')
    expect(hotspotCategory('src/index.ts')).toBeNull()
  })
})

describe('reserved keys', () => {
  it('rejects task keys that use the platform prefix', () => {
    const v = validateTaskGraph([task({ key: 'mec-plan-1' })], ctx)
    expect(v.errors[0]?.message).toContain('reserved prefix')
  })
})
