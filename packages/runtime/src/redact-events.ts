/**
 * The journal pre-append redaction filter (plan §5.4 "redaction before durability" and §22;
 * the §26 gap "journal pre-append redaction wiring").
 *
 * The journal is the first durable stop of every event — it is fsynced before any store
 * sees the event — so the filter runs one step earlier still: the caller wraps every
 * `AttemptJournal.append` as `append(redactEvent(event, fingerprints, exacts))` and only
 * the returned copy is written and replayed. Every string anywhere in the event (message
 * text, error detail, and the raw engine fields that `JSON.stringify` would otherwise
 * carry into `events.jsonl`) passes through the slots redaction: a known key shape becomes
 * `[redacted:<provider>]`, a key handed over via `exacts` by the caller that transiently
 * holds it becomes `[redacted:exact]`.
 *
 * Numbers, booleans and structure are data, not secrets — token counts, rate-limit
 * utilization, seq numbers and exit codes survive untouched. The input event is never
 * mutated: the walk rebuilds objects and arrays, so the adapter's in-memory event keeps
 * its exact shape for the live stream while the journal sees only the redacted copy.
 */
import type { EngineEvent, KeyFingerprint } from '@mec/contracts'
import { redact } from '@mec/slots'

export function redactEvent(
  event: EngineEvent,
  fingerprints: readonly KeyFingerprint[],
  exacts: readonly string[],
): EngineEvent {
  return walk(event, fingerprints, exacts) as EngineEvent
}

/**
 * Deep copy with every string redacted. An EngineEvent only ever holds JSON shapes
 * (objects, arrays, strings, numbers, booleans, null); anything else — there is none in
 * practice — passes through by reference.
 */
function walk(value: unknown, fingerprints: readonly KeyFingerprint[], exacts: readonly string[]): unknown {
  if (typeof value === 'string') return redact(value, fingerprints, exacts)
  if (Array.isArray(value)) return value.map((entry) => walk(entry, fingerprints, exacts))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = walk(entry, fingerprints, exacts)
    return out
  }
  return value
}
