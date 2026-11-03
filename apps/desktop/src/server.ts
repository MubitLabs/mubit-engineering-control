/**
 * The composition server (plan §21): one fastify app wiring the landed packages behind the
 * HTTP surface the workbench speaks — chat intake through `@mec/meta` routing, the
 * confirmation inbox through `@mec/policy`'s compare-and-set, work views over `@mec/domain`
 * states, SSE over the store's event log and the §21.2 status snapshot.
 *
 * This module is transport only: every decision belongs to a package, the routes translate
 * HTTP to those seams and back. `composition.ts` builds the real deps (SQLite, health
 * writer, mec-tools); tests inject `MemoryRepositories` and a fake board.
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Socket } from 'node:net'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Effects, HealthBoard, HealthName, Json, Store, StoreDoc } from '@mec/contracts'
import { WORK_ITEM_TERMINAL, type WorkItemState } from '@mec/domain'
import type { LiveWork } from '@mec/meta'
import { routeMessage } from '@mec/meta'
import type { ConfirmationRecord } from '@mec/policy'
import { resolveConfirmation } from '@mec/policy'
import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthSnapshot, PartEntry } from './health'
import { type CardEvent, LoginCardManager } from './login-cards'

export type ServerDeps = {
  store: Store
  effects: Effects
  health: HealthBoard
  policyText: string
  now?: () => Date
  /** §5.6 login terminal cards; a default manager is built when absent. */
  loginCards?: LoginCardManager
}

/**
 * The marker doc whose presence means a repository is registered. Repository registration
 * (B2) writes it; until then its absence honestly reports `has_repository: false`. Looked
 * up by its dedicated id — never by "the engines repo is non-empty", which would confuse an
 * installed engine with a registered repository.
 */
const SETTINGS_REPOSITORIES_ID = 'settings/repositories'

/** The built workbench (`apps/web`); served at `/*` with an SPA fallback when present. */
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url))

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

const SSE_POLL_MS = 500

let idCounter = 0

/** A contract-shaped id (`msg_…`, `wi_…`): clock + counter + random, url-safe by construction. */
function freshId(prefix: string): string {
  idCounter += 1
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${randomBytes(4).toString('hex')}`
}

/**
 * The snapshot `mec status` and `/api/status` share (plan §21.2). The runtime is ready once
 * the server is built — this app has no starting window of its own. The parts view is read
 * live from boards that expose `names()`/`entry()` (the `HealthBoardImpl` the composition
 * root uses does): the contracts interface deliberately carries no snapshot seam, so nothing
 * is added to it here. A board without that surface contributes no parts — what the server
 * cannot see is reported as unknown, never healthy (§21.2).
 */
export function buildHealthSnapshot(store: Store, health: HealthBoard): HealthSnapshot {
  return {
    runtime: { state: 'ready', instances: 1, answering: true },
    parts: partsOf(health),
    setup: {
      has_slot: store.slots.list().length > 0,
      has_repository: store.engines.get(SETTINGS_REPOSITORIES_ID) !== undefined,
    },
  }
}

function partsOf(health: HealthBoard): Record<string, PartEntry> {
  const board = health as HealthBoard & {
    names?: () => unknown[]
    entry?: (name: HealthName) => { state: string; detail?: string } | undefined
  }
  if (typeof board.names !== 'function' || typeof board.entry !== 'function') return {}
  const parts: Record<string, PartEntry> = {}
  for (const name of board.names()) {
    const entry = board.entry(name as HealthName)
    if (entry === undefined) continue
    parts[String(name)] = toPartEntry(entry)
  }
  return parts
}

/** §19 claim states → §21.2 part states: paused is deliberate idleness, starting is not yet usable. */
function toPartEntry(entry: { state: string; detail?: string }): PartEntry {
  if (entry.state === 'error')
    return { state: 'error', ...(entry.detail !== undefined && { detail: entry.detail }) }
  if (entry.state === 'starting') return { state: 'degraded', detail: entry.detail ?? 'starting' }
  return { state: 'ok', ...(entry.detail !== undefined && { detail: entry.detail }) }
}

/** Live work for routing (§12.1): work items that are neither done nor stopped. */
function liveWorkOf(store: Store): LiveWork[] {
  return store.workItems
    .list()
    .filter((doc) => !WORK_ITEM_TERMINAL.includes(String(doc.state) as WorkItemState))
    .map((doc) => ({
      workItemId: String(doc.id),
      tasks: store.tasks.list({ workItemId: doc.id }).map((task) => ({
        taskId: String(task.id),
        status: typeof task.status === 'string' ? task.status : 'ready',
      })),
      openQuestions: [],
      stopped: false,
    }))
}

/** Appends `type` as the stream's next gap-free event; callers stay inside their transaction. */
function appendEvent(store: Store, stream: string, type: string, body: Json, at: string): void {
  const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
  store.events.append(stream, { stream, seq, at, type, body })
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const store = deps.store
  const now = deps.now ?? (() => new Date())
  // §5.6 login cards: shared per server so logins stay serialised machine-wide;
  // tests inject one with a fake pty, everyone else gets the default manager.
  const loginCards = deps.loginCards ?? new LoginCardManager()
  const app = Fastify({ logger: false })

  app.get('/healthz', async () => ({ ok: true }))

  app.get('/api/status', async () => buildHealthSnapshot(store, deps.health))

  app.post('/api/chat/messages', async (request, reply) => {
    const body = (request.body ?? {}) as { text?: unknown; referencesWorkItem?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') {
      reply.code(400).send({ error: 'text is required' })
      return
    }
    const referencesWorkItem =
      typeof body.referencesWorkItem === 'string' && body.referencesWorkItem !== ''
        ? body.referencesWorkItem
        : undefined
    const header = request.headers['idempotency-key']
    const headerText = Array.isArray(header) ? header[0] : header
    const idempotencyKey = typeof headerText === 'string' && headerText !== '' ? headerText : undefined

    // Idempotent by the client's key: the first answer is replayed verbatim, no second write.
    if (idempotencyKey !== undefined) {
      const replay = store.messages.list({ idempotencyKey }).at(0)
      if (replay !== undefined) {
        return {
          messageId: String(replay.id),
          ...(typeof replay.workItemId === 'string' && { workItemId: replay.workItemId }),
          routing: 'duplicate',
        }
      }
    }

    const messageId = freshId('msg_')
    const at = now().toISOString()
    return store.atomic(() => {
      const message: StoreDoc = {
        id: messageId,
        text,
        createdAt: at,
        ...(referencesWorkItem !== undefined && { referencesWorkItem }),
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      }

      const decision = routeMessage({ referencesWorkItem, liveWork: liveWorkOf(store) })

      let workItemId: string | undefined
      if (decision.action === 'new_work') {
        workItemId = freshId('wi_')
        store.workItems.save({
          id: workItemId,
          state: 'admitted',
          mandate: { originMessageId: messageId },
          originMessageId: messageId,
          createdAt: at,
          updatedAt: at,
        })
        appendEvent(store, `work:${workItemId}`, 'work_admitted', { workItemId, messageId, at }, at)
      } else if (decision.action === 'attach') {
        workItemId = decision.workItemId
        appendEvent(store, `work:${workItemId}`, 'message_attached', { workItemId, messageId, at }, at)
      }
      // 'conversation' stores nothing beyond the message. A reference that resolves to a
      // stopped work item does not bind either (§12.1: stopped mandates never resume
      // silently), so the message lands as unattached conversation.

      if (workItemId !== undefined) message.workItemId = workItemId
      store.messages.save(message)
      return { messageId, ...(workItemId !== undefined && { workItemId }), routing: decision.action }
    })
  })

  app.get('/api/chat/messages', async () => {
    const messages = store.messages.list()
    return [...messages].sort(
      (a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)),
    )
  })

  app.get('/api/inbox', async () =>
    store.confirmations.list({ status: 'pending' }).map((doc) => ({
      id: String(doc.id),
      cls: String(doc.cls ?? ''),
      operationHash: String(doc.operationHash ?? ''),
      expiresAt: String(doc.expiresAt ?? ''),
    })),
  )

  app.post('/api/inbox/:id/resolve', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const body = (request.body ?? {}) as { answer?: unknown }
    if (body.answer !== 'approve' && body.answer !== 'deny') {
      reply.code(400).send({ error: "answer must be 'approve' or 'deny'" })
      return
    }
    const doc = store.confirmations.get(id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'confirmation not found' })
      return
    }
    const pending = doc as unknown as ConfirmationRecord
    try {
      const { outcome } = resolveConfirmation(pending, {
        now: now().toISOString(),
        answer: body.answer,
        // The card's own hash is the expected one: the user answered what they saw.
        expectedOperationHash: typeof pending.operationHash === 'string' ? pending.operationHash : '',
      })
      store.atomic(() => {
        store.confirmations.save(outcome as unknown as StoreDoc)
      })
      return { id: outcome.id, status: outcome.status }
    } catch (error) {
      // The first answer won (§13): a second resolve is a CAS race, not a server error.
      if (error instanceof Error && error.message.startsWith('already_handled')) {
        reply.code(409).send({ error: 'already_handled', status: pending.status })
        return
      }
      throw error
    }
  })

  app.get('/api/work', async () =>
    store.workItems.list().map((doc) => {
      const id = String(doc.id)
      const tasks = store.tasks.list({ workItemId: id })
      const byStatus: Record<string, number> = {}
      for (const task of tasks) {
        const status = typeof task.status === 'string' ? task.status : 'ready'
        byStatus[status] = (byStatus[status] ?? 0) + 1
      }
      const state = typeof doc.state === 'string' ? doc.state : 'admitted'
      return {
        id,
        state,
        // The §10 first-match stage projection lands with the scheduler milestone; until
        // then the work item's own lifecycle state is the honest stage.
        stage: state,
        taskCounts: { total: tasks.length, byStatus },
        updatedAt: String(doc.updatedAt ?? ''),
      }
    }),
  )

  app.post('/api/slots/login', async (request, reply) => {
    const body = (request.body ?? {}) as { engine?: unknown; slotHome?: unknown }
    const { engine } = body
    if (engine !== 'claude' && engine !== 'codex' && engine !== 'opencode') {
      reply.code(400).send({ error: "engine must be 'claude', 'codex' or 'opencode'" })
      return
    }
    const slotHome = typeof body.slotHome === 'string' ? body.slotHome.trim() : ''
    if (slotHome === '') {
      reply.code(400).send({ error: 'slotHome is required' })
      return
    }
    // §5.6 serialised: while a card runs, this returns the running card's id with
    // busy=true and spawns nothing — the client's terminal attaches to that card
    // through /api/slots/login/current. The POST itself never sees stream data.
    const started = loginCards.start({ engine, slotHome }, () => {})
    return { id: started.id, busy: started.busy }
  })

  // §5.6: the login stream is live-only. It is never journaled or persisted, and
  // this endpoint replays nothing — a subscriber sees card events from the moment
  // it attaches until the card's terminal event (exit/timeout) ends the stream.
  app.get('/api/slots/login/current', (_request, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.on('error', () => {})
    let detach: (() => void) | null = null
    const finish = (): void => {
      detach?.()
      raw.end()
    }
    const onEvent = (event: CardEvent): void => {
      if (raw.writableEnded) return
      raw.write(`data: ${JSON.stringify(event)}\n\n`)
      if (event.kind === 'exit' || event.kind === 'timeout') finish()
    }
    detach = loginCards.subscribe(onEvent)
    if (detach === null) {
      // Nothing is running and, by design, there is no backlog to serve (§5.6).
      raw.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      raw.end(JSON.stringify({ error: 'no login card running' }))
      return
    }
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // A mocked transport (fastify `.inject`) has no real socket to hold open: end
    // immediately, exactly like /api/events. A real connection stays open below.
    if (!(raw.socket instanceof Socket)) {
      finish()
      return
    }
    raw.on('close', () => {
      detach?.()
      raw.end()
    })
  })

  app.post('/api/slots/login/cancel', async (request, reply) => {
    const body = (request.body ?? {}) as { id?: unknown }
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      reply.code(400).send({ error: 'id is required' })
      return
    }
    const activeCard = loginCards.active()
    if (activeCard === null || activeCard.id !== id) {
      reply.code(404).send({ error: 'no such login card' })
      return
    }
    loginCards.cancel(id)
    reply.code(204).send()
  })

  app.get('/api/events', (request, reply) => {
    const query = (request.query ?? {}) as { stream?: string; after?: string }
    const stream = typeof query.stream === 'string' ? query.stream : ''
    if (stream === '') {
      reply.code(400).send({ error: 'stream is required' })
      return
    }
    const after = Number.parseInt(query.after ?? '0', 10)
    let cursor = Number.isFinite(after) && after >= 0 ? after : 0

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const flush = (): void => {
      for (const event of store.events.read(stream, cursor)) {
        raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
        cursor = event.seq
      }
    }
    raw.on('error', () => {})
    flush()

    // A mocked transport (fastify `.inject`) has no real socket to hold open: the backlog is
    // the whole body, so flush and end. A real connection long-polls below.
    if (!(raw.socket instanceof Socket)) {
      raw.end()
      return
    }
    const timer = setInterval(() => {
      try {
        flush()
      } catch {
        // A read must never kill the poll loop; the next pass tries again.
      }
    }, SSE_POLL_MS)
    timer.unref()
    raw.on('close', () => {
      clearInterval(timer)
      raw.end()
    })
  })

  if (existsSync(WEB_DIST)) {
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        reply.code(404).send({ error: 'not found' })
        return
      }
      const path = decodePath(request.url.split('?')[0] ?? '/')
      const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
      const candidate =
        segments.length === 0 ? resolve(WEB_DIST, 'index.html') : resolve(WEB_DIST, ...segments)
      const withinRoot = candidate === WEB_DIST || candidate.startsWith(WEB_DIST + sep)
      const isFile = withinRoot && existsSync(candidate) && statSync(candidate).isFile()
      // SPA fallback: anything that is not a file on disk resolves to the app shell.
      const file = isFile ? candidate : resolve(WEB_DIST, 'index.html')
      if (!existsSync(file)) {
        reply.code(404).send({ error: 'not found' })
        return
      }
      reply.header('content-type', MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
      reply.send(createReadStream(file))
    })
  }

  return app
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return '/'
  }
}
