import { describe, expect, it } from 'vitest'
import type { AttemptRef } from '../src/common'
import {
  Degraded,
  KeyFingerprint,
  ProviderId,
  Reservation,
  Slot,
  SlotKind,
  SlotState,
  type Slots,
  UsageReading,
} from '../src/slots'
import { FAKE_KEYS } from './fake-keys'

const AT = '2026-11-03T15:18:57.626Z'

const FINGERPRINT = { provider: 'anthropic-sub', last4: 'A1b2', hash: 'a'.repeat(64) }

const USAGE_READING = {
  window: 'five_hour',
  utilization: 0.23,
  resets_at: '2026-11-03T18:20:00.000Z',
  observed_at: AT,
  source: 'engine_event',
}

const SLOT = {
  id: 'slot_max-1',
  label: 'Max subscription Claude',
  engine: 'claude',
  kind: 'claude-sub',
  provider: 'anthropic-sub',
  home: '/Users/me/.mec/slots/max-claude',
  credential_kind: 'oauth',
  fingerprint: FINGERPRINT,
  identity: { email: 'max@example.com', plan: 'pro', auth_method: 'oauth' },
  state: 'healthy',
  last_probe_at: AT,
  usage: USAGE_READING,
  engine_version: '2.1.317',
  pinning: { roles: ['implementer'] },
  pairs: ['slot_max-2'],
  concurrency: 2,
}

describe('the CONTRACTS §5 vocabularies', () => {
  it('list exactly the seven slot kinds, six providers, six states and six degraded reasons', () => {
    expect(SlotKind.options).toEqual([
      'claude-sub',
      'claude-api',
      'claude-glm',
      'codex-sub',
      'codex-api',
      'opencode-glm',
      'opencode-gemini',
    ])
    expect(ProviderId.options).toEqual([
      'anthropic-sub',
      'anthropic-api',
      'openai-sub',
      'openai-api',
      'zai-coding-plan',
      'google-gemini',
    ])
    expect(SlotState.options).toEqual([
      'draft',
      'home_ready',
      'login_pending',
      'healthy',
      'degraded',
      'retired',
    ])
    expect(Degraded.options).toEqual([
      'auth_expired',
      'key_rejected',
      'quota_exhausted',
      'engine_missing',
      'engine_unsupported',
      'provider_unreachable',
    ])
  })
})

describe('UsageReading', () => {
  it('accepts an engine-event reading and a bare provider-error one', () => {
    expect(UsageReading.safeParse(USAGE_READING).success).toBe(true)
    expect(
      UsageReading.safeParse({ window: 'unknown', observed_at: AT, source: 'provider_error' }).success,
    ).toBe(true)
  })

  it('rejects utilization above 1 and a non-ISO observed_at', () => {
    expect(UsageReading.safeParse({ ...USAGE_READING, utilization: 1.2 }).success).toBe(false)
    expect(UsageReading.safeParse({ ...USAGE_READING, observed_at: '2026-11-03T15:18:57Z' }).success).toBe(
      false,
    )
  })
})

describe('KeyFingerprint', () => {
  it('accepts salted SHA-256 fingerprints from two providers', () => {
    expect(KeyFingerprint.safeParse(FINGERPRINT).success).toBe(true)
    expect(
      KeyFingerprint.safeParse({ provider: 'zai-coding-plan', last4: '9f', hash: '0'.repeat(64) }).success,
    ).toBe(true)
  })

  it('rejects a git-sha-length hash and an unknown provider', () => {
    expect(
      KeyFingerprint.safeParse({ ...FINGERPRINT, hash: '0123456789abcdef0123456789abcdef01234567' }).success,
    ).toBe(false)
    expect(KeyFingerprint.safeParse({ ...FINGERPRINT, provider: 'anthropic' }).success).toBe(false)
  })
})

describe('Slot', () => {
  it('accepts a healthy slot with fingerprint and usage reading, and a degraded one reporting unknown', () => {
    expect(Slot.safeParse(SLOT).success).toBe(true)
    expect(
      Slot.safeParse({
        ...SLOT,
        id: 'slot_glm-1',
        label: 'GLM API key',
        kind: 'claude-glm',
        provider: 'zai-coding-plan',
        credential_kind: 'api_key',
        fingerprint: { provider: 'zai-coding-plan', last4: '9f', hash: '0'.repeat(64) },
        state: 'degraded',
        state_reason: 'quota_exhausted',
        resets_at: '2026-11-04T00:00:00.000Z',
        usage: 'unknown',
      }).success,
    ).toBe(true)
  })

  it('rejects a credential-looking extra field and a state outside the machine', () => {
    expect(Slot.safeParse({ ...SLOT, api_token: FAKE_KEYS.anthropic }).success).toBe(false)
    expect(Slot.safeParse({ ...SLOT, state: 'paused' }).success).toBe(false)
  })
})

/** The minimum in-memory `Slots` the interface promises to support: one slot, per-slot concurrency. */
class MemorySlots implements Slots {
  private readonly held: string[] = []

  constructor(
    private readonly slots: Slot[],
    private readonly capacity: number,
  ) {}

  list(): Promise<Slot[]> {
    return Promise.resolve(this.slots)
  }

  healthy(filter: {
    engine?: Slot['engine']
    kind?: Slot['kind']
    provider?: Slot['provider']
    role?: string
    exclude?: string[]
  }): Promise<Slot[]> {
    return Promise.resolve(
      this.slots.filter(
        (slot) =>
          (filter.engine === undefined || slot.engine === filter.engine) &&
          (filter.role === undefined || slot.pinning.roles.includes(filter.role)) &&
          !(filter.exclude ?? []).includes(slot.id),
      ),
    )
  }

  reserve(slot: string, attempt: AttemptRef): Promise<Reservation | 'full'> {
    if (this.held.filter((held) => held === slot).length >= this.capacity) return Promise.resolve('full')
    this.held.push(slot)
    return Promise.resolve(Reservation.parse({ slot, attempt }))
  }

  release(reservation: Reservation): Promise<void> {
    const at = this.held.indexOf(reservation.slot)
    if (at >= 0) this.held.splice(at, 1)
    return Promise.resolve()
  }

  usage(slot: string): Promise<UsageReading | 'unknown'> {
    return Promise.resolve(this.slots.find((candidate) => candidate.id === slot)?.usage ?? 'unknown')
  }

  probe(slot: string): Promise<SlotState> {
    return Promise.resolve(this.slots.find((candidate) => candidate.id === slot)?.state ?? 'draft')
  }

  on(event: 'slot.changed', handler: (slot: Slot) => void): void {
    if (event !== 'slot.changed') throw new Error(`unknown event: ${event}`)
    this.slots.forEach(handler)
  }
}

describe('Slots (MemorySlots-lite)', () => {
  const slot = Slot.parse(SLOT)
  const attempt: AttemptRef = { attempt_id: 'att_01', generation: 0 }

  it('reserves under capacity and hands back a reservation naming slot and attempt', async () => {
    const slots = new MemorySlots([slot], 1)
    await expect(slots.reserve('slot_max-1', attempt)).resolves.toEqual({
      slot: 'slot_max-1',
      attempt,
    })
  })

  it("returns 'full' once the slot's concurrency is consumed", async () => {
    const slots = new MemorySlots([slot], 1)
    await slots.reserve('slot_max-1', attempt)
    await expect(slots.reserve('slot_max-1', attempt)).resolves.toBe('full')
  })

  it('frees capacity on release', async () => {
    const slots = new MemorySlots([slot], 1)
    const reservation = await slots.reserve('slot_max-1', attempt)
    if (reservation === 'full') throw new Error('expected a reservation, got full')
    await slots.release(reservation)
    await expect(slots.reserve('slot_max-1', attempt)).resolves.not.toBe('full')
  })
})
