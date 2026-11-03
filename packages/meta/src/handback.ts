/**
 * Plan §12.3: a specialist hands a follow-up back **once**, with a one-sentence reason,
 * when it is beyond its task or belongs elsewhere. The meta agent then routes it with
 * that reason, **never back to the same ticket** — this function only decides whether a
 * hand-back is allowed; routing the released message elsewhere is the caller's job.
 *
 * Refusals:
 * - `already handed back` — the message was handed back before (by this or any ticket);
 *   once-only holds globally so a bounced message cannot be re-handed-back into a loop.
 * - `not owned` — the ticket is not live. A ticket owns the messages routed to it only
 *   while it runs; when the work item ends, messages it neither acknowledged, answered
 *   nor handed back are *released* to intake as fresh candidates (§12.3) — there is
 *   nothing left to hand back from an ended ticket.
 */
export function handBack(input: {
  messageId: string
  reason: string
  alreadyHandedBack: readonly string[]
  ticketLive: boolean
}): { action: 'hand_back' | 'refuse'; reason?: string } {
  if (input.alreadyHandedBack.includes(input.messageId)) {
    return { action: 'refuse', reason: 'already handed back' }
  }
  if (!input.ticketLive) {
    return { action: 'refuse', reason: 'not owned' }
  }
  return { action: 'hand_back', reason: input.reason }
}
