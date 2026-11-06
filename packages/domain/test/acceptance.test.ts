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
    expect(errored.verdict).toBe('blocked')
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
