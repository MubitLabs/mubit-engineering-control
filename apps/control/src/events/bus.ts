import type { Sql } from '../db/sql'
import { EVENTS_CHANNEL } from './append'

type Listener = (seq: number) => void

/**
 * Fans Postgres NOTIFY messages out to in-process subscribers (SSE connections, the scheduler).
 * Notifications are only a wake-up signal; subscribers always read the durable log.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>()
  private unlisten: (() => Promise<void>) | null = null

  constructor(private readonly sql: Sql) {}

  async start(): Promise<void> {
    const req = await this.sql.listen(EVENTS_CHANNEL, (raw) => {
      try {
        const { stream, seq } = JSON.parse(raw) as { stream: string; seq: number }
        this.publish(stream, seq)
      } catch {
        // Ignore malformed payloads; the log stays authoritative.
      }
    })
    this.unlisten = () => req.unlisten()
  }

  async stop(): Promise<void> {
    await this.unlisten?.()
    this.unlisten = null
  }

  publish(stream: string, seq: number): void {
    for (const fn of this.listeners.get(stream) ?? []) fn(seq)
    for (const fn of this.listeners.get('*') ?? []) fn(seq)
  }

  /** Subscribe to one stream, or '*' for all. Returns an unsubscribe function. */
  subscribe(stream: string, fn: Listener): () => void {
    let set = this.listeners.get(stream)
    if (!set) {
      set = new Set()
      this.listeners.set(stream, set)
    }
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.listeners.delete(stream)
    }
  }
}
