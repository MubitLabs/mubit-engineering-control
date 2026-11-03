/**
 * The health snapshot `mec status` reads (plan §21.2).
 *
 * The running server (Stream A's composition root, from A1) writes this document; until then the
 * fake health board in `test/fixtures/` stands in for it. The shape mirrors CONTRACTS §7's
 * HealthBoard: one `runtime` claim plus one entry per registered part (`effects:*`, `slot:<id>`,
 * `engine:<id>`, …). `mec status` never guesses: what is not in the snapshot is reported as
 * unknown, never healthy.
 */
export type PartState = 'ok' | 'degraded' | 'error'

export type PartEntry = { state: PartState; detail?: string }

export type RuntimeState = 'starting' | 'ready' | 'paused' | 'error'

export type HealthSnapshot = {
  /** Written by the server on every claim transition; a stale snapshot is `not_answering`. */
  runtime: { state: RuntimeState; instances: number; answering: boolean }
  parts: Record<string, PartEntry>
  /** Plan §21.2 exit 3: waiting for setup (no slot, no repository). */
  setup: { has_slot: boolean; has_repository: boolean }
}

/** `null` = no snapshot on disk: the server has never run (or died without writing one). */
export function parseHealthSnapshot(text: string): HealthSnapshot | null {
  if (text.trim() === '') return null
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Partial<HealthSnapshot>
  if (
    typeof value.runtime !== 'object' ||
    value.runtime === null ||
    typeof value.parts !== 'object' ||
    typeof value.setup !== 'object' ||
    value.setup === null
  ) {
    return null
  }
  const { runtime, parts, setup } = value
  if (
    !['starting', 'ready', 'paused', 'error'].includes(runtime.state) ||
    typeof runtime.instances !== 'number' ||
    typeof runtime.answering !== 'boolean' ||
    typeof setup.has_slot !== 'boolean' ||
    typeof setup.has_repository !== 'boolean'
  ) {
    return null
  }
  return { runtime, parts, setup }
}
