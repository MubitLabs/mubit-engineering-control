import type { Capabilities } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { checkDrift } from '../src/drift'

function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    engine_version: '2.2.5',
    flags_verified: ['--standalone', '--stdio', '--format', 'json'],
    structured_stream: true,
    questions: true,
    tool_approval: true,
    interrupt: true,
    resume: true,
    usage: true,
    rate_limit_events: true,
    sandbox: false,
    restricted_mode: true,
    mcp_http: true,
    usage_mode: 'cumulative',
    ...overrides,
  }
}

describe('checkDrift', () => {
  it('a lost required flag degrades as engine_unsupported and names it', () => {
    const current = capabilities({ flags_verified: ['--standalone', '--stdio'] })
    const check = checkDrift(current, ['--standalone', '--stdio', '--format', 'json'])
    expect(check).toEqual({
      degraded: true,
      reason: 'engine_unsupported',
      detail: "required flag '--format' is no longer verified on engine 2.2.5",
    })
  })

  it('all required flags present and structured_stream true stays healthy', () => {
    expect(checkDrift(capabilities(), ['--standalone', '--stdio'])).toEqual({ degraded: false })
    expect(checkDrift(capabilities(), [])).toEqual({ degraded: false })
  })

  it('structured_stream flipping false degrades', () => {
    const check = checkDrift(capabilities({ structured_stream: false }), ['--standalone'])
    expect(check.degraded).toBe(true)
    if (check.degraded) {
      expect(check.reason).toBe('engine_unsupported')
      expect(check.detail).toContain('structured_stream')
    }
  })

  it('a missing flag is reported even when structured_stream also flipped', () => {
    const check = checkDrift(capabilities({ structured_stream: false }), ['--vanished'])
    expect(check.degraded).toBe(true)
    if (check.degraded) expect(check.detail).toContain("'--vanished'")
  })
})
