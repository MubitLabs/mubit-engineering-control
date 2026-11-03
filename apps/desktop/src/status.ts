/**
 * The `mec status` contract (plan §21.2): four exit codes, first match wins.
 *
 * 0 runs normally (paused included); 1 not running, running twice, not answering, or a
 * runtime error (a restart may fix it); 2 a part other than the runtime reports an error
 * (a restart does not fix it); 3 waiting for setup (no slot, no repository, never
 * initialised). Degraded parts never change the code — they only add lines in the 0 case.
 */
import type { HealthSnapshot } from './health'

export type StatusCode = 0 | 1 | 2 | 3

export type StatusResult = { code: StatusCode; lines: string[] }

export function statusFromSnapshot(
  snapshot: HealthSnapshot | null,
  opts: { initialized: boolean },
): StatusResult {
  if (snapshot === null) {
    return opts.initialized
      ? { code: 1, lines: ['not running'] }
      : { code: 3, lines: ['waiting for setup: mec has not been initialised'] }
  }

  const { runtime, parts, setup } = snapshot

  if (runtime.instances === 0) return { code: 1, lines: ['not running'] }
  if (runtime.instances > 1) {
    return { code: 1, lines: [`running twice (${runtime.instances} instances)`] }
  }
  if (!runtime.answering) return { code: 1, lines: ['not answering'] }
  if (runtime.state === 'error') {
    const lines = ['runtime error (a restart may fix it)']
    const runtimePart = parts.runtime
    if (runtimePart !== undefined) {
      lines.push(`part error: runtime: ${runtimePart.detail ?? 'no detail'}`)
    }
    return { code: 1, lines }
  }

  const errored = Object.entries(parts).filter(([, part]) => part.state === 'error')
  if (errored.length > 0) {
    return {
      code: 2,
      lines: errored.map(
        ([name, part]) => `part error: ${name}: ${part.detail ?? 'no detail'} (a restart will not fix it)`,
      ),
    }
  }

  const waiting: string[] = []
  if (!setup.has_slot) waiting.push('waiting for setup: no slot')
  if (!setup.has_repository) waiting.push('waiting for setup: no repository')
  if (waiting.length > 0) return { code: 3, lines: waiting }

  const lines = [runtime.state === 'paused' ? 'paused' : 'running normally']
  for (const [name, part] of Object.entries(parts)) {
    if (part.state === 'degraded') {
      lines.push(`part degraded: ${name}: ${part.detail ?? 'no detail'}`)
    }
  }
  return { code: 0, lines }
}

export function formatStatus(result: StatusResult): string {
  return result.lines.join('\n')
}
