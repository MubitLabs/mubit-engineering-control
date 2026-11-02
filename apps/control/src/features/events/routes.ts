import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Sql } from '../../db/sql'
import { projectStream, readStream, type StoredEvent } from '../../events/append'
import type { EventBus } from '../../events/bus'
import { authorize, requireActor } from '../../http/actor'
import { parse } from '../../http/errors'
import { loadProject } from '../projects/routes'

const KEEPALIVE_MS = 15_000
const BATCH = 500

export function registerEvents(app: FastifyInstance, deps: { sql: Sql; bus: EventBus }) {
  const { sql, bus } = deps

  /** Paged history for one project stream. */
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/events/history', async (req) => {
    const actor = await requireActor(sql, req)
    const project = await loadProject(sql, req.params.projectId)
    authorize(actor, 'observe', { kind: 'project', projectId: project.id })
    const q = parse(
      z.object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(BATCH).default(100),
      }),
      req.query,
    )
    return { events: await readStream(sql, projectStream(project.id), q.after, q.limit) }
  })

  /**
   * Server-sent events with a resume cursor (PDF §24, §26). The SSE `id` is the stream sequence,
   * so a reconnecting browser sends Last-Event-ID and receives exactly what it missed.
   */
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/events', async (req, reply) => {
    const actor = await requireActor(sql, req)
    const project = await loadProject(sql, req.params.projectId)
    authorize(actor, 'observe', { kind: 'project', projectId: project.id })
    const q = parse(z.object({ after: z.coerce.number().int().min(0).optional() }), req.query)
    const header = Number(req.headers['last-event-id'])
    let cursor = Number.isInteger(header) && header >= 0 ? header : (q.after ?? 0)
    const stream = projectStream(project.id)

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')

    let closed = false
    let running = false
    let again = false
    const write = (e: StoredEvent) => {
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
      cursor = e.seq
    }
    const flush = async () => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          let batch: StoredEvent[]
          do {
            batch = await readStream(sql, stream, cursor, BATCH)
            if (closed) return
            for (const e of batch) write(e)
          } while (batch.length === BATCH)
        } while (again && !closed)
      } catch (err) {
        req.log.warn({ err }, 'sse flush failed')
      } finally {
        running = false
      }
    }

    const unsubscribe = bus.subscribe(stream, () => void flush())
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n')
      void flush()
    }, KEEPALIVE_MS)
    const close = () => {
      closed = true
      clearInterval(keepalive)
      unsubscribe()
    }
    req.raw.on('close', close)
    res.on('error', close)
    await flush()
  })
}
