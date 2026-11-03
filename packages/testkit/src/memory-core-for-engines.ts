/**
 * The recording `CoreForEngines` double CONTRACTS §6 promises Stream B: "Until A1 lands, B tests
 * against `MemoryCoreForEngines` from `packages/testkit`".
 *
 * Every fact is past tense, recorded (never refused) as `{ fact, args, at }` on the public `calls`
 * array. Args are deep copies, so mutating the caller's objects afterwards never rewrites history;
 * they must therefore be structured-cloneable (plain data, Dates, Errors).
 */
import type {
  AttemptRef,
  CoreFactName,
  CoreForEngines,
  ExitPayload,
  Generation,
  InputId,
  IsoTime,
  Operation,
  Report,
  Slot,
  SlotId,
  UsagePayload,
  UsageReading,
} from '@mec/contracts'

const clone = <T>(value: T): T => structuredClone(value)

export type RecordedFact = {
  fact: CoreFactName
  args: unknown[]
  at: IsoTime
}

export class MemoryCoreForEngines implements CoreForEngines {
  readonly calls: RecordedFact[] = []

  attemptStarted(
    attempt: AttemptRef,
    generation: Generation,
    session_id: string | undefined,
    at: IsoTime,
  ): void {
    this.#record('attemptStarted', [attempt, generation, session_id, at])
  }

  inputsDelivered(attempt: AttemptRef, input_ids: InputId[]): void {
    this.#record('inputsDelivered', [attempt, input_ids])
  }

  inputsRead(attempt: AttemptRef, input_ids: InputId[]): void {
    this.#record('inputsRead', [attempt, input_ids])
  }

  turnEnded(attempt: AttemptRef, generation: Generation): void {
    this.#record('turnEnded', [attempt, generation])
  }

  reportReceived(attempt: AttemptRef, generation: Generation, report: Report): void {
    this.#record('reportReceived', [attempt, generation, report])
  }

  permissionRequested(attempt: AttemptRef, request_id: string, operation: Operation): void {
    this.#record('permissionRequested', [attempt, request_id, operation])
  }

  rateLimitObserved(attempt: AttemptRef, slot: SlotId, reading: UsageReading): void {
    this.#record('rateLimitObserved', [attempt, slot, reading])
  }

  usageObserved(attempt: AttemptRef, usage: UsagePayload): void {
    this.#record('usageObserved', [attempt, usage])
  }

  attemptExited(attempt: AttemptRef, generation: Generation, exit: ExitPayload): void {
    this.#record('attemptExited', [attempt, generation, exit])
  }

  deliveryFailed(attempt: AttemptRef, input_ids: InputId[], error: unknown): void {
    this.#record('deliveryFailed', [attempt, input_ids, error])
  }

  slotChanged(slot: Slot): void {
    this.#record('slotChanged', [slot])
  }

  #record(fact: CoreFactName, args: unknown[]): void {
    this.calls.push({ fact, args: args.map(clone), at: new Date().toISOString() })
  }
}

/** Every recorded call of one fact name, in order. */
export function factsOf(calls: readonly RecordedFact[], fact: CoreFactName): RecordedFact[] {
  return calls.filter((call) => call.fact === fact)
}
