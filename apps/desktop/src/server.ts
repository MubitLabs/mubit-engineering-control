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
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Socket } from 'node:net'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Effects, HealthBoard, HealthName, Json, Store, StoreDoc } from '@mec/contracts'
import { matchesSecret } from '@mec/contracts'
import { WORK_ITEM_TERMINAL, type WorkItemState } from '@mec/domain'
import type { LiveWork } from '@mec/meta'
import { routeMessage } from '@mec/meta'
import type { ConfirmationRecord } from '@mec/policy'
import { resolveConfirmation } from '@mec/policy'
import {
  claudeHome,
  codexHome,
  linkedDefault,
  opencodeHome,
  type ProbeRun,
  probeClaudeSlot,
  redact,
  SlotKeystore,
} from '@mec/slots'
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
  /**
   * §21.3 first-run wizard probes (each engine's `--version`, `claude auth status`)
   * run through this seam — the default is execFile with a 5s cap that NEVER throws
   * (a probe that cannot run reports a missing engine, not a server error); tests
   * inject a fake so no route ever runs a real engine binary.
   */
  probeCmd?: ProbeCmd
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
 * §5.4/§5.7: the courier's INTAKE gate — a structure check, not a format oracle.
 * Lesson of 3 Nov 2026 (user's real GLM + Gemini keys both rejected): vendor key
 * formats drift (z.ai split Standard/Coding-Plan key types in Oct 2026; Google is
 * mid-transition from AIza… to AQ.Ab… auth keys), and an exact-pattern gate built
 * from documentation BLOCKS the real key. So intake accepts a provider's key
 * FAMILY (right prefix/segment structure, sane lengths — catches clipboard
 * garbage, wrong-field pastes, truncations); the strict exact patterns live in
 * contracts' SECRET_PATTERNS for the REDACTION scanner, where strict is the safe
 * direction. Live probes (R2.2) are the real validity check.
 */
const INTAKE_PATTERNS: Record<string, RegExp> = {
  // sk-ant-… — documented, stable.
  'anthropic-api': /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  // z.ai/bigmodel: two dot-separated segments (id.secret), each ≥16 word chars —
  // accepts the classic 32-hex.16-alnum and any segment-length/charset drift.
  'glm-api': /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
  // Google: classic AIza… (39 chars) OR the new AQ.Ab… auth keys.
  'gemini-api': /^(AIza[A-Za-z0-9_-]{30,}|AQ\.[A-Za-z0-9_.-]{30,})$/,
}

/**
 * A safe shape diagnostic for the 400 — the received key's structure WITHOUT the
 * key: length, segment count, a masked prefix and last4 (last4 already travels in
 * fingerprints). Makes format drift self-diagnosing without ever echoing the key.
 */
function intakeDiagnostic(key: string): string {
  const segments = key.split('.').length
  const last4 = key.length >= 8 ? `…${key.slice(-4)}` : '…'
  return `${key.length} chars, ${segments} dot-segment(s), ends ${last4}`
}

const API_KEY_PROVIDERS = {
  'anthropic-api': {
    engine: 'claude',
    kind: 'claude-api',
    pattern: INTAKE_PATTERNS['anthropic-api'],
    home: claudeHome,
    shape: "'sk-ant-…' (anthropic)",
  },
  'glm-api': {
    engine: 'opencode',
    kind: 'opencode-glm',
    pattern: INTAKE_PATTERNS['glm-api'],
    home: opencodeHome,
    shape: "'<id>.<secret>' — two dot-separated segments (z.ai)",
  },
  'gemini-api': {
    engine: 'opencode',
    kind: 'opencode-gemini',
    pattern: INTAKE_PATTERNS['gemini-api'],
    home: opencodeHome,
    shape: "'AIza…' or 'AQ.Ab…' (Google)",
  },
} as const

/** §21.3 wizard: how long one local engine probe may run before it counts as missing. */
const PROBE_TIMEOUT_MS = 5_000

/** §21.3 wizard: the engines the setup flow knows, and the binary each one is probed with. */
const WIZARD_ENGINES = [
  { engine: 'claude', cmd: 'claude' },
  { engine: 'codex', cmd: 'codex' },
  { engine: 'opencode', cmd: 'opencode' },
] as const

/**
 * §14/§21.3 argv discipline for repository bootstrap/check commands: they run as argv
 * later, never through a shell, so anything that could become shell syntax is rejected
 * at registration — the exact characters listed in the plan's rule.
 */
const SHELL_METACHARS = /[;&|<>`$]/

/** The settings doc holding the meta agent's slot choice (§21.3 step 4). */
const META_SLOT_ID = 'settings/meta-slot'

/** GET /api/repositories lists exactly the docs POST /api/repositories registered. */
const REPOSITORY_PREFIX = 'repo_'

/** A slot label becomes a doc id and a stream name — one safe path segment, like `slotDir`. */
const SLOT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * §21.3 wizard probe seam: one local command, argv-only, never a shell. The default
 * resolves on every failure (ENOENT, non-zero exit, timeout kill) instead of throwing;
 * a spawn failure arrives as code -1, a command-not-found conventionally as 127.
 */
export type ProbeCmd = (
  cmd: string,
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>

export const defaultProbeCmd: ProbeCmd = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        ...(opts?.env !== undefined && { env: opts.env }),
      },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      },
    )
  })

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
  // §21.3 wizard probes: local, capped, never throwing; tests inject fixtures.
  const probeCmd = deps.probeCmd ?? defaultProbeCmd
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

  // §22 "rejects non-local origins and requires a custom request header (v1's CSRF
  // discipline)". Two legs, both scoped to BROWSER requests — a browser always sends
  // Origin (cross-origin) and Sec-Fetch-*; local non-browser clients (the CLI, tests,
  // the engine-side MCP client) send neither and are authenticated by their own seams.
  //  1. Any request carrying an Origin must name a loopback host (the workbench itself,
  //     or the dev server proxying to it). A web page at https://evil.com is 403 before
  //     any route runs — for reads AND for "simple-request" mutations that would
  //     otherwise execute despite CORS response blocking. `null` origins (sandboxed
  //     frames, data: URLs) are rejected with it.
  //  2. A browser-shaped MUTATION additionally needs the custom header the workbench
  //     sends on every call (apps/web request()): a cross-origin page cannot add it
  //     without a preflight, and this server answers no preflight. This also stops a
  //     *local* page (another project's dev server) from posting as the user.
  // EventSource streams are GETs: leg 1 covers them, leg 2 never applies.
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (origin !== undefined) {
      const host =
        typeof origin === 'string' && origin !== 'null'
          ? (() => {
              try {
                return new URL(origin).hostname
              } catch {
                return ''
              }
            })()
          : ''
      if (!LOOPBACK_HOSTS.has(host)) {
        return reply.code(403).send({ error: 'origin not local' })
      }
    }
    const browserShaped =
      origin !== undefined ||
      request.headers['sec-fetch-site'] !== undefined ||
      request.headers.referer !== undefined
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    if (browserShaped && mutating && request.headers['x-mec-client'] !== '1') {
      return reply.code(403).send({ error: 'missing client header' })
    }
    return undefined
  })

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
    const body = (request.body ?? {}) as { engine?: unknown; slotHome?: unknown; label?: unknown }
    const { engine } = body
    if (engine !== 'claude' && engine !== 'codex' && engine !== 'opencode') {
      reply.code(400).send({ error: "engine must be 'claude', 'codex' or 'opencode'" })
      return
    }
    let slotHome = typeof body.slotHome === 'string' ? body.slotHome.trim() : ''
    if (slotHome === '' && typeof body.label === 'string' && body.label.trim() !== '') {
      // §21.3 wizard's dedicated-slot path: the client names the slot, the server resolves
      // the home under the keystore root — the browser never composes slot paths.
      const label = body.label.trim()
      try {
        slotHome =
          engine === 'claude'
            ? claudeHome(keystoreRoot, label).homeDir
            : engine === 'codex'
              ? codexHome(keystoreRoot, label).homeDir
              : opencodeHome(keystoreRoot, label).homeDir
      } catch (error) {
        reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid slot label' })
        return
      }
    }
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
    const providerName = typeof body.provider === 'string' ? body.provider : ''
    const provider = (
      API_KEY_PROVIDERS as Record<string, (typeof API_KEY_PROVIDERS)['anthropic-api'] | undefined>
    )[providerName]
    if (provider === undefined) {
      reply.code(400).send({
        error: "provider must be one of 'anthropic-api' | 'glm-api' | 'gemini-api'",
      })
      return
    }
    // A pasted key may carry clipboard whitespace; the structure gate runs on the trimmed form.
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (key === '' || provider.pattern === undefined || !provider.pattern.test(key)) {
      reply.code(400).send({
        error: `key does not match the ${providerName} shape (${provider.shape}); got ${intakeDiagnostic(key)}`,
      })
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
      home = provider.home(keystoreRoot, label)
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid slot label' })
      return
    }

    const keystore = new SlotKeystore(home.homeDir)
    let fingerprint: { provider: string; last4: string; hash: string }
    try {
      fingerprint = keystore.store(providerName, key)
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
        engine: provider.engine,
        kind: provider.kind,
        provider: providerName,
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
        { slotId: id, label, kind: provider.kind, provider: providerName, fingerprint, at },
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

  // ─── §21.3 first-run wizard ────────────────────────────────────────────────────
  // The four setup steps against real local state: detect engines → existing logins
  // in each engine's default home → link existing / dedicated slot / paste a key →
  // register a repository → choose the meta agent's slot. Every probe is local and
  // read-only; the target is five minutes with one engine, ten with four configs.

  app.get('/api/wizard/engines', async () =>
    Promise.all(
      WIZARD_ENGINES.map(async ({ engine, cmd }) => {
        const result = await probeCmd(cmd, ['--version'])
        // Exit 0 with a speakable first line = installed; anything else (ENOENT,
        // non-zero exit, empty stdout, a timeout kill) is honestly "not installed".
        const version = result.code === 0 ? (result.stdout.trim().split('\n')[0]?.trim() ?? '') : ''
        return { engine, installed: version !== '', ...(version !== '' && { version }) }
      }),
    ),
  )

  // §21.3 step 2 + §5.3 slot-0: what lives in each engine's DEFAULT home. Claude only
  // in v0, probed with `claude auth status` and CLAUDE_CONFIG_DIR deleted from the
  // environment — the default home is "the variable unset", never "the variable pointed
  // at ~/.claude" (issue #92252). codex/opencode answer null until their adapters land.
  app.get('/api/wizard/existing-logins', async () => {
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) env[name] = value
    }
    delete env.CLAUDE_CONFIG_DIR
    // A probe that cannot run at all (binary missing) is null — unknown, not "signed
    // out"; probeClaudeSlot's own §5.8 parse decides everything answerable.
    const run: ProbeRun = async (cmd, args, runEnv) => {
      const result = await probeCmd(cmd, args, { env: runEnv })
      if (result.code === -1 || result.code === 127) throw new Error('engine missing')
      return result
    }
    const probed = await probeClaudeSlot(run, env)
    const claude =
      probed.state !== 'healthy' && probed.reason === 'engine_missing'
        ? null
        : {
            engine: 'claude',
            loggedIn: probed.state === 'healthy',
            ...(probed.identity?.email !== undefined && { email: probed.identity.email }),
            ...(probed.identity?.plan !== undefined && { plan: probed.identity.plan }),
          }
    return { claude, codex: null, opencode: null }
  })

  // §5.3 slot 0 ("link existing"): a slot doc referencing the engine's DEFAULT home.
  // For Claude that means the variable stays UNSET (issue #92252) — the doc records
  // `linkedDefault: true` with an empty env so the launcher never points
  // CLAUDE_CONFIG_DIR anywhere. The login itself is the vendor's, already in place,
  // so the slot is born past `home_ready`'s directory step and waiting on its probe.
  app.post('/api/slots/link', async (request, reply) => {
    const body = (request.body ?? {}) as { engine?: unknown; label?: unknown }
    const { engine } = body
    if (engine !== 'claude' && engine !== 'codex' && engine !== 'opencode') {
      reply.code(400).send({ error: "engine must be 'claude', 'codex' or 'opencode'" })
      return
    }
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (label === '') {
      reply.code(400).send({ error: 'label is required' })
      return
    }
    if (label === '..' || !SLOT_LABEL.test(label)) {
      reply.code(400).send({ error: 'invalid slot label: expected a single path segment' })
      return
    }
    const linked = linkedDefault(engine)
    if (linked === null) {
      reply.code(400).send({ error: "linking an existing login is 'claude'-only in v0" })
      return
    }
    const id = `slot_${label}`
    if (store.slots.get(id) !== undefined) {
      reply.code(409).send({ error: 'a slot with that label already exists — retire it first' })
      return
    }
    const at = now().toISOString()
    store.atomic(() => {
      store.slots.save({
        id,
        label,
        engine: linked.engine,
        kind: 'claude-sub',
        provider: 'anthropic',
        home: linked.homeDir,
        linkedDefault: true,
        env: linked.env,
        state: 'home_ready',
        createdAt: at,
        updatedAt: at,
      })
      appendEvent(
        store,
        `slot:${label}`,
        'slot_created',
        { slotId: id, label, kind: 'claude-sub', linkedDefault: true, home: linked.homeDir, at },
        at,
      )
    })
    return {
      id,
      label,
      engine: linked.engine,
      kind: 'claude-sub',
      state: 'home_ready',
      home: linked.homeDir,
    }
  })

  // §14/§21.3 repository registration: an existing local path or a credential-free
  // https URL, bootstrap/check commands as plain argv strings, and the trust flag §22
  // requires before repository-resident configuration is honoured at all.
  app.post('/api/repositories', async (request, reply) => {
    const body = (request.body ?? {}) as {
      urlOrPath?: unknown
      bootstrapCmds?: unknown
      checkCmds?: unknown
      trusted?: unknown
    }
    const urlOrPath = typeof body.urlOrPath === 'string' ? body.urlOrPath.trim() : ''
    if (urlOrPath === '') {
      reply.code(400).send({ error: 'urlOrPath is required' })
      return
    }
    if (typeof body.trusted !== 'boolean') {
      reply.code(400).send({ error: 'trusted must be a boolean' })
      return
    }
    const trusted: boolean = body.trusted
    let bootstrap: string[]
    let checks: Array<{ name: string; cmd: string }>
    try {
      bootstrap = argvArrayOf(body.bootstrapCmds, 'bootstrapCmds')
      checks = checkArrayOf(body.checkCmds)
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid repository payload' })
      return
    }
    if (isRemoteUrl(urlOrPath)) {
      if (!urlOrPath.toLowerCase().startsWith('https://')) {
        reply.code(400).send({ error: 'only https:// URLs are accepted (or a local path)' })
        return
      }
      let parsed: URL
      try {
        parsed = new URL(urlOrPath)
      } catch {
        reply.code(400).send({ error: 'urlOrPath is not a valid https URL' })
        return
      }
      if (parsed.username !== '' || parsed.password !== '') {
        reply.code(400).send({ error: 'https URL must not carry credentials (user:pass@host)' })
        return
      }
    } else if (!existsSync(urlOrPath)) {
      reply.code(400).send({ error: `path does not exist: ${urlOrPath}` })
      return
    }

    const id = freshId('repo_')
    const at = now().toISOString()
    store.atomic(() => {
      store.engines.save({
        id,
        url: urlOrPath,
        bootstrap,
        checks,
        trust: trusted,
        createdAt: at,
        updatedAt: at,
      })
      // §21.2 has_repository looks for the settings/repositories marker by id; every
      // registration appends to it, so the flag flips on the first repository.
      const marker = store.engines.get(SETTINGS_REPOSITORIES_ID)
      const previous =
        marker !== undefined && Array.isArray(marker.repositories)
          ? marker.repositories.filter((entry): entry is string => typeof entry === 'string')
          : []
      store.engines.save({
        id: SETTINGS_REPOSITORIES_ID,
        repositories: [...previous, id],
        updatedAt: at,
      })
      appendEvent(
        store,
        'repositories',
        'repository_registered',
        { repositoryId: id, url: urlOrPath, at },
        at,
      )
    })
    return { id, url: urlOrPath, bootstrap, checks, trust: trusted }
  })

  // The registered repositories (§14) — exactly the docs POST wrote, in registration order.
  app.get('/api/repositories', async () =>
    store.engines
      .list()
      .filter((doc) => typeof doc.id === 'string' && doc.id.startsWith(REPOSITORY_PREFIX))
      .map((doc) => ({
        id: String(doc.id),
        url: String(doc.url ?? ''),
        bootstrap: Array.isArray(doc.bootstrap) ? doc.bootstrap : [],
        checks: Array.isArray(doc.checks) ? doc.checks : [],
        trust: doc.trust === true,
      })),
  )

  // §21.3 step 4: the slot that runs the meta agent (§6). One settings doc, last write
  // wins, and it must point at a real slot doc so the choice can never dangle.
  app.post('/api/wizard/meta-slot', async (request, reply) => {
    const body = (request.body ?? {}) as { slotId?: unknown }
    const slotId = typeof body.slotId === 'string' ? body.slotId.trim() : ''
    if (slotId === '') {
      reply.code(400).send({ error: 'slotId is required' })
      return
    }
    if (store.slots.get(slotId) === undefined) {
      reply.code(400).send({ error: `no slot '${slotId}' — link or add one first` })
      return
    }
    const at = now().toISOString()
    store.atomic(() => {
      store.engines.save({ id: META_SLOT_ID, slotId, updatedAt: at })
      appendEvent(store, 'wizard', 'meta_slot_chosen', { slotId, at }, at)
    })
    return { id: META_SLOT_ID, slotId }
  })

  app.get('/api/wizard/meta-slot', async () => {
    const doc = store.engines.get(META_SLOT_ID)
    return { slotId: doc !== undefined && typeof doc.slotId === 'string' ? doc.slotId : null }
  })

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

/** A repository-validation failure the /api/repositories route answers as 400. */
class InvalidRepository extends Error {}

/**
 * §14/§21.3: bootstrap commands arrive as one argv string each — plain text, no shell
 * metacharacters, because they are executed as argv later and never through a shell.
 */
function argvArrayOf(input: unknown, field: string): string[] {
  if (!Array.isArray(input)) {
    throw new InvalidRepository(`${field} must be an array of command strings`)
  }
  return input.map((cmd, index) => {
    if (typeof cmd !== 'string' || cmd.trim() === '') {
      throw new InvalidRepository(`${field}[${index}] must be a non-empty string`)
    }
    if (SHELL_METACHARS.test(cmd)) {
      throw new InvalidRepository(`${field}[${index}] must be a plain argv string (no ; & | < > \u0060 $)`)
    }
    return cmd.trim()
  })
}

/** §14 check profiles: named commands, each held to the same argv discipline. */
function checkArrayOf(input: unknown): Array<{ name: string; cmd: string }> {
  if (!Array.isArray(input)) {
    throw new InvalidRepository('checkCmds must be an array of {name, cmd}')
  }
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new InvalidRepository(`checkCmds[${index}] must be an object with name and cmd`)
    }
    const { name, cmd } = entry as { name?: unknown; cmd?: unknown }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new InvalidRepository(`checkCmds[${index}].name must be a non-empty string`)
    }
    if (typeof cmd !== 'string' || cmd.trim() === '') {
      throw new InvalidRepository(`checkCmds[${index}].cmd must be a non-empty string`)
    }
    if (SHELL_METACHARS.test(cmd)) {
      throw new InvalidRepository(
        `checkCmds[${index}].cmd must be a plain argv string (no ; & | < > \u0060 $)`,
      )
    }
    return { name: name.trim(), cmd: cmd.trim() }
  })
}

/** Distinguishes `scheme://…` remotes from local paths — §14 accepts paths and https only. */
function isRemoteUrl(urlOrPath: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrPath)
}
