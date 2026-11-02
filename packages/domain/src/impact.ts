import type { TaskSpec } from '@mec/contracts'
import { canonicalJson } from './canonical-json'

/**
 * What a new plan revision changes relative to the approved one (PDF §12): unchanged tasks keep
 * running, changed and removed tasks are the only ones whose work is invalidated.
 */
export interface PlanImpact {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export function planImpact(previous: readonly TaskSpec[], next: readonly TaskSpec[]): PlanImpact {
  const before = new Map(previous.map((t) => [t.key, canonicalJson(t)]))
  const after = new Map(next.map((t) => [t.key, canonicalJson(t)]))
  const impact: PlanImpact = { added: [], removed: [], changed: [], unchanged: [] }
  for (const [key, spec] of after) {
    const old = before.get(key)
    if (old === undefined) impact.added.push(key)
    else if (old === spec) impact.unchanged.push(key)
    else impact.changed.push(key)
  }
  for (const key of before.keys()) if (!after.has(key)) impact.removed.push(key)
  for (const list of Object.values(impact)) list.sort()
  return impact
}

export function describeImpact(impact: PlanImpact, started: ReadonlySet<string>): string {
  const lines: string[] = []
  const tag = (k: string) => (started.has(k) ? `${k} (work in progress will be stopped)` : k)
  if (impact.added.length) lines.push(`Added: ${impact.added.join(', ')}`)
  if (impact.changed.length) lines.push(`Changed: ${impact.changed.map(tag).join(', ')}`)
  if (impact.removed.length) lines.push(`Removed: ${impact.removed.map(tag).join(', ')}`)
  if (impact.unchanged.length) lines.push(`Unchanged, continuing: ${impact.unchanged.join(', ')}`)
  return lines.join('\n') || 'No task changes'
}
