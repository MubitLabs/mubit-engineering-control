/**
 * Slot failover planning, plan §5.10 (Parking, resume, switch and failover) and the §26
 * "Slot failover" row. Pure: a snapshot of parked attempts, configured pairings, probe-healthy
 * slots and known quota resets goes in, one decision per parked attempt comes out — no I/O, no
 * clock (the caller passes `now`), nothing switched. The composition layer re-probes the target,
 * turns a `switch` into a NEW attempt on the SAME worktree, fills the real handoff pack and
 * records every switch as an event; `pack` here is the placeholder shape, carrying the counts
 * that must survive the handoff.
 */

export type ParkedAttempt = {
  attemptId: string
  taskId: string
  workItemId: string
  slotId: string
  parkState: 'quota_wait' | 'auth_required' | 'provider_down'
  /** Plan revision, carried for callers that fence stale replans; not used to decide. */
  generation: number
  worktree: string
  /** Open structured questions on the attempt (§12) — threaded into the handoff pack. */
  openQuestions: number
  /** Holds on the attempt's effects queue — threaded into the handoff pack. */
  holds: number
}

/** §5.10 auto-failover is opt-in: explicit slot pairs in the policy file; default is explicit. */
export type SlotPairing = {
  from: string
  to: string
  auto: boolean
}

export type HandoffPlan = {
  attempt: ParkedAttempt
  action: 'switch' | 'wait' | 'resume_same_slot'
  targetSlot?: string
  handoff: {
    fromSlot: string
    toSlot?: string
    reason: string
    at: string
    pack: {
      worktree: string
      plan: 'in_pack'
      diffSoFar: 'in_pack'
      transcriptSummary: 'in_pack'
      openQuestions: number
      holds: number
    }
  }
}

function waitReason(attempt: ParkedAttempt, pairingsFromSlot: readonly SlotPairing[]): string {
  if (pairingsFromSlot.some((pairing) => pairing.auto)) {
    return `${attempt.parkState}: paired target not healthy`
  }
  if (pairingsFromSlot.length > 0) return `${attempt.parkState}: explicit pairing, the user switches`
  if (attempt.parkState === 'quota_wait') return 'quota_wait: reset unknown'
  return 'provider_down: no pairing'
}

export function planFailover(input: {
  parked: readonly ParkedAttempt[]
  pairings: readonly SlotPairing[]
  healthySlots: readonly string[]
  resetsKnown: Record<string, boolean>
  now: string
}): HandoffPlan[] {
  const packOf = (attempt: ParkedAttempt): HandoffPlan['handoff']['pack'] => ({
    worktree: attempt.worktree,
    plan: 'in_pack',
    diffSoFar: 'in_pack',
    transcriptSummary: 'in_pack',
    openQuestions: attempt.openQuestions,
    holds: attempt.holds,
  })

  const decide = (attempt: ParkedAttempt): HandoffPlan => {
    // Rule 1: auth never switches. Only a re-login on the SAME slot resumes (§5.10), so an
    // auth park waits for the user even when an auto pairing is configured and healthy.
    if (attempt.parkState === 'auth_required') {
      return {
        attempt,
        action: 'wait',
        handoff: {
          fromSlot: attempt.slotId,
          reason: 'auth_required: only a same-slot re-login resumes',
          at: input.now,
          pack: packOf(attempt),
        },
      }
    }

    const pairingsFromSlot = input.pairings.filter((pairing) => pairing.from === attempt.slotId)

    // Rule 2: opt-in auto-failover. An auto pairing whose target is probe-healthy continues as
    // a NEW attempt on the SAME worktree with a recorded handoff (§5.10). It wins over waiting
    // out a known reset: the user pre-authorised continuation "without asking".
    const autoTarget = pairingsFromSlot.find(
      (pairing) => pairing.auto && input.healthySlots.includes(pairing.to),
    )
    if (autoTarget !== undefined) {
      return {
        attempt,
        action: 'switch',
        targetSlot: autoTarget.to,
        handoff: {
          fromSlot: attempt.slotId,
          toSlot: autoTarget.to,
          reason: attempt.parkState,
          at: input.now,
          pack: packOf(attempt),
        },
      }
    }

    // Rule 3: a known reset lifts a quota park on the same slot (§5.10 Resume). An un-clicked
    // explicit pairing offers a manual switch but does not suppress the lift.
    if (attempt.parkState === 'quota_wait' && input.resetsKnown[attempt.slotId] === true) {
      return {
        attempt,
        action: 'resume_same_slot',
        handoff: {
          fromSlot: attempt.slotId,
          reason: 'quota_wait: known reset lifts the park',
          at: input.now,
          pack: packOf(attempt),
        },
      }
    }

    // Rule 4: everything else waits — explicit-only pairings (the user clicks; no silent
    // switch), auto pairings whose target is down, provider_down without a pairing, and quota
    // waits with an unknown reset.
    return {
      attempt,
      action: 'wait',
      handoff: {
        fromSlot: attempt.slotId,
        reason: waitReason(attempt, pairingsFromSlot),
        at: input.now,
        pack: packOf(attempt),
      },
    }
  }

  return input.parked.map(decide)
}
