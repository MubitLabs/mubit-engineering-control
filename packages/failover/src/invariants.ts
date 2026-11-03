/**
 * Failover invariants, plan §5.10 and §27 (rejected concepts): engine sessions are never
 * resumed across slots or engines. A switch continues as a NEW attempt on the target slot with
 * an engine-neutral handoff pack — what must never happen is resuming the parked slot's engine
 * session elsewhere.
 */
export function assertNoCrossSlotResume(input: {
  originalSessionSlot: string
  newAttemptSlot: string
  resumeRequested: boolean
}): { ok: boolean; reason?: string } {
  if (input.resumeRequested && input.originalSessionSlot !== input.newAttemptSlot) {
    return { ok: false, reason: 'engine sessions are never resumed across slots' }
  }
  return { ok: true }
}
