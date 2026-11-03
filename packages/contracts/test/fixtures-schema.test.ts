import { describe, expect, it } from 'vitest'
import { EffectKind } from '../src/effects'
import { FIXTURE_SCENARIOS, FixtureMeta, fixtureDir } from '../src/fixtures'
import { HealthName } from '../src/health'
import { DomainEvent } from '../src/store'

const AT = '2026-11-03T15:18:57.626Z'

const real = {
  engine: 'claude',
  engine_version: '2.1.317',
  scenario: 'smoke',
  recorded_at: AT,
  recorded_by: 'real',
  redacted: true,
  expected: {
    reports: ['progress', 'ready'],
    permission_requests: 2,
    rate_limits: ['five_hour', 'seven_day'],
    exit: 'completed',
  },
  notes: 'Happy path from MubitLabs/mec-stream-b@4a6c011.',
}

const fake = {
  engine: 'opencode',
  engine_version: '0.5.0',
  scenario: 'crash_mid_turn',
  recorded_at: AT,
  recorded_by: 'fake',
  redacted: true,
  expected: { reports: ['failed'], permission_requests: 0, rate_limits: [], exit: 'crashed' },
}

describe('FixtureMeta', () => {
  it('accepts a full real recording and a minimal fake one', () => {
    expect(FixtureMeta.safeParse(real).success).toBe(true)
    expect(FixtureMeta.safeParse(fake).success).toBe(true)
  })

  it('rejects an unredacted recording and one without expected', () => {
    expect(FixtureMeta.safeParse({ ...real, redacted: false }).success).toBe(false)
    const { expected: _expected, ...withoutExpected } = real
    expect(FixtureMeta.safeParse(withoutExpected).success).toBe(false)
  })
})

describe('FIXTURE_SCENARIOS', () => {
  it('is exactly the eleven mandatory scenarios, each once', () => {
    expect(FIXTURE_SCENARIOS).toHaveLength(11)
    expect(new Set(FIXTURE_SCENARIOS).size).toBe(11)
    expect([...FIXTURE_SCENARIOS].sort()).toEqual(
      [
        'auth_expired',
        'crash_mid_turn',
        'max_turns',
        'permission_request',
        'provider_down',
        'rate_limit_rejected',
        'rate_limit_warning',
        'report_blocked',
        'report_dropped',
        'report_ready_with_question',
        'smoke',
      ].sort(),
    )
  })
})

describe('fixtureDir', () => {
  it('is the path shape engine/version/scenario', () => {
    expect(fixtureDir('claude', '2.1.317', 'smoke')).toBe('claude/2.1.317/smoke')
  })
})

describe('HealthName', () => {
  it('accepts the six fixed subsystems and rejects unknown bare names', () => {
    for (const name of ['runtime', 'scheduler', 'outbox', 'integration', 'meta_agent', 'backup']) {
      expect(HealthName.safeParse(name).success, name).toBe(true)
    }
    expect(HealthName.safeParse('health').success).toBe(false)
    expect(HealthName.safeParse('runtime:x').success).toBe(false)
  })

  it('accepts every effects kind and rejects unknown or empty ones', () => {
    for (const kind of EffectKind.options) {
      expect(HealthName.safeParse(`effects:${kind}`).success, kind).toBe(true)
    }
    expect(HealthName.safeParse('effects:unknown').success).toBe(false)
    expect(HealthName.safeParse('effects:').success).toBe(false)
  })

  it('accepts slot ids and engine ids, rejecting other characters', () => {
    expect(HealthName.safeParse('slot:max-1').success).toBe(true)
    expect(HealthName.safeParse('slot:01').success).toBe(true)
    expect(HealthName.safeParse('slot:a/b').success).toBe(false)
    expect(HealthName.safeParse('slot:').success).toBe(false)
  })

  it('accepts engine names, rejecting empty ones and slashes', () => {
    expect(HealthName.safeParse('engine:claude').success).toBe(true)
    expect(HealthName.safeParse('engine:glm-4').success).toBe(true)
    expect(HealthName.safeParse('engine:').success).toBe(false)
    expect(HealthName.safeParse('engine:claude/2').success).toBe(false)
  })
})

describe('DomainEvent', () => {
  it('accepts gap-free stream rows in toISOString form', () => {
    expect(
      DomainEvent.safeParse({
        stream: 'attempt/att_01',
        seq: 1,
        at: AT,
        type: 'report_received',
        body: { kind: 'ready' },
      }).success,
    ).toBe(true)
    expect(
      DomainEvent.safeParse({ stream: 'slot/slot_max-1', seq: 12, at: AT, type: 'slot_changed', body: null })
        .success,
    ).toBe(true)
  })

  it('rejects seq 0, a non-millisecond time and an extra field', () => {
    expect(DomainEvent.safeParse({ stream: 's', seq: 0, at: AT, type: 't', body: null }).success).toBe(false)
    expect(
      DomainEvent.safeParse({ stream: 's', seq: 1, at: '2026-11-03T15:18:57Z', type: 't', body: null })
        .success,
    ).toBe(false)
    expect(
      DomainEvent.safeParse({ stream: 's', seq: 1, at: AT, type: 't', body: null, extra: true }).success,
    ).toBe(false)
  })
})
