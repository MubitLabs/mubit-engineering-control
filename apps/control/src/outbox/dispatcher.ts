import type { FastifyBaseLogger } from 'fastify'
import type { Sql } from '../db/sql'
import type { RunnerRegistry } from '../features/runners/registry'
import { OUTBOX_CHANNEL, pendingCommands } from './commands'

/**
 * Delivers queued runner commands over live connections. Woken by NOTIFY when a command is
 * queued and when a runner connects; a slow tick retries anything unacknowledged.
 */
export class CommandDispatcher {
  private readonly busy = new Set<string>()
  private readonly again = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private unlisten: (() => Promise<void>) | null = null

  constructor(
    private readonly sql: Sql,
    private readonly registry: RunnerRegistry,
    private readonly log: FastifyBaseLogger,
    private readonly tickMs = 2_000,
  ) {}

  async start(): Promise<void> {
    const req = await this.sql.listen(OUTBOX_CHANNEL, (runnerId) => void this.kick(runnerId))
    this.unlisten = () => req.unlisten()
    this.registry.onChange((runnerId, online) => {
      if (online) void this.kick(runnerId)
    })
    this.timer = setInterval(() => {
      for (const id of this.registry.connectedIds()) void this.kick(id)
    }, this.tickMs)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.unlisten?.()
  }

  async kick(runnerId: string): Promise<void> {
    if (!this.registry.get(runnerId)) return
    if (this.busy.has(runnerId)) {
      this.again.add(runnerId)
      return
    }
    this.busy.add(runnerId)
    try {
      do {
        this.again.delete(runnerId)
        const conn = this.registry.get(runnerId)
        if (!conn) return
        const batch = await pendingCommands(this.sql, runnerId)
        for (const row of batch) conn.send({ type: 'command', command: row.payload })
      } while (this.again.has(runnerId))
    } catch (err) {
      this.log.warn({ err, runnerId }, 'command dispatch failed')
    } finally {
      this.busy.delete(runnerId)
    }
  }
}
