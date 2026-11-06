/**
 * Owner ruling: a restart comes back on the last port, so an open tab stays connected. A taken
 * port falls back to an ephemeral one and the caller says so; the new port is the one remembered.
 */
import type { Store } from '@mec/contracts'
import type { FastifyInstance } from 'fastify'

const PORT_DOC = 'settings/server-port'
const HOST = '127.0.0.1'

export type PortMove = { from: number; to: number }

function lastPort(store: Store): number | undefined {
  const port = store.engines.get(PORT_DOC)?.port
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

type Listener = Pick<FastifyInstance, 'listen' | 'server'>

function boundPort(app: Listener): number {
  const address = app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`unexpected listen address: ${JSON.stringify(address)}`)
  }
  return address.port
}

export async function listenEphemeral(app: Listener): Promise<{ port: number; moved?: PortMove }> {
  await app.listen({ port: 0, host: HOST })
  return { port: boundPort(app) }
}

export async function listenOnLastPort(
  app: Listener,
  store: Store,
  at: string,
): Promise<{ port: number; moved?: PortMove }> {
  const last = lastPort(store)
  let taken = false
  try {
    await app.listen({ port: last ?? 0, host: HOST })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || last === undefined) throw error
    taken = true
    await app.listen({ port: 0, host: HOST })
  }
  const port = boundPort(app)
  if (port !== last) store.atomic(() => store.engines.save({ id: PORT_DOC, port, updatedAt: at }))
  return { port, ...(taken && last !== undefined && { moved: { from: last, to: port } }) }
}
