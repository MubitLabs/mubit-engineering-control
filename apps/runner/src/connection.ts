import { ControlToRunner, type RunnerHello, type RunnerToControl } from '@mec/contracts'
import WebSocket from 'ws'
import type { Logger } from './config'

export interface ConnectionOptions {
  controlUrl: string
  token: string
  log: Logger
  hello: () => Promise<RunnerHello>
  onMessage: (msg: ControlToRunner) => void
  onDisconnect?: () => void
}

/**
 * The runner's single outbound connection (PDF §6: devices may sit behind NAT or a VPN).
 * Reconnects with capped exponential backoff. `ready` is true only after the welcome.
 */
export class ControlConnection {
  private ws: WebSocket | null = null
  private stopped = false
  private backoffMs = 1_000
  private timer: NodeJS.Timeout | null = null
  ready = false

  constructor(private readonly opts: ConnectionOptions) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close(1000, 'runner stopping')
      setTimeout(resolve, 2_000)
    })
  }

  /** Sends if connected; otherwise the caller relies on the journal for replay. */
  send(msg: RunnerToControl): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  /** Forcibly drops the socket without stopping (tests and partition simulation). */
  drop(): void {
    this.ws?.terminate()
  }

  private connect(): void {
    const url = `${this.opts.controlUrl.replace(/^http/, 'ws')}/runner/ws`
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: 10_000,
    })
    this.ws = ws

    ws.on('open', async () => {
      this.backoffMs = 1_000
      try {
        ws.send(JSON.stringify(await this.opts.hello()))
      } catch (err) {
        this.opts.log.error('hello failed', { err: String(err) })
        ws.close()
      }
    })
    ws.on('message', (data) => {
      let msg: ControlToRunner
      try {
        msg = ControlToRunner.parse(JSON.parse(data.toString()))
      } catch {
        this.opts.log.warn('invalid control message')
        return
      }
      if (msg.type === 'welcome') this.ready = true
      this.opts.onMessage(msg)
    })
    ws.on('unexpected-response', (_req, res) => {
      this.opts.log.error('control refused the connection', { status: res.statusCode })
    })
    ws.on('error', (err) => this.opts.log.warn('connection error', { err: err.message }))
    ws.on('close', (code, reason) => {
      const wasReady = this.ready
      this.ready = false
      if (this.ws === ws) this.ws = null
      if (wasReady) this.opts.onDisconnect?.()
      if (this.stopped) return
      this.opts.log.info('disconnected', { code, reason: reason.toString(), retryInMs: this.backoffMs })
      this.timer = setTimeout(() => this.connect(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
    })
  }
}
