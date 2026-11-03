import { describe, expect, it } from 'vitest'
import { Report } from '../src'

describe('Report.question', () => {
  it('keeps "absent" (keep the open question) apart from null (clear it)', () => {
    const keep = Report.parse({ kind: 'progress', summary: 'Still working.' })
    const clear = Report.parse({ kind: 'progress', summary: 'Still working.', question: null })
    expect('question' in keep).toBe(false)
    expect(clear.question).toBeNull()
  })
})

describe('Report caps', () => {
  it('allows a 2,000-character summary and a 400-character question', () => {
    const report = { kind: 'waiting', summary: 's'.repeat(2000), question: { text: 'q'.repeat(400) } }
    expect(Report.safeParse(report).success).toBe(true)
  })

  it('refuses one character more', () => {
    expect(Report.safeParse({ kind: 'waiting', summary: 's'.repeat(2001) }).success).toBe(false)
    expect(
      Report.safeParse({ kind: 'waiting', summary: 'ok', question: { text: 'q'.repeat(401) } }).success,
    ).toBe(false)
  })
})
