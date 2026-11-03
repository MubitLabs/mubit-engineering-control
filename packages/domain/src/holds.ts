/**
 * Holds, plan §10 and §12.5: "wait" holds a work item. The hold persists across
 * follow-ups, new attempts and restarts until the user lifts it — automated events
 * never lift it, questions and new clues do not, and a status question is answered
 * without resuming. Only the user's explicit go lifts (§26 "Hold" row).
 *
 * Persistence is the caller's: the store is a pure in-memory fold with no clocks
 * and no I/O. A caller that journals `hold`/`lift` calls (or snapshots `entries`)
 * restores the same held items after a restart.
 */

export type Hold = { workItemId: string; reason: string; at: string; liftedAt?: string }

export class HoldStore {
  private readonly holds = new Map<string, Hold>()

  /**
   * Record or refresh a hold. Holding an already-held item updates the reason and
   * source time (the latest "wait" wins) and never lifts anything.
   */
  hold(workItemId: string, reason: string, at: string): Hold {
    const hold: Hold = { workItemId, reason, at }
    this.holds.set(workItemId, hold)
    return hold
  }

  status(workItemId: string): 'held' | 'free' {
    const hold = this.holds.get(workItemId)
    return hold !== undefined && hold.liftedAt === undefined ? 'held' : 'free'
  }

  /** The user's go. True once; a free or already-lifted item returns false. */
  lift(workItemId: string, at: string): boolean {
    const hold = this.holds.get(workItemId)
    if (hold === undefined || hold.liftedAt !== undefined) return false
    this.holds.set(workItemId, { ...hold, liftedAt: at })
    return true
  }

  /**
   * §26 "Hold" row: a status question about a held item is answered without
   * resuming — this records that answer and deliberately touches nothing.
   */
  answerStatusQuestion(_workItemId: string): 'answered_without_resume' {
    return 'answered_without_resume'
  }

  /** Snapshot for caller persistence; lifted holds are kept as history. */
  entries(): readonly Hold[] {
    return [...this.holds.values()]
  }
}
