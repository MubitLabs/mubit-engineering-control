import { z } from 'zod'
import type { Operation } from './bridge'
import type { AttemptRef, Generation, InputId, IsoTime, SlotId } from './common'
import type { EngineEventBody } from './events'
import type { Report } from './report'
import type { Slot, UsageReading } from './slots'

/** The `exit` event's payload, exactly as the fact log stores it (CONTRACTS §6). */
export type ExitPayload = Extract<EngineEventBody, { type: 'exit' }>

/** The `usage` event's payload; cumulative or delta as `Capabilities.usage_mode` says. */
export type UsagePayload = Extract<EngineEventBody, { type: 'usage' }>

/** The past-tense fact names, in the order CONTRACTS §6 lists them. */
export const CoreFactName = z.enum([
  'attemptStarted',
  'inputsDelivered',
  'inputsRead',
  'turnEnded',
  'reportReceived',
  'permissionRequested',
  'rateLimitObserved',
  'usageObserved',
  'attemptExited',
  'deliveryFailed',
  'slotChanged',
])

/**
 * Stream A implements it; the runtime and adapters report facts in the past tense, and a fact
 * may not be refused (CONTRACTS §6). Until A1 lands, B tests against `MemoryCoreForEngines`
 * from `packages/testkit`.
 */
export interface CoreForEngines {
  /** `session_id` is passed as `undefined` when the engine never produced one. */
  attemptStarted(
    attempt: AttemptRef,
    generation: Generation,
    session_id: string | undefined,
    at: IsoTime,
  ): void
  inputsDelivered(attempt: AttemptRef, input_ids: InputId[]): void
  /** Only once a report or turn end followed. */
  inputsRead(attempt: AttemptRef, input_ids: InputId[]): void
  turnEnded(attempt: AttemptRef, generation: Generation): void
  reportReceived(attempt: AttemptRef, generation: Generation, report: Report): void
  /** Record only; the decision came from the bridge. */
  permissionRequested(attempt: AttemptRef, request_id: string, operation: Operation): void
  rateLimitObserved(attempt: AttemptRef, slot: SlotId, reading: UsageReading): void
  usageObserved(attempt: AttemptRef, usage: UsagePayload): void
  attemptExited(attempt: AttemptRef, generation: Generation, exit: ExitPayload): void
  deliveryFailed(attempt: AttemptRef, input_ids: InputId[], error: unknown): void
  /** From packages/slots. */
  slotChanged(slot: Slot): void
}

export type CoreFactName = z.infer<typeof CoreFactName>
