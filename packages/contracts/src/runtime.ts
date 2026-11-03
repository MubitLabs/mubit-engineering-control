import type { Input } from './adapter'
import type { AttemptBrief } from './brief'
import type { AttemptRef } from './common'

/**
 * Stream B implements it (CONTRACTS §4). The surface the scheduler drives; every call names its
 * attempt, so a stale generation can be fenced out.
 */
export interface Runtime {
  /** Environment, shims, gitconfig, worktree and journal first, then `adapter.launch`. */
  launchAttempt(attempt: AttemptRef, brief: AttemptBrief): Promise<void>
  deliver(attempt: AttemptRef, input: Input): Promise<void>
  stop(attempt: AttemptRef): Promise<void>
  /** Journal → `CoreForEngines` facts after a restart. */
  replay(attempt: AttemptRef): Promise<void>
}
