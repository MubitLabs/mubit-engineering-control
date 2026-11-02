import { z } from 'zod'

/**
 * Runner protocol, PDF §25. Every event a runner emits is wrapped in this envelope.
 * Control deduplicates on (runnerId, eventId) and enforces an increasing sequence per attempt.
 */
export const RUNNER_PROTOCOL_VERSION = 1

export const RunnerEventEnvelope = z.object({
  schemaVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  eventId: z.string().min(1).max(128),
  runnerId: z.string().min(1).max(128),
  attemptId: z.string().min(1).max(128),
  generation: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  type: z.string().min(1).max(100),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
})
export type RunnerEventEnvelope = z.infer<typeof RunnerEventEnvelope>
