/**
 * Capability drift (plan §5.8; the §26 "Capability drift" row's runtime half).
 *
 * The capability probe records what the installed engine actually verified — the flags in
 * `flags_verified` and `structured_stream` — and an engine can change under a slot without
 * MEC noticing (OpenCode releases near-daily). Before NEW work is placed, the slot's
 * required flags are compared against the capabilities the probe reports now: a required
 * flag missing from `flags_verified`, or a `structured_stream` that flipped false, degrades
 * the slot to `engine_unsupported` — the binary no longer does what the slot was created
 * to rely on, and the detail names what was lost.
 *
 * Policy stays with the caller: a degraded finding never stops a RUNNING attempt, which
 * keeps the binary it started with; drift only gates the next reserve/launch and surfaces
 * the upgrade path in the slot UI.
 */
import type { Capabilities } from '@mec/contracts'

export type DriftCheck =
  | { degraded: false }
  | { degraded: true; reason: 'engine_unsupported'; detail: string }

export function checkDrift(current: Capabilities, requiredFlags: readonly string[]): DriftCheck {
  for (const flag of requiredFlags) {
    if (!current.flags_verified.includes(flag)) {
      return {
        degraded: true,
        reason: 'engine_unsupported',
        detail: `required flag '${flag}' is no longer verified on engine ${current.engine_version}`,
      }
    }
  }
  if (!current.structured_stream) {
    return {
      degraded: true,
      reason: 'engine_unsupported',
      detail: `structured_stream is no longer verified on engine ${current.engine_version}`,
    }
  }
  return { degraded: false }
}
