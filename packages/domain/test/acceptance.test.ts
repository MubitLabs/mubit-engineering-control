import { describe, expect, it } from 'vitest'
import { type AcceptanceInput, acceptance, NO_CHECKS_MARKER } from '../src'

const HEAD = 'a'.repeat(40)
const OLDER = 'b'.repeat(40)

const input = (over: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
  attemptState: 'succeeded',
  head: HEAD,
  required: ['unit'],
  verdicts: [{ name: 'unit', status: 'passed', sha: HEAD }],
  findings: [],
  policy: { sensitive: false },
  ...over,
})

describe('acceptance (§10, §15, decision #32)', () => {
  it('passing registered checks on the exact head accepts a routine task', () => {
    expect(acceptance(input())).toEqual({ verdict: 'accepted', head: HEAD })
  })

  it('exit zero without checks is not accepted', () => {
    const decided = acceptance(input({ attemptState: 'work_complete', required: [], verdicts: [] }))
    expect(decided.verdict).toBe('blocked')
  })

  it('the no-checks marker can never pass by itself', () => {
    const marker = [{ name: NO_CHECKS_MARKER, status: 'passed' as const, sha: HEAD }]
    const decided = acceptance(input({ required: [NO_CHECKS_MARKER], verdicts: marker }))
    expect(decided.verdict).toBe('blocked')
  })

  it('green on an older SHA is rejected', () => {
    const decided = acceptance(input({ verdicts: [{ name: 'unit', status: 'passed', sha: OLDER }] }))
    expect(decided.verdict).toBe('blocked')
    expect(JSON.stringify(decided)).toContain('unit')
  })

  it('a missing required check is no pass, whatever else went green', () => {
    const decided = acceptance(input({ required: ['unit', 'lint'] }))
    expect(decided.verdict).toBe('blocked')
    expect(JSON.stringify(decided)).toContain('lint')
  })

  it('error is not failed and neither passes', () => {
    const errored = acceptance(
      input({
        attemptState: 'checks_failed',
        verdicts: [{ name: 'unit', status: 'error', sha: HEAD, logTail: 'could not start' }],
      }),
    )
    const failed = acceptance(
      input({
        attemptState: 'checks_failed',
        verdicts: [{ name: 'unit', status: 'failed', sha: HEAD, logTail: 'one test red' }],
      }),
    )
    expect(errored).toEqual({ verdict: 'blocked', reason: `could not run unit on ${HEAD}` })
    expect(failed).toEqual({
      verdict: 'repair',
      reason: 'checks_failed',
      head: HEAD,
      failing: [{ name: 'unit', logTail: 'one test red' }],
      findings: [],
    })
  })

  it('ready without head_sha is not accepted', () => {
    const decided = acceptance(input({ report: { kind: 'ready' } }))
    expect(decided.verdict).toBe('repair')
  })

  it('ready on another head is not accepted', () => {
    const decided = acceptance(input({ report: { kind: 'ready', headSha: OLDER } }))
    expect(decided).toMatchObject({ verdict: 'repair', reason: 'report_head' })
  })

  it('ready on the exact head with green checks is accepted', () => {
    const decided = acceptance(input({ report: { kind: 'ready', headSha: HEAD } }))
    expect(decided).toEqual({ verdict: 'accepted', head: HEAD })
  })

  it('an attempt still running has no decision yet', () => {
    expect(acceptance(input({ attemptState: 'running' })).verdict).toBe('pending')
  })

  it('a finding on the head repairs, one on an older head does not count', () => {
    const open = acceptance(input({ findings: [{ text: 'leaks a key', sha: HEAD }] }))
    expect(open).toMatchObject({ verdict: 'repair', reason: 'finding' })
    const old = acceptance(input({ findings: [{ text: 'leaks a key', sha: OLDER }] }))
    expect(old.verdict).toBe('accepted')
  })

  it('sensitive work needs the review on this exact head', () => {
    const sensitive = { sensitive: true }
    expect(acceptance(input({ policy: sensitive })).verdict).toBe('review')
    expect(acceptance(input({ policy: { ...sensitive, reviewedSha: OLDER } })).verdict).toBe('review')
    expect(acceptance(input({ policy: { ...sensitive, reviewedSha: HEAD } })).verdict).toBe('accepted')
  })
})

describe('no change and owned paths (§10, §14; real runs 2026-11-06/07)', () => {
  const BASE = OLDER

  it('green checks with no report on a head that never left the base are not accepted', () => {
    const decided = acceptance(input({ base: HEAD }))
    expect(decided).toMatchObject({ verdict: 'repair', reason: 'no_change', head: HEAD })
  })

  it('a ready report that says nothing needed changing is accepted on the base', () => {
    const decided = acceptance(input({ base: HEAD, report: { kind: 'ready', headSha: HEAD } }))
    expect(decided).toEqual({ verdict: 'accepted', head: HEAD })
  })

  it('a progress report is no word that the work is done, so no change still repairs', () => {
    const decided = acceptance(input({ base: HEAD, report: { kind: 'progress', headSha: HEAD } }))
    expect(decided).toMatchObject({ verdict: 'repair', reason: 'no_change' })
  })

  it('a brief that allows no change accepts it', () => {
    expect(acceptance(input({ base: HEAD, noChangeOk: true })).verdict).toBe('accepted')
  })

  it('a head that moved off the base is judged as before', () => {
    expect(acceptance(input({ base: BASE })).verdict).toBe('accepted')
  })

  it('a commit that changes files outside the owned paths is sent back naming them', () => {
    const decided = acceptance(
      input({
        base: BASE,
        owned: ['src/slug.mjs', 'test/slug.test.mjs'],
        changed: ['src/slug.mjs', 'src/title.mjs', 'test/slug.test.mjs'],
      }),
    )
    expect(decided).toMatchObject({ verdict: 'repair', reason: 'owned_paths', head: HEAD })
    expect(decided).toHaveProperty('outside', ['src/title.mjs'])
  })

  it('owned directories and globs cover the files under them', () => {
    const decided = acceptance(
      input({ base: BASE, owned: ['src/api/**', 'docs/'], changed: ['src/api/a/b.ts', 'docs/x.md'] }),
    )
    expect(decided.verdict).toBe('accepted')
  })

  it('a brief with no owned paths owns everything', () => {
    expect(acceptance(input({ base: BASE, owned: [], changed: ['anything.txt'] })).verdict).toBe('accepted')
  })

  it('failing checks still come first: the repair sees them', () => {
    const decided = acceptance(
      input({
        attemptState: 'checks_failed',
        base: BASE,
        owned: ['a.txt'],
        changed: ['b.txt'],
        verdicts: [{ name: 'unit', status: 'failed', sha: HEAD, logTail: 'red' }],
      }),
    )
    expect(decided).toMatchObject({ verdict: 'repair', reason: 'checks_failed' })
  })
})
