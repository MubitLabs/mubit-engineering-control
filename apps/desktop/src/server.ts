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
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Effects, HealthBoard, HealthName, Json, Store, StoreDoc } from '@mec/contracts'
import { matchesSecret, SECRET_PATTERNS } from '@mec/contracts'
import { WORK_ITEM_TERMINAL, type WorkItemState } from '@mec/domain'
import type { LiveWork } from '@mec/meta'
import { routeMessage } from '@mec/meta'
import type { ConfirmationRecord } from '@mec/policy'
import { resolveConfirmation } from '@mec/policy'
import { claudeHome, redact, SlotKeystore } from '@mec/slots'
import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthSnapshot, PartEntry } from './health'
import { type CardEvent, LoginCardManager } from './login-cards'
import {
  createPrBehindCard,
  defaultGhRun,
  type GhRun,
  mergeBehindCard,
  openMergeCard,
  type ReleaseDeps,
  resolvePrCreate,
} from './release'

export type ServerDeps = {
  store: Store
  effects: Effects
  health: HealthBoard
  policyText: string
  now?: () => Date
  /** §5.6 login terminal cards; a default manager is built when absent. */
  loginCards?: LoginCardManager
  /**
   * §5.4 root the engines tree hangs off: slot homes land at
   * `<keystoreRoot>/engines/<engine>/<slot>` and key files at
   * `<keystoreRoot>/engines/<engine>/<slot>/keys/<provider>.key` (0600, nowhere else).
   * Defaults to `~/.mec`, so keys live under `~/.mec/engines/…` exactly as §5.4 states.
   */
  keystoreRoot?: string
  /**
   * §5.8 zero-token validators run through this seam; tests inject a stub, production
   * gets `globalThis.fetch`. The key read straight from the keystore file travels only
   * into the request headers — never into the store, events or logs.
   */
  validateFetch?: typeof globalThis.fetch
  /**
   * §14/R1.7: the release agent's gh runner — argv-only through the user's own `gh`
   * (default `defaultGhRun`); tests inject a recording fake so no route ever touches a
   * real repository.
   */
  ghRun?: GhRun
  /** The store release cards and prflow docs live in; defaults to the composed store. */
  repoStore?: Store
  /** Present in the composed app: the chat route delegates message+work+plan+launch to it. */
  metaAgent?: {
    onUserMessage(input: { messageId: string; text: string; referencesWorkItem?: string }): Promise<{
      acknowledged: string
      workItemId?: string
      tasksCreated: number
      launchesEnqueued: string[]
      escalated: boolean
    }>
  }
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

/** §5.4 default keystore root: the engines tree under `~/.mec`. */
const DEFAULT_KEYSTORE_ROOT = join(homedir(), '.mec')

/** §5.8 zero-token validity probe for Anthropic API keys: GET /v1/models costs no tokens. */
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const VALIDATE_TIMEOUT_MS = 15_000

/**
 * §5.4/§5.7: the anthropic key shape — contracts' `SECRET_PATTERNS[0]`. The gate a pasted
 * key must pass before MEC writes anything anywhere.
 */
const ANTHROPIC_KEY_PATTERN = SECRET_PATTERNS[0]?.pattern

/**
 * The claude-api slot doc kept in the store's slots repo: {id, label, engine, kind,
 * provider, fingerprint, state} — the fingerprint (provider, last4, salted SHA-256) is the
 * ONLY secret-adjacent thing in it; the key itself lives in the keystore file, never here.
 */
type ApiSlotDoc = {
  id: string
  label: string
  engine: 'claude'
  kind: 'claude-api'
  provider: 'anthropic-api'
  home: string
  fingerprint?: { provider: string; last4: string; hash: string }
  state: string
  state_reason?: string
  last_probe_at?: string
  createdAt: string
  updatedAt: string
}

/** Reads one slot doc by id, narrowed to the claude-api shape these routes write. */
function slotDocOf(store: Store, id: string): ApiSlotDoc | undefined {
  const doc = store.slots.get(id)
  return doc === undefined ? undefined : (doc as unknown as ApiSlotDoc)
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
  // §5.4 where slot homes (and only they) hold keys; §5.8 transport for the zero-token probe.
  const keystoreRoot = deps.keystoreRoot ?? DEFAULT_KEYSTORE_ROOT
  const validateFetch = deps.validateFetch ?? globalThis.fetch
  // §14/R1.7: the release agent's gh leg — cards settle in the same store the inbox reads
  // (a test may inject either seam); every gh call is argv-only, bodies by stdin.
  const releaseDeps: ReleaseDeps = {
    run: deps.ghRun ?? defaultGhRun,
    store: deps.repoStore ?? store,
    effects: deps.effects,
    now,
  }
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
    // §26 Secrets-in-chat: a key-shaped message is stored REDACTED and answered with the
    // Slots pointer — the key never becomes durable, and the user learns the right door.
    if (matchesSecret(text)) {
      const redacted = redact(text, [], [])
      const messageId = freshId('msg_')
      store.atomic(() => {
        store.messages.save({
          id: messageId,
          text: redacted,
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
          routing: 'conversation',
          secretGuard: true,
        })
      })
      reply.code(200).send({
        messageId,
        routing: 'conversation',
        secretGuard: true,
        message:
          'That looked like an API key — it was redacted before storage. Add keys in the Slots panel (mec slot add) instead.',
      })
      return
    }
    const referencesWorkItem =
      typeof body.referencesWorkItem === 'string' && body.referencesWorkItem !== ''
        ? body.referencesWorkItem
        : undefined
    // Clients send `x-idempotency-key` (the web api module); the bare form is accepted too.
    const header = request.headers['x-idempotency-key'] ?? request.headers['idempotency-key']
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

    // Composed path: the meta-agent service owns message persistence, routing, the ack,
    // the plan and the launch enqueues (§6). The route only adds the idempotency key.
    if (deps.metaAgent !== undefined) {
      const outcome = await deps.metaAgent.onUserMessage({ messageId, text, referencesWorkItem })
      if (idempotencyKey !== undefined) {
        store.atomic(() => {
          const doc = store.messages.get(messageId)
          if (doc !== undefined) store.messages.save({ ...doc, idempotencyKey })
        })
      }
      return {
        messageId,
        ...(outcome.workItemId !== undefined && { workItemId: outcome.workItemId }),
        routing:
          outcome.workItemId === undefined
            ? 'conversation'
            : outcome.tasksCreated > 0
              ? 'new_work'
              : 'attach',
        acknowledged: outcome.acknowledged,
        tasksCreated: outcome.tasksCreated,
        launchesEnqueued: outcome.launchesEnqueued.length,
      }
    }

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
        // A repo-bound confirmation binds to the SHA on the card; the record's own value is
        // what the card rendered (audit #5 — absent, every bound resolution went stale).
        expectedInputSha: typeof pending.inputSha === 'string' ? pending.inputSha : undefined,
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

  // §5.7 API-key courier — the form is the ONLY way a key enters MEC. The key travels from
  // the request body straight into the slot keystore (`claudeHome(root, label)` + SlotKeystore,
  // 0600) and appears in NO response, event or store doc: the store keeps the fingerprint
  // (provider, last4, salted SHA-256) only, per §5.4.
  app.post('/api/slots/api-key', async (request, reply) => {
    const body = (request.body ?? {}) as { label?: unknown; provider?: unknown; key?: unknown }
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (label === '') {
      reply.code(400).send({ error: 'label is required' })
      return
    }
    if (body.provider !== 'anthropic-api') {
      reply.code(400).send({ error: "provider must be 'anthropic-api' (v0)" })
      return
    }
    // A pasted key may carry clipboard whitespace; the pattern gate runs on the trimmed form.
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (key === '' || ANTHROPIC_KEY_PATTERN === undefined || !ANTHROPIC_KEY_PATTERN.test(key)) {
      reply.code(400).send({ error: 'key does not match the anthropic key pattern' })
      return
    }

    const id = `slot_${label}`
    if (store.slots.get(id) !== undefined) {
      reply.code(409).send({ error: 'a slot with that label already exists — retire it first' })
      return
    }

    // §5.3: the slot home is created (and validated as a single path segment) before anything
    // is written into it. An escaping label dies here, before any file exists.
    let home: ReturnType<typeof claudeHome>
    try {
      home = claudeHome(keystoreRoot, label)
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid slot label' })
      return
    }

    const keystore = new SlotKeystore(home.homeDir)
    let fingerprint: { provider: string; last4: string; hash: string }
    try {
      fingerprint = keystore.store('anthropic-api', key)
    } catch (error) {
      // The only expected cause is a key file left behind by a doc-less slot (§5.7: rotation
      // replaces, store never clobbers); anything else is a genuine IO failure.
      if (error instanceof Error && error.message.includes('already exists')) {
        reply.code(409).send({ error: 'a key for this slot already exists on disk' })
        return
      }
      throw error
    }

    const at = now().toISOString()
    store.atomic(() => {
      store.slots.save({
        id,
        label,
        engine: 'claude',
        kind: 'claude-api',
        provider: 'anthropic-api',
        home: home.homeDir,
        fingerprint,
        state: 'login_pending',
        createdAt: at,
        updatedAt: at,
      })
      appendEvent(
        store,
        `slot:${label}`,
        'slot_created',
        { slotId: id, label, kind: 'claude-api', provider: 'anthropic-api', fingerprint, at },
        at,
      )
    })
    // The response carries identity + fingerprint only — never the key, in any form.
    return { id, fingerprint: { provider: fingerprint.provider, last4: fingerprint.last4 } }
  })

  // §5.8 zero-token validity probe: GET /v1/models with the key read STRAIGHT from the
  // keystore file (§5.4 read path #2). 200 → healthy; 401 → degraded/key_rejected; a network
  // failure is provider_unreachable and changes nothing — an unreachable provider says
  // nothing about the key. 15s cap via AbortController.
  app.post('/api/slots/:id/validate', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = slotDocOf(store, id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'slot not found' })
      return
    }
    if (doc.kind !== 'claude-api' || doc.provider !== 'anthropic-api') {
      reply.code(400).send({ error: "only 'claude-api' slots validate in v0" })
      return
    }
    if (doc.state === 'retired') {
      reply.code(409).send({ error: 'slot is retired' })
      return
    }
    const key = new SlotKeystore(doc.home).read(doc.provider)
    if (key === undefined) {
      reply.code(409).send({ error: 'no key stored for this slot' })
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS)
    timer.unref()
    let outcome: { ok: true } | { ok: false; reason: 'key_rejected' | 'provider_unreachable' }
    try {
      const res = await validateFetch(ANTHROPIC_MODELS_URL, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: controller.signal,
      })
      if (res.ok) outcome = { ok: true }
      else if (res.status === 401) outcome = { ok: false, reason: 'key_rejected' }
      else outcome = { ok: false, reason: 'provider_unreachable' }
    } catch {
      outcome = { ok: false, reason: 'provider_unreachable' }
    } finally {
      clearTimeout(timer)
    }

    const at = now().toISOString()
    if (outcome.ok) {
      store.atomic(() => {
        const next: StoreDoc = { ...doc, state: 'healthy', last_probe_at: at, updatedAt: at }
        delete next.state_reason
        store.slots.save(next)
        appendEvent(
          store,
          `slot:${doc.label}`,
          'slot_healthy',
          { slotId: id, probe: 'anthropic:/v1/models', at },
          at,
        )
      })
      return { ok: true }
    }
    if (outcome.reason === 'key_rejected') {
      store.atomic(() => {
        store.slots.save({
          ...doc,
          state: 'degraded',
          state_reason: 'key_rejected',
          last_probe_at: at,
          updatedAt: at,
        })
        appendEvent(
          store,
          `slot:${doc.label}`,
          'slot_degraded',
          { slotId: id, reason: 'key_rejected', at },
          at,
        )
      })
      return { ok: false, reason: 'key_rejected' }
    }
    // provider_unreachable: no transition, no event — the slot keeps its state (§5.8).
    return { ok: false, reason: 'provider_unreachable' }
  })

  // §5.7 "deleting a slot shreds its keystore": the key file's bytes are scrambled and
  // unlinked; the doc moves to retired with the fingerprint kept for display/redaction.
  app.post('/api/slots/:id/retire', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = slotDocOf(store, id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'slot not found' })
      return
    }
    new SlotKeystore(doc.home).shred(doc.provider)
    const at = now().toISOString()
    store.atomic(() => {
      const next: StoreDoc = { ...doc, state: 'retired', updatedAt: at }
      delete next.state_reason
      store.slots.save(next)
      appendEvent(store, `slot:${doc.label}`, 'slot_retired', { slotId: id, at }, at)
    })
    return { id, state: 'retired' }
  })

  // Fingerprints only — every doc in the slots repo is key-free by construction; the
  // projection makes that explicit rather than accidental.
  app.get('/api/slots', async () =>
    store.slots.list().map((doc) => {
      const slot = doc as unknown as ApiSlotDoc
      return {
        id: slot.id,
        label: slot.label,
        engine: slot.engine,
        kind: slot.kind,
        provider: slot.provider,
        state: slot.state,
        ...(slot.state_reason !== undefined && { stateReason: slot.state_reason }),
        ...(slot.fingerprint !== undefined && {
          fingerprint: { provider: slot.fingerprint.provider, last4: slot.fingerprint.last4 },
        }),
        home: slot.home,
      }
    }),
  )

  // §14/R1.7 — the release agent's GitHub leg. `pr_create` and `pr_merge` are
  // always-confirm classes (§13): the create routes only OPEN cards (nothing leaves the
  // machine unresolved); the resolve routes re-check existence, pending status and class
  // before anything runs, settle the card, and only then call the user's gh.
  app.post('/api/release/pr', async (request, reply) => {
    const body = (request.body ?? {}) as { repo?: unknown; branch?: unknown; title?: unknown; body?: unknown }
    const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
    const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const prBody = typeof body.body === 'string' ? body.body : ''
    if (repo === '' || branch === '' || title === '') {
      reply.code(400).send({ error: 'repo, branch and title are required' })
      return
    }
    return createPrBehindCard(releaseDeps, { repo, branch, title, body: prBody })
  })

  app.post('/api/release/pr/:confirmationId/resolve', async (request, reply) => {
    const id = String((request.params as { confirmationId?: string }).confirmationId ?? '')
    const body = (request.body ?? {}) as { answer?: unknown }
    if (body.answer !== 'approve' && body.answer !== 'deny') {
      reply.code(400).send({ error: "answer must be 'approve' or 'deny'" })
      return
    }
    const doc = releaseDeps.store.confirmations.get(id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'confirmation not found' })
      return
    }
    if (doc.cls !== 'pr_create') {
      reply.code(400).send({ error: `confirmation is class '${String(doc.cls)}', not pr_create` })
      return
    }
    if (doc.status !== 'pending') {
      reply.code(409).send({ error: 'already_handled', status: doc.status })
      return
    }
    try {
      return await resolvePrCreate(releaseDeps, { confirmationId: id, answer: body.answer })
    } catch (error) {
      // Two answers racing: the CAS already picked the winner (§13) — this is a 409.
      if (error instanceof Error && error.message.startsWith('already_handled')) {
        reply.code(409).send({ error: 'already_handled', status: doc.status })
        return
      }
      throw error
    }
  })

  app.post('/api/release/merge', async (request, reply) => {
    const body = (request.body ?? {}) as {
      repo?: unknown
      prNumber?: unknown
      confirmationId?: unknown
    }
    const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
    const prNumber =
      typeof body.prNumber === 'number' && Number.isInteger(body.prNumber) && body.prNumber > 0
        ? body.prNumber
        : undefined
    if (repo === '' || prNumber === undefined) {
      reply.code(400).send({ error: 'repo and a positive integer prNumber are required' })
      return
    }
    // Optional link back to the pr_create card that opened this PR; it is only recorded.
    const originConfirmationId =
      typeof body.confirmationId === 'string' && body.confirmationId !== '' ? body.confirmationId : undefined
    if (
      originConfirmationId !== undefined &&
      releaseDeps.store.confirmations.get(originConfirmationId) === undefined
    ) {
      reply.code(404).send({ error: 'confirmation not found' })
      return
    }
    return openMergeCard(releaseDeps, {
      repo,
      prNumber,
      ...(originConfirmationId !== undefined && { originConfirmationId }),
    })
  })

  app.post('/api/release/merge/:confirmationId/resolve', async (request, reply) => {
    const id = String((request.params as { confirmationId?: string }).confirmationId ?? '')
    const body = (request.body ?? {}) as { answer?: unknown }
    if (body.answer !== 'approve' && body.answer !== 'deny') {
      reply.code(400).send({ error: "answer must be 'approve' or 'deny'" })
      return
    }
    const doc = releaseDeps.store.confirmations.get(id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'confirmation not found' })
      return
    }
    if (doc.cls !== 'pr_merge') {
      reply.code(400).send({ error: `confirmation is class '${String(doc.cls)}', not pr_merge` })
      return
    }
    if (doc.status !== 'pending') {
      reply.code(409).send({ error: 'already_handled', status: doc.status })
      return
    }
    const payload = doc.payload as { repo?: unknown; prNumber?: unknown } | undefined
    if (payload === undefined || typeof payload.repo !== 'string' || typeof payload.prNumber !== 'number') {
      reply.code(400).send({ error: 'confirmation carries no merge payload' })
      return
    }
    try {
      return await mergeBehindCard(releaseDeps, {
        confirmationId: id,
        repo: payload.repo,
        prNumber: payload.prNumber,
        answer: body.answer,
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('already_handled')) {
        reply.code(409).send({ error: 'already_handled', status: doc.status })
        return
      }
      throw error
    }
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
