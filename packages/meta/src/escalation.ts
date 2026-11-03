/**
 * Plan §6: four consecutive invalid proposals from a meta-agent turn escalate to the
 * user — the v1 coordinator discipline, kept exactly.
 *
 * The count is consecutive per attempt: `reset` records a valid proposal (or any
 * accepted one) and starts the streak over; an invalid proposal from a different
 * attempt never touches another attempt's streak. Once the streak reaches the limit,
 * every further invalid proposal keeps answering `escalate` until the streak resets.
 */
const DEFAULT_LIMIT = 4

export class EscalationCounter {
  private readonly limit: number
  private readonly consecutiveInvalid = new Map<string, number>()

  constructor(limit: number = DEFAULT_LIMIT) {
    this.limit = limit
  }

  addInvalid(attemptId: string): 'continue' | 'escalate' {
    const next = (this.consecutiveInvalid.get(attemptId) ?? 0) + 1
    this.consecutiveInvalid.set(attemptId, next)
    return next >= this.limit ? 'escalate' : 'continue'
  }

  reset(attemptId: string): void {
    this.consecutiveInvalid.delete(attemptId)
  }
}
