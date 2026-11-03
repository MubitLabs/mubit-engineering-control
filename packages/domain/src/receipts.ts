/**
 * Receipt ladder, plan §12.4: received → delivered → read → handled → settled, one
 * receipt per chat message.
 *
 * A receipt records what happened to the message, never what a transport write
 * implies: `read` is counted only once a report or turn end follows the delivery, so
 * the only route to `read` is `markTurnEnd`, which flushes every message delivered
 * before the turn end. A crash between stages preserves the message at its true
 * stage (§26 "Crash between delivered/read"): `advance` refuses jumps, skips and
 * regressions, and `forceStage` exists solely so reconciliation can write the TRUE
 * stage back after a restart — never a guess past what the evidence shows.
 *
 * Restart-safe by caller persistence: the ladder is an in-memory fold over facts,
 * no clocks and no I/O. A caller that journals each returned transition and replays
 * it after a restart converges on the same stages (same-stage advances are
 * idempotent no-ops, so replay never throws); a caller that finds it persisted a
 * stage ahead of the truth repairs it with `forceStage` before replaying.
 */

export type ReceiptStage = 'received' | 'delivered' | 'read' | 'handled' | 'settled'

export type Receipt = { messageId: string; stage: ReceiptStage; at: string }

/** Ladder order; index distance is the only thing `advance` may cross — one step. */
const RECEIPT_STAGES: readonly ReceiptStage[] = ['received', 'delivered', 'read', 'handled', 'settled']

export class ReceiptLadder {
  private readonly receipts = new Map<string, Receipt>()

  /**
   * One step up the ladder, or an idempotent no-op on the same stage (so journal
   * replay after a restart converges). Anything else throws: a jump, a skip, a
   * regression, `read` (which belongs to `markTurnEnd`), or a first sighting at
   * anything but `received`. Repairs go through `forceStage`.
   */
  advance(messageId: string, to: ReceiptStage, at: string): { from: ReceiptStage; to: ReceiptStage } {
    const current = this.receipts.get(messageId)
    if (current === undefined) {
      if (to !== 'received') {
        throw new Error(
          `Invalid advance: message '${messageId}' first enters the ladder at 'received', not '${to}'`,
        )
      }
      this.receipts.set(messageId, { messageId, stage: 'received', at })
      return { from: 'received', to: 'received' }
    }
    if (current.stage === to) return { from: to, to }
    if (to === 'read') {
      throw new Error(
        `Invalid advance: 'read' is counted only after a report or turn end — use markTurnEnd for '${messageId}'`,
      )
    }
    const distance = RECEIPT_STAGES.indexOf(to) - RECEIPT_STAGES.indexOf(current.stage)
    if (distance !== 1) {
      throw new Error(
        `Invalid advance: '${messageId}' cannot move '${current.stage}' → '${to}' in one step` +
          ` (skips and regressions need forceStage with the reconciled truth)`,
      )
    }
    this.receipts.set(messageId, { messageId, stage: to, at })
    return { from: current.stage, to }
  }

  /**
   * Set the TRUE stage when reconciling after a crash or restart. May jump in either
   * direction because durable evidence, not the ladder, decides the truth — but it
   * must never be used to move forward past what the evidence shows.
   */
  forceStage(messageId: string, stage: ReceiptStage, at: string): { from: ReceiptStage; to: ReceiptStage } {
    const current = this.receipts.get(messageId)
    this.receipts.set(messageId, { messageId, stage, at })
    return { from: current?.stage ?? stage, to: stage }
  }

  /**
   * A report or turn end (§12.4): every message delivered before this moment moves
   * delivered → read. Returns the promoted message ids in delivery order; messages
   * still at `received` (not yet handed to the engine) stay put.
   */
  markTurnEnd(at: string): string[] {
    const promoted: string[] = []
    for (const receipt of this.receipts.values()) {
      if (receipt.stage === 'delivered') {
        this.receipts.set(receipt.messageId, { ...receipt, stage: 'read', at })
        promoted.push(receipt.messageId)
      }
    }
    return promoted
  }

  stageOf(messageId: string): ReceiptStage | undefined {
    return this.receipts.get(messageId)?.stage
  }

  /** Message ids below `settled`, in arrival order — the ladder's open work. */
  unsettled(): string[] {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.stage !== 'settled')
      .map((receipt) => receipt.messageId)
  }

  /** Snapshot for caller persistence; later mutations leave it unchanged. */
  snapshot(): readonly Receipt[] {
    return [...this.receipts.values()]
  }
}
