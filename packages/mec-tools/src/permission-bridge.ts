/**
 * Stream A of the permission bridge (contracts `PermissionBridge`, plan §6/§9).
 *
 * One decide callback per host process answers allow or deny for an operation;
 * the bridge owns the two failure modes around it: the deadline and the double
 * ask. `request` races the decider against a timer — an undecided request
 * expires, and the adapter then denies the native request and emits
 * `permission_result` (per the contracts comment). Requests are idempotent per
 * (attempt_id, request hash): an engine that re-asks the same operation with
 * the same evidence gets the recorded promise back, not a second card.
 */
import { createHash } from 'node:crypto'
import type { AttemptRef, Decision, Evidence, IsoTime, Operation, PermissionBridge } from '@mec/contracts'

export type Decide = (attempt: AttemptRef, operation: Operation) => Promise<'allow' | 'deny'>

const DEFAULT_DEADLINE_MS = 120_000

export class BridgeImpl implements PermissionBridge {
  private readonly decide: Decide
  private readonly deadlineMs: number
  /** One recorded promise per (attempt_id, request hash); settled entries stay — an accept is idempotent. */
  private readonly recorded = new Map<string, Promise<Decision>>()

  constructor(decide: Decide, deadlineMs: number = DEFAULT_DEADLINE_MS) {
    this.decide = decide
    this.deadlineMs = deadlineMs
  }

  request(
    attempt: AttemptRef,
    operation: Operation,
    evidence: Evidence,
    deadline: IsoTime,
  ): Promise<Decision> {
    const key = `${attempt.attempt_id}:${hashRequest(attempt, operation, evidence)}`
    const recorded = this.recorded.get(key)
    if (recorded) return recorded
    const decision = this.settle(attempt, operation, deadline)
    this.recorded.set(key, decision)
    return decision
  }

  private settle(attempt: AttemptRef, operation: Operation, deadline: IsoTime): Promise<Decision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('expired'), effectiveTimeoutMs(deadline, this.deadlineMs))
      timer.unref()
      this.decide(attempt, operation).then(
        (decision) => {
          clearTimeout(timer)
          resolve(decision)
        },
        () => {
          // A decider that errors answers deny: the safe direction for a card.
          clearTimeout(timer)
          resolve('deny')
        },
      )
    })
  }
}

/**
 * The effective wait: the earlier of the caller's deadline and the bridge's
 * own cap. An unreadable or already-past deadline uses what remains of the cap
 * (possibly nothing), never a guess.
 */
function effectiveTimeoutMs(deadline: IsoTime, capMs: number): number {
  const remainingMs = Date.parse(deadline) - Date.now()
  if (Number.isNaN(remainingMs)) return capMs
  return Math.max(0, Math.min(capMs, remainingMs))
}

/**
 * The request hash covers the full attempt ref (attempt id AND generation),
 * the operation and the evidence: a relaunch (new generation) re-asking the
 * same operation is a fresh request, while an engine retry inside one
 * generation is the same one. The caller's deadline is excluded on purpose —
 * it is a transport detail that shifts between retries and must not double a
 * card. Keys are sorted so object key order cannot either.
 */
function hashRequest(attempt: AttemptRef, operation: Operation, evidence: Evidence): string {
  return createHash('sha256').update(stableStringify({ attempt, operation, evidence }), 'utf8').digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
