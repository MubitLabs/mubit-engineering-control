import type { ControlToRunner } from '@mec/contracts'

export interface RunnerConnection {
  runnerId: string
  connectionId: string
  send(message: ControlToRunner): void
  close(code: number, reason: string): void
}

/** Live runner connections in this control process. One connection per runner. */
export class RunnerRegistry {
  private readonly connections = new Map<string, RunnerConnection>()
  private readonly listeners = new Set<(runnerId: string, online: boolean) => void>()

  /** Registers a connection, closing any previous one for the same runner. */
  add(conn: RunnerConnection): void {
    const previous = this.connections.get(conn.runnerId)
    this.connections.set(conn.runnerId, conn)
    if (previous && previous.connectionId !== conn.connectionId)
      previous.close(4000, 'replaced by a newer connection')
    for (const l of this.listeners) l(conn.runnerId, true)
  }

  /** Removes the connection only if it is still the current one. Returns whether it was. */
  remove(runnerId: string, connectionId: string): boolean {
    const current = this.connections.get(runnerId)
    if (current?.connectionId !== connectionId) return false
    this.connections.delete(runnerId)
    for (const l of this.listeners) l(runnerId, false)
    return true
  }

  get(runnerId: string): RunnerConnection | undefined {
    return this.connections.get(runnerId)
  }

  connectedIds(): string[] {
    return [...this.connections.keys()]
  }

  onChange(fn: (runnerId: string, online: boolean) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  closeAll(): void {
    for (const c of this.connections.values()) c.close(1001, 'control shutting down')
    this.connections.clear()
  }
}
