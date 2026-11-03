import type { KeyFingerprint } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { redact } from '../src/redaction'

const fingerprint = (last4: string): KeyFingerprint => ({
  provider: 'anthropic-api',
  last4,
  hash: 'a'.repeat(64),
})

const ANTHROPIC_KEY = 'sk-ant-api03-fakefakefakefakefakefake1234'
const PLAN_KEY = 'zai-plan-key-not-a-real-key-never-use-this-9999'

describe('redaction', () => {
  it('replaces a known key shape with [redacted:<name>]', () => {
    expect(redact(`launch with ${ANTHROPIC_KEY} today`, [])).toBe('launch with [redacted:anthropic] today')
    expect(redact(`token ghp_${'a'.repeat(36)}`, [])).toContain('[redacted:github]')
  })

  it('replaces an exact key the caller holds transiently with [redacted:exact]', () => {
    expect(redact(`ZAI plan key ${PLAN_KEY} in a log line`, [fingerprint('9999')], [PLAN_KEY])).toBe(
      'ZAI plan key [redacted:exact] in a log line',
    )
  })

  it('the last-four sweep catches key material from a fingerprint alone (one-way hash, no exacts)', () => {
    expect(redact(`credential ${PLAN_KEY} leaked`, [fingerprint(PLAN_KEY.slice(-4))])).toBe(
      'credential [redacted:exact] leaked',
    )
    // ...but never a hex digest or SHA with different last four.
    const sha = 'f'.repeat(40)
    expect(redact(`base ${sha}`, [fingerprint('9999')])).toBe(`base ${sha}`)
  })

  it('leaves clean text unchanged', () => {
    const text = 'the plan resets at 18:40; PR #412 is ready for review'
    expect(redact(text, [])).toBe(text)
  })
})
