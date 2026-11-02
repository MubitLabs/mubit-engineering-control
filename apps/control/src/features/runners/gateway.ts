import { createHash, randomUUID } from 'node:crypto'
import websocket from '@fastify/websocket'
import { type ControlToRunner, RunnerToControl } from '@mec/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Sql } from '../../db/sql'
import { markCommandResult } from '../../outbox/commands'
import type { CommandDispatcher } from '../../outbox/dispatcher'
import {
  failRejectedCommand,
  ingestRunnerEvent,
  markRunnerOffline,
  reconcileHello,
  renewLeases,
} from './ingest'
import type { RunnerRegistry } from './registry'

const HELLO_TIMEOUT_MS = 10_000
/** Closes connections whose runner has gone silent (missed heartbeats). */
const SILENCE_TIMEOUT_MS = 45_000

export const hashRunnerToken = (token: string) => createHash('sha256').update(token).digest('hex')

declare module 'fastify' {
  interface FastifyRequest {
    runnerId?: string
  }
}

async function authenticate(sql: Sql, req: FastifyRequest): Promise<string | null> {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return null
  const [runner] = await sql<{ id: string }[]>`
    select id from runners where token_hash = ${hashRunnerToken(token)} and revoked_at is null
  `
  return runner?.id ?? null
}

/**
 * The runner WebSocket (PDF §6, §25). Runners connect outbound with their device token; control
 * persists each event before acknowledging it, and delivers commands from the outbox.
 */
export async function registerRunnerGateway(
  app: FastifyInstance,
  deps: { sql: Sql; registry: RunnerRegistry; dispatcher: CommandDispatcher; leaseTtlMs: number },
) {
  const { sql, registry, dispatcher, leaseTtlMs } = deps
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } })

  app.addHook('preClose', async () => registry.closeAll())

  app.get(
    '/runner/ws',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const runnerId = await authenticate(sql, req)
        if (!runnerId) return reply.code(401).send({ error: 'unauthorized', message: 'Invalid runner token' })
        req.runnerId = runnerId
      },
    },
    (socket, req) => {
      const runnerId = req.runnerId!
      const connectionId = randomUUID()
      const log = req.log.child({ runnerId, connectionId })
      let ready = false
      let lastHeard = Date.now()
      // Messages are handled strictly in order so acknowledgements follow persistence order.
      let chain: Promise<void> = Promise.resolve()

      const send = (msg: ControlToRunner) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
      }
      const helloTimer = setTimeout(() => {
        if (!ready) socket.close(4002, 'no hello')
      }, HELLO_TIMEOUT_MS)
      const silence = setInterval(() => {
        if (Date.now() - lastHeard > SILENCE_TIMEOUT_MS) socket.close(4003, 'heartbeat timeout')
      }, 5_000)

      const handle = async (raw: string) => {
        let msg: ReturnType<typeof RunnerToControl.parse>
        try {
          msg = RunnerToControl.parse(JSON.parse(raw))
        } catch (err) {
          log.warn({ err }, 'invalid runner message')
          send({ type: 'error', code: 'invalid_message', message: 'Message did not match the protocol' })
          return
        }
        if (!ready && msg.type !== 'hello') return

        switch (msg.type) {
          case 'hello': {
            const acked = await reconcileHello(sql, runnerId, msg)
            // Anything sent on a previous connection may have been lost with it.
            await sql`
              update outbox set sent_at = null
              where topic = 'runner.command' and target = ${runnerId} and delivered_at is null
            `
            registry.add({
              runnerId,
              connectionId,
              send,
              close: (code, reason) => socket.close(code, reason),
            })
            ready = true
            clearTimeout(helloTimer)
            send({ type: 'welcome', runnerId, serverTime: new Date().toISOString(), acked })
            void dispatcher.kick(runnerId)
            log.info({ attempts: msg.attempts.length }, 'runner connected')
            return
          }
          case 'event': {
            const outcome = await ingestRunnerEvent(sql, runnerId, msg.event)
            if (outcome.kind === 'rejected')
              log.warn({ reason: outcome.reason, event: msg.event.eventId }, 'event rejected')
            // Rejected events are acknowledged too; replaying them forever would not help.
            send({
              type: 'ack',
              attemptId: msg.event.attemptId,
              sequence: msg.event.sequence,
              eventId: msg.event.eventId,
            })
            return
          }
          case 'heartbeat':
            await renewLeases(sql, runnerId, msg.attempts, leaseTtlMs)
            return
          case 'command_result':
            await markCommandResult(sql, runnerId, msg.commandId, msg.status, msg.reason)
            if (msg.status === 'rejected') {
              await failRejectedCommand(sql, runnerId, msg.commandId, msg.reason ?? 'rejected')
            }
            return
        }
      }

      socket.on('message', (data) => {
        lastHeard = Date.now()
        const raw = data.toString()
        chain = chain.then(() => handle(raw)).catch((err) => log.error({ err }, 'runner message failed'))
      })
      socket.on('close', () => {
        clearTimeout(helloTimer)
        clearInterval(silence)
        if (registry.remove(runnerId, connectionId)) {
          void chain.then(() => markRunnerOffline(sql, runnerId)).catch(() => {})
          log.info('runner disconnected')
        }
      })
    },
  )
}
