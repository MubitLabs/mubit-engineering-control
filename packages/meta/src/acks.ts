/**
 * Plan §12.2 / §6 `acknowledge(message_id, text)`: every admitted request gets exactly
 * one acknowledgement in chat before substantial work — one sentence naming the object
 * and the intended result, idempotent per message id so retries, restarts and batch
 * replays never produce a second one. A new message in the same work item gets its own.
 *
 * The text recorded on the first call is final: a later call with different wording is
 * refused, not merged — the acknowledgement is the receipt the user may later reply to.
 */
export class Acknowledger {
  private readonly texts = new Map<string, string>()

  acknowledge(messageId: string, text: string): { first: boolean; text: string } {
    const recorded = this.texts.get(messageId)
    if (recorded !== undefined) return { first: false, text: recorded }
    this.texts.set(messageId, text)
    return { first: true, text }
  }

  textFor(messageId: string): string | undefined {
    return this.texts.get(messageId)
  }
}
