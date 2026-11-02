import { randomUUID } from 'node:crypto'
import {
  type ControlToRunner,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommand,
  type RunnerEventEnvelope,
  type RunnerHello,
  type RunnerToControl,
} from '@mec/contracts'
import WebSocket from 'ws'

/** Polls until `fn` returns a truthy value, or throws after `timeoutMs`. */
export async function waitFor<T>(
  fn: () => Promise<T> | T,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<NonNullable<T>> {
  const started = Date.now()
  let last: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`)
}

export function hello(overrides: Partial<RunnerHello> = {}): RunnerHello {
  return {
    type: 'hello',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runnerVersion: 'test',
    hostname: 'testhost',
    os: 'linux',
    arch: 'x64',
    capacity: { maxAttempts: 2, cpus: 2, memoryMb: 4096, diskFreeMb: 10_000 },
    agents: [{ kind: 'fake', version: '1.0.0', available: true, auth: 'ok', capabilities: [], notes: [] }],
    attempts: [],
    ...overrides,
  }
}

/**
 * A hand-driven runner for protocol tests: it speaks the wire format but lets a test send any
 * envelope (duplicates, stale generations, sequence gaps) and inspect acks and commands.
 */
export class FakeRunnerClient {
  readonly commands: RunnerCommand[] = []
  readonly acks: { attemptId: string; sequence: number; eventId: string }[] = []
  welcome: Extract<ControlToRunner, { type: 'welcome' }> | null = null
  /** Close code of the last connection, once it closed. */
  closeCode: number | null = null
  private ws: WebSocket | null = null
  private sequences = new Map<string, number>()

  constructor(
    private readonly url: string,
    readonly runnerId: string,
    readonly token: string,
  ) {}

  async connect(h: RunnerHello = hello()): Promise<void> {
    this.welcome = null
    this.closeCode = null
    const ws = new WebSocket(`${this.url.replace(/^http/, 'ws')}/runner/ws`, {
      headers: { authorization: `Bearer ${this.token}` },
    })
    this.ws = ws
    ws.on('close', (code) => {
      this.closeCode = code
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ControlToRunner
      if (msg.type === 'welcome') this.welcome = msg
      if (msg.type === 'ack') this.acks.push(msg)
      if (msg.type === 'command') this.commands.push(msg.command)
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
    ws.send(JSON.stringify(h))
    await waitFor(() => this.welcome, 5_000, 'welcome')
  }

  send(msg: RunnerToControl): void {
    this.ws!.send(JSON.stringify(msg))
  }

  /** Builds an envelope with the next local sequence for the attempt (override anything). */
  envelope(
    attemptId: string,
    generation: number,
    type: string,
    payload: Record<string, unknown> = {},
    over: Partial<RunnerEventEnvelope> = {},
  ): RunnerEventEnvelope {
    const sequence = over.sequence ?? (this.sequences.get(attemptId) ?? -1) + 1
    this.sequences.set(attemptId, Math.max(sequence, this.sequences.get(attemptId) ?? -1))
    return {
      schemaVersion: RUNNER_PROTOCOL_VERSION,
      eventId: randomUUID(),
      runnerId: this.runnerId,
      attemptId,
      generation,
      sequence,
      type,
      occurredAt: new Date().toISOString(),
      payload,
      ...over,
    }
  }

  async emit(event: RunnerEventEnvelope): Promise<void> {
    this.send({ type: 'event', event })
    await waitFor(() => this.acks.some((a) => a.eventId === event.eventId), 5_000, `ack for ${event.type}`)
  }

  accept(commandId: string, status: 'accepted' | 'duplicate' | 'rejected' = 'accepted'): void {
    this.send({ type: 'command_result', commandId, status })
  }

  async close(): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((r) => {
      ws.once('close', () => r())
      ws.close()
    })
  }
}
