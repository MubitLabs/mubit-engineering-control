import { z } from 'zod'
import { EffectKind } from './effects'

/** The six fixed subsystems of CONTRACTS §7. */
const FIXED_HEALTH_NAMES = ['runtime', 'scheduler', 'outbox', 'integration', 'meta_agent', 'backup'] as const

/** The id part of `slot:<id>` and `engine:<id>` names. */
const NAMESPACE_ID = '[A-Za-z0-9_-]+'

/**
 * One subsystem's health name (CONTRACTS §7): a fixed name, or a namespaced `effects:<kind>`,
 * `slot:<id>`, `engine:<id>`. The union is the runtime check; the type below states the same
 * families and must stay in sync with it.
 */
export const HealthName = z.union([
  z.enum(FIXED_HEALTH_NAMES),
  z.string().regex(new RegExp(`^effects:(${EffectKind.options.join('|')})$`)),
  z.string().regex(new RegExp(`^slot:${NAMESPACE_ID}$`)),
  z.string().regex(new RegExp(`^engine:${NAMESPACE_ID}$`)),
])

/** The handle a claiming subsystem uses to report its own state. */
export interface HealthClaim {
  /** Started but not yet usable. */
  starting(): void
  /** Serving; `detail` is free text for the panel. */
  ready(detail?: string): void
  /** Deliberately idle (drained, paused, parent stopped); not an error. */
  paused(): void
  /** Unusable; `detail` says why and the panel words it. */
  error(detail: string): void
}

export interface HealthBoard {
  /**
   * Claims a subsystem's name once: a second `claim` of the same name throws (CONTRACTS §7).
   * Stream A implements the board; both streams claim.
   */
  claim(name: HealthName): HealthClaim
}

export type HealthName =
  | (typeof FIXED_HEALTH_NAMES)[number]
  | `effects:${EffectKind}`
  | `slot:${string}`
  | `engine:${string}`
