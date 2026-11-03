import { z } from 'zod'
import { Capabilities } from './adapter'
import { AbsPath, AttemptRef, EngineId, IsoTime, SlotId } from './common'
import { Window } from './events'
import { Unknown } from './internal'

/** `IsolationProfile` lives in `brief.ts` because the brief carries it (CONTRACTS §2); re-exported here. */
export { IsolationProfile } from './brief'

export const SlotKind = z.enum([
  'claude-sub',
  'claude-api',
  'claude-glm',
  'codex-sub',
  'codex-api',
  'opencode-glm',
  'opencode-gemini',
])

export const ProviderId = z.enum([
  'anthropic-sub',
  'anthropic-api',
  'openai-sub',
  'openai-api',
  'zai-coding-plan',
  'google-gemini',
])

export const SlotState = z.enum(['draft', 'home_ready', 'login_pending', 'healthy', 'degraded', 'retired'])

/** Why a slot sits in `degraded` (CONTRACTS §5). */
export const Degraded = z.enum([
  'auth_expired',
  'key_rejected',
  'quota_exhausted',
  'engine_missing',
  'engine_unsupported',
  'provider_unreachable',
])

/** One provider rate-limit window as an event, a 429 body or a status command showed it. */
export const UsageReading = z.strictObject({
  window: Window,
  utilization: z.number().min(0).max(1).optional(),
  resets_at: z.union([IsoTime, Unknown]).optional(),
  observed_at: IsoTime,
  source: z.enum(['engine_event', 'provider_error', 'status_command']),
})

/**
 * The only secret-adjacent shape in the contracts (CONTRACTS §0): a salted SHA-256 of the key,
 * never the key itself.
 */
export const KeyFingerprint = z.strictObject({
  provider: ProviderId,
  last4: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex characters (a salted SHA-256)'),
})

export const Slot = z.strictObject({
  id: SlotId,
  label: z.string().min(1),
  engine: EngineId,
  kind: SlotKind,
  provider: ProviderId,
  home: AbsPath,
  credential_kind: z.enum(['oauth', 'api_key']),
  fingerprint: KeyFingerprint.optional(),
  identity: z
    .strictObject({
      email: z.string().min(1).optional(),
      org: z.string().min(1).optional(),
      plan: z.string().min(1).optional(),
      auth_method: z.string().min(1).optional(),
    })
    .optional(),
  state: SlotState,
  /** Present only while `state` is `degraded`. */
  state_reason: Degraded.optional(),
  resets_at: z.union([IsoTime, Unknown]).optional(),
  last_probe_at: IsoTime.optional(),
  usage: z.union([UsageReading, Unknown]),
  engine_version: z.string().min(1).optional(),
  capabilities: Capabilities.optional(),
  pinning: z.strictObject({ roles: z.array(z.string().min(1)) }),
  pairs: z.array(z.string().min(1)),
  concurrency: z.int().min(0),
})

/** What `Slots.reserve` hands back and `Slots.release` takes; capacity is held between the two. */
export const Reservation = z.strictObject({
  slot: SlotId,
  attempt: AttemptRef,
})

/**
 * Stream B implements it (CONTRACTS §5). `reserve` is the only way an attempt consumes slot
 * capacity; the scheduler never counts for itself.
 */
export interface Slots {
  list(): Promise<Slot[]>
  healthy(filter: {
    engine?: EngineId
    kind?: SlotKind
    provider?: ProviderId
    role?: string
    exclude?: string[]
  }): Promise<Slot[]>
  reserve(slot: string, attempt: AttemptRef): Promise<Reservation | 'full'>
  release(reservation: Reservation): Promise<void>
  usage(slot: string): Promise<UsageReading | 'unknown'>
  probe(slot: string): Promise<SlotState>
  on(event: 'slot.changed', handler: (slot: Slot) => void): void
}

export type SlotKind = z.infer<typeof SlotKind>
export type ProviderId = z.infer<typeof ProviderId>
export type SlotState = z.infer<typeof SlotState>
export type Degraded = z.infer<typeof Degraded>
export type UsageReading = z.infer<typeof UsageReading>
export type KeyFingerprint = z.infer<typeof KeyFingerprint>
export type Slot = z.infer<typeof Slot>
export type Reservation = z.infer<typeof Reservation>
