import type { BasePolicy } from '@mec/contracts'
import type { TaskState } from './states'

/** Separate blocker reasons, PDF §11: a task's state says where it is, a blocker says why it waits. */
export const BLOCKER_KINDS = [
  'dependency',
  'capacity',
  'auth',
  'quota',
  'policy',
  'reviewer',
  'decision',
  'infrastructure',
] as const
export type BlockerKind = (typeof BLOCKER_KINDS)[number]

export interface Blocker {
  kind: BlockerKind
  detail: string
  refs: string[]
}

/**
 * A code dependency ('integration') is satisfied only once the prerequisite is integrated — an
 * agent stopping is not enough. An interface dependency ('contract') is satisfied on acceptance.
 */
export function dependencySatisfied(policy: BasePolicy, prerequisite: TaskState): boolean {
  if (policy === 'integration') return prerequisite === 'integrated'
  return prerequisite === 'accepted' || prerequisite === 'integrated'
}

export function dependencyBlocker(
  policy: BasePolicy,
  prerequisites: readonly { key: string; state: TaskState }[],
): Blocker | null {
  const waiting = prerequisites.filter((p) => !dependencySatisfied(policy, p.state))
  if (waiting.length === 0) return null
  const need = policy === 'integration' ? 'integrated' : 'accepted'
  return {
    kind: 'dependency',
    detail: `Waiting for ${waiting.map((w) => `${w.key} (${w.state})`).join(', ')} to be ${need}`,
    refs: waiting.map((w) => w.key),
  }
}
