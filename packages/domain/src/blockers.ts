import type { TaskId } from '@mec/contracts'
import type { BasePolicy } from './task-graph'

/**
 * Blocker reasons, plan §10/§11: a state says where something is, a blocker says why it
 * waits. v1's `reviewer` and `decision` kinds merge into `confirmation` (§13); quota, auth
 * and infrastructure parking come from the provider/slot layer (§5.9/§5.10).
 */
export type BlockerReason =
  | 'dependency'
  | 'capacity'
  | 'confirmation'
  | 'quota'
  | 'auth'
  | 'policy'
  | 'infrastructure'

/**
 * When is a dependency satisfied (plan §14)? An `integration` dependency needs the merged
 * result: only `integrated` counts — an agent stopping, or even review passing, is not
 * enough. A `contract` dependency starts once the prerequisite is `accepted` (and a task
 * that is already `integrated` has necessarily passed acceptance, so it counts too).
 *
 * `dep` carries the prerequisite's id for callers that log or surface the check; it does
 * not change the answer, which depends only on the state and the policy.
 */
export function dependencySatisfied(
  dep: TaskId,
  depState: 'accepted' | 'integrated',
  basePolicy: BasePolicy,
): boolean {
  if (basePolicy === 'integration') return depState === 'integrated'
  return depState === 'accepted' || depState === 'integrated'
}
