import { chmod, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { readJsonLines } from '../adapter'

/**
 * The per-attempt bridge between Claude's `mec` MCP server (a child of the Claude process) and the
 * runner. It is a Unix socket only the runner user can open; requests are JSON lines
 * `{id, method, params}` answered with `{id, result}` or `{id, error}`.
 */
export type BridgeHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>

export interface Bridge {
  socketPath: string
  close(): Promise<void>
}

export async function startBridge(socketPath: string, handle: BridgeHandler): Promise<Bridge> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  await rm(socketPath, { force: true })
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    readJsonLines(socket, (msg) => {
      const id = msg.id
      const reply = (body: Record<string, unknown>) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...body })}\n`)
      }
      handle(String(msg.method ?? ''), (msg.params as Record<string, unknown>) ?? {}).then(
        (result) => reply({ result }),
        (err: Error) => reply({ error: err.message }),
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  await chmod(socketPath, 0o600)
  return {
    socketPath,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketPath, { force: true })
    },
  }
}

/** Client side, used by the MCP server program. */
export function connectBridge(socketPath: string) {
  const socket = net.createConnection(socketPath)
  let next = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  readJsonLines(socket, (msg) => {
    const p = pending.get(Number(msg.id))
    if (!p) return
    pending.delete(Number(msg.id))
    if (typeof msg.error === 'string') p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  })
  socket.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('bridge closed'))
    pending.clear()
  })
  return {
    call(method: string, params: Record<string, unknown>): Promise<unknown> {
      const id = next++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
    close() {
      socket.end()
    },
  }
}
