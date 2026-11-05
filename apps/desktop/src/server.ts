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
import type { Effects, HealthBoard, HealthName, Json, ProviderId, Store, StoreDoc } from '@mec/contracts'
import { matchesSecret } from '@mec/contracts'
import { WORK_ITEM_TERMINAL, type WorkItemState } from '@mec/domain'
import type { LiveWork } from '@mec/meta'
// T7 (review 2026-11-04 §7): the setup agent for Chat's Setup mode — the Settings API's
// read side plus a safe slot subset, every write a user-applied draft.
import {
  assertRepoAdmission,
  RepoAdmissionError,
  repoFields,
  routeMessage,
  SetupAgent,
  type SetupSettingsApi,
} from '@mec/meta'
import type { ConfirmationRecord } from '@mec/policy'
import { ALWAYS_CONFIRM, loadPolicy, resolveConfirmation } from '@mec/policy'
import { defaultParts, PromptStore, StaleBaseError, UnknownPartError } from '@mec/prompts'
import {
  API_KEY_PROBE_TARGETS,
  claudeHome,
  codexHome,
  linkedDefault,
  opencodeHome,
  type ProbeRun,
  probeApiKeySlot,
  probeClaudeSlot,
  redact,
  SlotKeystore,
} from '@mec/slots'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { buildDoctorReport } from './doctor'
import type { HealthSnapshot, PartEntry } from './health'
import { type CardEvent, LoginCardManager } from './login-cards'
import {
  cardDetail,
  createPrBehindCard,
  defaultGhRun,
  type GhRun,
  type GitExec,
  isReleaseCard,
  mergeBehindCard,
  openMergeCard,
  openPushCard,
  type ReleaseDeps,
  refusalOf,
  resolvePrCreate,
  resolvePush,
  resolveReleaseCard,
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
  /** The built web app to serve; defaults to the bundled or repo `dist`. A test seam. */
  webDist?: string
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
  /** The push card's git; tests may inject it, production uses the argv-only default. */
  gitExec?: GitExec
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
    onUserMessage(input: {
      messageId: string
      text: string
      referencesWorkItem?: string
      repoId?: string
    }): Promise<{
      acknowledged: string
      workItemId?: string
      tasksCreated: number
      launchesEnqueued: string[]
      escalated: boolean
    }>
    /** T5 wakes: an answered question re-invokes the planner with the answer in context. */
    onQuestionAnswered?(
      questionId: string,
      answer: string,
    ): Promise<{ status: 'answered' | 'not_open' | 'missing'; outcome?: unknown }>
  }
  /** T7: the setup agent for Chat's Setup mode; a store-backed default is built when absent. */
  setupAgent?: SetupAgentSurface
  /** T7: the Settings API the default setup agent drafts against (the integrator wires T1/T4 here). */
  setupSettingsApi?: SetupSettingsApi
}

/** The chat route's setup-mode surface — `SetupAgent` from @mec/meta satisfies it structurally. */
export type SetupAgentSurface = {
  handleMessage(input: { messageId: string; text: string; conversationId?: string }): Promise<{
    reply: string
    calls: { tool: string; args: unknown; result: unknown }[]
    drafts: {
      id: string
      target: string
      reason: string
      cls?: 'policy_change'
      status: string
    }[]
    applied: string[]
    openLoginCard?: { engine: string; label: string }
    openKeyForm?: { provider: string; label: string }
  }>
}

/**
 * The marker doc whose presence means a repository is registered. Repository registration
 * (B2) writes it; until then its absence honestly reports `has_repository: false`. Looked
 * up by its dedicated id — never by "the engines repo is non-empty", which would confuse an
 * installed engine with a registered repository.
 */
const SETTINGS_REPOSITORIES_ID = 'settings/repositories'

/** The built workbench (`apps/web`); served at `/*` with an SPA fallback when present.
 *  Two layouts: the repo (`apps/web/dist` beside the source) and the artifact, where the
 *  UI ships inside the bundle's own `dist/web` (review 2026-11-04 §2.1) — the bundle-aware
 *  path wins when it exists. */
const BUNDLE_WEB_DIST = fileURLToPath(new URL('../dist/web', import.meta.url))
const REPO_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url))
const WEB_DIST: string = existsSync(BUNDLE_WEB_DIST) ? BUNDLE_WEB_DIST : REPO_WEB_DIST

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

const API_KEY_PROVIDERS: Record<
  string,
  {
    readonly engine: 'claude' | 'codex' | 'opencode'
    readonly kind: string
    readonly pattern: RegExp | undefined
    readonly home: (root: string, slot: string) => ReturnType<typeof claudeHome>
    readonly shape: string
    /** The canonical keystore/ProviderId (§5.4) — the file name and fingerprint provider. */
    readonly keystoreId: ProviderId
  }
> = {
  'anthropic-api': {
    engine: 'claude',
    kind: 'claude-api',
    pattern: INTAKE_PATTERNS['anthropic-api'],
    home: claudeHome,
    shape: "'sk-ant-…' (anthropic)",
    keystoreId: 'anthropic-api',
  },
  'glm-api': {
    engine: 'opencode',
    kind: 'opencode-glm',
    pattern: INTAKE_PATTERNS['glm-api'],
    home: opencodeHome,
    shape: "'<id>.<secret>' — two dot-separated segments (z.ai)",
    keystoreId: 'zai-coding-plan',
  },
  'gemini-api': {
    engine: 'opencode',
    kind: 'opencode-gemini',
    pattern: INTAKE_PATTERNS['gemini-api'],
    home: opencodeHome,
    shape: "'AIza…' or 'AQ.Ab…' (Google)",
    keystoreId: 'google-gemini',
  },
}

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

/**
 * The optional `repoId` read filter: every row when absent, and a 400 for an id that is not
 * registered, the same answer the chat route gives.
 */
function repoFilterOf(store: Store, request: FastifyRequest): { repoId?: string } {
  const repoId = (request.query as { repoId?: unknown }).repoId
  if (typeof repoId !== 'string') return {}
  assertRepoAdmission(store, { repoId })
  return { repoId }
}

/** Live work for routing (§12.1): this repository's work items, neither done nor stopped. */
function liveWorkOf(store: Store, repoId: string | undefined): LiveWork[] {
  return store.workItems
    .list()
    .filter((doc) => doc.repoId === repoId)
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
    ...(deps.gitExec !== undefined && { git: deps.gitExec }),
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
  // §12.1, decision #10: a request that names another repository is the client's error.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RepoAdmissionError) {
      return reply.code(400).send({ error: error.code, detail: error.message })
    }
    return reply.send(error)
  })

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
    const body = (request.body ?? {}) as {
      text?: unknown
      referencesWorkItem?: unknown
      setup?: unknown
      repoId?: unknown
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') {
      reply.code(400).send({ error: 'text is required' })
      return
    }
    if (body.repoId !== undefined && (typeof body.repoId !== 'string' || body.repoId === '')) {
      reply.code(400).send({ error: 'repoId must be a non-empty string' })
      return
    }
    // §12.1, decision #10: absent is Unassigned; unknown or crossing is refused before any write.
    const repoId = typeof body.repoId === 'string' ? body.repoId : undefined
    const repo: { repoId?: string } = repoId !== undefined ? { repoId } : {}
    const referencesWorkItem =
      typeof body.referencesWorkItem === 'string' && body.referencesWorkItem !== ''
        ? body.referencesWorkItem
        : undefined
    assertRepoAdmission(store, { repoId, referencesWorkItem })
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
          ...repo,
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
    // T7 setup mode (review 2026-11-04 §7): body.setup === true routes the message to the
    // setup agent — a separate role with its own tool set; it never enters the work planner.
    const setupAgent = deps.setupAgent ?? defaultSetupAgent
    if (body.setup === true) {
      const setupMessageId = freshId('msg_')
      const setupAt = now().toISOString()
      const result = await setupAgent.handleMessage({
        messageId: setupMessageId,
        text,
        conversationId: 'setup',
      })
      store.atomic(() => {
        store.messages.save({
          id: setupMessageId,
          text,
          createdAt: setupAt,
          updatedAt: setupAt,
          routing: 'setup',
          setupReply: result.reply,
        })
      })
      return {
        messageId: setupMessageId,
        mode: 'setup',
        reply: result.reply,
        drafts: result.drafts.map((draft) => ({
          id: draft.id,
          target: draft.target,
          reason: draft.reason,
          ...(draft.cls !== undefined && { cls: draft.cls }),
        })),
        applied: result.applied,
        ...(result.openLoginCard !== undefined && { openLoginCard: result.openLoginCard }),
        ...(result.openKeyForm !== undefined && { openKeyForm: result.openKeyForm }),
      }
    }

    // Clients send `x-idempotency-key` (the web api module); the bare form is accepted too.
    const header = request.headers['x-idempotency-key'] ?? request.headers['idempotency-key']
    const headerText = Array.isArray(header) ? header[0] : header
    const idempotencyKey = typeof headerText === 'string' && headerText !== '' ? headerText : undefined

    // Idempotent by the client's key: the first answer is replayed verbatim, no second write.
    if (idempotencyKey !== undefined) {
      const replay = store.messages.list({ idempotencyKey }).at(0)
      if (replay !== undefined) {
        if (replay.repoId !== repoId) {
          throw new RepoAdmissionError('repo_mismatch', 'that idempotency key belongs to another repository')
        }
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
      const outcome = await deps.metaAgent.onUserMessage({ messageId, text, referencesWorkItem, ...repo })
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
        ...repo,
        ...(referencesWorkItem !== undefined && { referencesWorkItem }),
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      }

      const decision = routeMessage({ referencesWorkItem, liveWork: liveWorkOf(store, repoId) })

      let workItemId: string | undefined
      if (decision.action === 'new_work') {
        workItemId = freshId('wi_')
        store.workItems.save({
          id: workItemId,
          state: 'admitted',
          mandate: { originMessageId: messageId },
          originMessageId: messageId,
          ...repoFields(store, repoId, deps.policyText),
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

  app.get('/api/chat/messages', async (request) => {
    const messages = store.messages.list(repoFilterOf(store, request))
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
    // §13: approving a release card IS the action, so it goes through the door that acts.
    // An always-confirm card nothing here can run refuses an approve instead of settling
    // it as though it had run; a deny needs no executor. 409 stays "someone answered first".
    const cls = String(doc.cls ?? '')
    if (isReleaseCard(doc)) {
      try {
        return await resolveReleaseCard(releaseDeps, id, body.answer)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('already_handled')) {
          reply.code(409).send({ error: 'already_handled', status: doc.status })
          return
        }
        throw error
      }
    }
    if (body.answer === 'approve' && (ALWAYS_CONFIRM as readonly string[]).includes(cls)) {
      reply.code(422).send({ error: 'no_executor', detail: `nothing here can run a '${cls}' card` })
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

  // The evidence a release card states (§13): what the owner is approving, never a bare hash.
  app.get('/api/inbox/:id/detail', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = releaseDeps.store.confirmations.get(id)
    const detail = doc === undefined ? undefined : cardDetail(doc)
    if (detail === undefined) {
      reply.code(404).send({ error: 'no detail for this confirmation' })
      return
    }
    return detail
  })

  app.get('/api/work', async (request) =>
    store.workItems.list(repoFilterOf(store, request)).map((doc) => {
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
        ...(typeof doc.repoId === 'string' && { repoId: doc.repoId }),
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
    const provider = API_KEY_PROVIDERS[providerName]
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
      fingerprint = keystore.store(provider.keystoreId, key)
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
        provider: provider.keystoreId,
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
        { slotId: id, label, kind: provider.kind, provider: provider.keystoreId, fingerprint, at },
        at,
      )
    })
    // The response carries identity + fingerprint only — never the key, in any form.
    return { id, fingerprint: { provider: fingerprint.provider, last4: fingerprint.last4 } }
  })

  // §5.8 zero-token validity probe, dispatched per provider (R2.2): GET the
  // provider's own models endpoint with the key read STRAIGHT from the keystore
  // file (§5.4 read path #2) — anthropic (x-api-key), z.ai coding plan (Bearer,
  // the endpoint that bills Coding Plan quota), Google Gemini (x-goog-api-key).
  // 200 → healthy; 401 → degraded/key_rejected; a network failure is
  // provider_unreachable and changes nothing — an unreachable provider says
  // nothing about the key. 15s cap inside probeApiKeySlot.
  app.post('/api/slots/:id/validate', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = slotDocOf(store, id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'slot not found' })
      return
    }
    const probeTarget = API_KEY_PROBE_TARGETS[doc.provider as keyof typeof API_KEY_PROBE_TARGETS]
    if (probeTarget === undefined) {
      reply.code(400).send({ error: `slots with provider '${doc.provider}' do not validate in v0` })
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

    const outcome = await probeApiKeySlot(
      validateFetch,
      doc.provider as keyof typeof API_KEY_PROBE_TARGETS,
      key,
      VALIDATE_TIMEOUT_MS,
    )

    const at = now().toISOString()
    if (outcome === 'healthy') {
      store.atomic(() => {
        const next: StoreDoc = { ...doc, state: 'healthy', last_probe_at: at, updatedAt: at }
        delete next.state_reason
        store.slots.save(next)
        appendEvent(
          store,
          `slot:${doc.label}`,
          'slot_healthy',
          { slotId: id, probe: probeTarget.label, at },
          at,
        )
      })
      return { ok: true }
    }
    if (outcome === 'key_rejected') {
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
  // before anything runs, settle the card, and only then call the user's gh. A card that
  // cannot state what it would approve never opens: the refusal names why.
  const refuse = (error: unknown, reply: FastifyReply): void => {
    const refusal = refusalOf(error)
    if (refusal === undefined) throw error
    reply.code(refusal.status).send({ error: refusal.error, detail: refusal.detail })
  }

  // §13 `git push` always confirms. The repository is named by its registration id and
  // nothing else: a caller can choose which registered repository, never a path on disk.
  app.post('/api/release/push', async (request, reply) => {
    const body = (request.body ?? {}) as { repoId?: unknown; branch?: unknown; headSha?: unknown }
    const repoId = typeof body.repoId === 'string' ? body.repoId.trim() : ''
    const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
    if (repoId === '' || branch === '') {
      reply.code(400).send({ error: 'repoId and branch are required' })
      return
    }
    const headSha = typeof body.headSha === 'string' ? body.headSha.trim() : undefined
    try {
      return await openPushCard(releaseDeps, { repoId, branch, ...(headSha !== undefined && { headSha }) })
    } catch (error) {
      return refuse(error, reply)
    }
  })

  app.post('/api/release/push/:confirmationId/resolve', async (request, reply) => {
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
    if (doc.cls !== 'push' || !isReleaseCard(doc)) {
      reply.code(400).send({ error: `confirmation is class '${String(doc.cls)}', not a push card` })
      return
    }
    if (doc.status !== 'pending') {
      reply.code(409).send({ error: 'already_handled', status: doc.status })
      return
    }
    try {
      return await resolvePush(releaseDeps, { confirmationId: id, answer: body.answer })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('already_handled')) {
        reply.code(409).send({ error: 'already_handled', status: doc.status })
        return
      }
      throw error
    }
  })

  app.post('/api/release/pr', async (request, reply) => {
    const body = (request.body ?? {}) as {
      repo?: unknown
      branch?: unknown
      title?: unknown
      body?: unknown
      headSha?: unknown
    }
    const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
    const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const prBody = typeof body.body === 'string' ? body.body : ''
    if (repo === '' || branch === '' || title === '') {
      reply.code(400).send({ error: 'repo, branch and title are required' })
      return
    }
    const headSha = typeof body.headSha === 'string' ? body.headSha.trim() : undefined
    try {
      return await createPrBehindCard(releaseDeps, {
        repo,
        branch,
        title,
        body: prBody,
        ...(headSha !== undefined && { headSha }),
      })
    } catch (error) {
      return refuse(error, reply)
    }
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
    try {
      return await openMergeCard(releaseDeps, {
        repo,
        prNumber,
        ...(originConfirmationId !== undefined && { originConfirmationId }),
      })
    } catch (error) {
      return refuse(error, reply)
    }
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
    const streamParam = typeof query.stream === 'string' ? query.stream : ''
    if (streamParam === '') {
      reply.code(400).send({ error: 'stream is required' })
      return
    }
    // Merged form (one connection for many streams — browsers cap 6 per origin, and the
    // workbench needs more streams than that): `stream=a,b,c&after=1,0,5`, the afters
    // comma-aligned with the streams. The single-stream form is exactly the length-1 case.
    const streams = streamParam
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '')
    const afters =
      typeof query.after === 'string' ? query.after.split(',').map((n) => Number.parseInt(n, 10)) : []
    const cursors = new Map<string, number>()
    streams.forEach((name, i) => {
      const after = afters[i] ?? Number.NaN
      cursors.set(name, Number.isFinite(after) && after >= 0 ? after : 0)
    })
    const stream = streams[0] ?? ''
    let cursor = cursors.get(stream) ?? 0

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const flush = (): void => {
      for (const name of streams) {
        let at = cursors.get(name) ?? 0
        for (const event of store.events.read(name, at)) {
          raw.write(`id: ${name}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
          at = event.seq
        }
        cursors.set(name, at)
      }
      cursor = cursors.get(stream) ?? cursor
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

  // ─── T5/T7 planner routes (review 2026-11-04 §5.2/§7) ────────────────────────────────────
  // Additive block: the question surface ask_user creates (open + answered, with the
  // decision-card evidence mapping served honestly from what exists), the answer route
  // that records the user's word and WAKES the planner, and Chat's Setup mode backing
  // (the store-backed default setup agent). Other lanes may append after this block.

  /**
   * The decision-card evidence mapping (what/why/facts/consequences) from the question
   * record alone: every field is served from what exists, and what does not exist says
   * so — no invention (the UI team marked these TODO).
   */
  const questionEvidence = (doc: StoreDoc): Record<string, unknown> => ({
    what: typeof doc.question === 'string' ? doc.question : 'unknown',
    why:
      typeof doc.forMessageId === 'string'
        ? `asked for message ${doc.forMessageId}`
        : 'asked by the planner this turn',
    facts: Array.isArray(doc.options) ? doc.options : [],
    consequences: 'unknown — not recorded in this build',
  })

  app.get('/api/questions', async () =>
    store.engines
      .list()
      .filter((doc) => String(doc.id).startsWith('question/'))
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
      .map((doc) => ({
        id: String(doc.questionId ?? String(doc.id).slice('question/'.length)),
        question: String(doc.question ?? ''),
        options: Array.isArray(doc.options) ? doc.options : [],
        status: String(doc.status ?? 'open'),
        ...(typeof doc.workItemId === 'string' && { workItemId: doc.workItemId }),
        ...(typeof doc.forMessageId === 'string' && { forMessageId: doc.forMessageId }),
        ...(typeof doc.answer === 'string' && { answer: doc.answer }),
        ...(typeof doc.askedAt === 'string' && { askedAt: doc.askedAt }),
        ...(typeof doc.answeredAt === 'string' && { answeredAt: doc.answeredAt }),
        evidence: questionEvidence(doc),
      })),
  )

  app.post('/api/questions/:id/answer', async (request, reply) => {
    const raw = String((request.params as { id?: string }).id ?? '')
    const body = (request.body ?? {}) as { answer?: unknown }
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    if (answer === '') {
      reply.code(400).send({ error: 'answer is required' })
      return
    }
    const docId = raw.startsWith('question/') ? raw : `question/${raw}`
    const doc = store.engines.get(docId)
    if (doc === undefined) {
      reply.code(404).send({ error: 'question not found' })
      return
    }
    if (String(doc.status ?? 'open') !== 'open') {
      // First answer wins (§13's compare-and-set discipline for questions too).
      reply.code(409).send({ error: 'already_answered', status: String(doc.status) })
      return
    }
    const at = now().toISOString()
    store.atomic(() => {
      store.engines.save({ ...doc, status: 'answered', answer, answeredAt: at, updatedAt: at })
      appendEvent(store, docId, 'question_answered', { questionId: raw, answer, at }, at)
    })
    // T5 wake: the planner re-runs with the answer in context (§1's gap). A meta agent
    // without the wake surface is told the answer only through the store — honestly.
    let woke: unknown
    if (deps.metaAgent?.onQuestionAnswered !== undefined) {
      woke = await deps.metaAgent.onQuestionAnswered(raw, answer)
    }
    return { id: raw, status: 'answered', answer, ...(woke !== undefined && { wake: woke }) }
  })

  // The store-backed Settings API the default setup agent drafts against. The T1/T4
  // surfaces (prompt store, models table) are being rebuilt on this branch; their reads
  // and applies answer honestly until deps.setupSettingsApi wires them.
  const defaultSetupSettingsApi: SetupSettingsApi = {
    read: async (resource) => {
      switch (resource) {
        case 'settings':
          return store.engines.list().filter((doc) => String(doc.id).startsWith('settings/'))
        case 'slots':
          return store.slots.list()
        case 'repositories':
          return store.engines.get(SETTINGS_REPOSITORIES_ID) ?? null
        case 'status':
          return buildHealthSnapshot(store, deps.health)
        case 'policy':
          return {
            text: deps.policyText,
            preAuthorisedClasses: safePolicyPreAuthorised(deps.policyText),
          }
        case 'doctor':
          return await buildDoctorReport({ env: process.env })
        case 'prompts':
        case 'models':
          return {
            error: 'not wired in this build — the prompt-parts and models-table API returns with T1/T4',
          }
        default:
          return { error: `unknown resource '${String(resource)}'` }
      }
    },
    applyDraft: async (draft) => {
      if (draft.target === 'repository') {
        const patch = draft.patch as { label?: unknown; url_or_path?: unknown; trust?: unknown }
        return await registerRepositoryDoc(
          typeof patch.label === 'string' ? patch.label : '',
          typeof patch.url_or_path === 'string' ? patch.url_or_path : '',
          patch,
        )
      }
      return {
        ok: false,
        error: `the settings API for '${draft.target}' is not wired in this build — the draft stands, applying returns with T1/T4`,
      }
    },
    openLoginCard: () => {},
    openKeyForm: () => {},
    registerRepository: async (input) =>
      registerRepositoryDoc(input.label, input.urlOrPath, {
        ...(input.bootstrap !== undefined && { bootstrap: input.bootstrap }),
        ...(input.checks !== undefined && { checks: input.checks }),
        ...(input.trust !== undefined && { trust: input.trust }),
      }),
    setMetaSlot: (slotId) => {
      const at = now().toISOString()
      store.atomic(() => {
        store.engines.save({ id: META_SLOT_ID, slotId, updatedAt: at, createdAt: at })
        appendEvent(store, META_SLOT_ID, 'meta_slot_set', { slotId, at }, at)
      })
    },
    runDoctor: async () => buildDoctorReport({ env: process.env }),
  }

  /**
   * Repository registration through the setup seam: the same rules the POST route
   * enforces — https-without-credentials or an existing local path, argv-only bootstrap
   * and check strings — applied only when a DRAFT the user approved says so (§7).
   */
  const registerRepositoryDoc = async (
    label: string,
    urlOrPath: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    if (label === '' || urlOrPath === '')
      return { ok: false, error: 'repository needs a label and a url_or_path' }
    const bootstrap = Array.isArray(patch.bootstrap)
      ? patch.bootstrap.filter((entry): entry is string => typeof entry === 'string')
      : []
    const checks = Array.isArray(patch.checks)
      ? patch.checks.filter((entry): entry is string => typeof entry === 'string')
      : []
    for (const cmd of [...bootstrap, ...checks]) {
      if (SHELL_METACHARS.test(cmd))
        return { ok: false, error: `command carries shell metacharacters: ${cmd}` }
    }
    if (isRemoteUrl(urlOrPath)) {
      if (!urlOrPath.toLowerCase().startsWith('https://')) {
        return { ok: false, error: 'only https:// URLs are accepted (or a local path)' }
      }
      try {
        const parsed = new URL(urlOrPath)
        if (parsed.username !== '' || parsed.password !== '') {
          return { ok: false, error: 'https URL must not carry credentials (user:pass@host)' }
        }
      } catch {
        return { ok: false, error: 'url_or_path is not a valid https URL' }
      }
    } else if (!existsSync(urlOrPath)) {
      return { ok: false, error: `path does not exist: ${urlOrPath}` }
    }
    const id = freshId('repo_')
    const at = now().toISOString()
    store.atomic(() => {
      store.engines.save({
        id,
        label,
        url: urlOrPath,
        bootstrap,
        checks: checks.map((cmd, index) => ({ name: `check_${index + 1}`, cmd })),
        trust: patch.trust === true,
        origin: 'setup_agent',
        createdAt: at,
        updatedAt: at,
      })
      appendEvent(
        store,
        id,
        'repository_registered',
        { id, label, url: urlOrPath, at, origin: 'setup_agent' },
        at,
      )
    })
    return { ok: true, id }
  }

  const defaultSetupAgent = new SetupAgent({
    store,
    api: deps.setupSettingsApi ?? defaultSetupSettingsApi,
    now,
  })

  // The setup agent's open drafts — the inbox-shaped view of §7's propose_change cards.
  app.get('/api/setup/drafts', async () =>
    store.engines
      .list()
      .filter((doc) => String(doc.id).startsWith('draft/'))
      .map((doc) => ({
        id: String(doc.draftId ?? String(doc.id).slice('draft/'.length)),
        target: String(doc.target ?? ''),
        reason: String(doc.reason ?? ''),
        diff: String(doc.diff ?? ''),
        ...(doc.cls !== undefined && { cls: String(doc.cls) }),
        status: String(doc.status ?? 'pending'),
        createdAt: String(doc.createdAt ?? ''),
      })),
  )

  // ─── T1 model routes (review 2026-11-04 §3 + §6.2 — GET/PUT /api/models) ────────
  // ONE additive block, deliberately self-contained: every import it needs is made
  // here, dynamically, so nothing above this comment moves. Route blocks from other
  // work streams append AFTER this block — never reorder, never interleave.
  //
  // The capability table is a prompt part in all but name (§3 rule 4): same
  // provenance (source + sha256), same stale-base 409 discipline as the prompts
  // surface; `PUT` is the ONE write path (agents propose, the user applies), and
  // every write lands as a `models_table_updated` event on the 'models' stream.
  // Availability rides the §21.3 `probeCmd` seam: one local, zero-token
  // `opencode models` per OpenCode slot under its own XDG isolation; claude/codex
  // answer honestly `unlisted` (acceptance probing is gated future work, §3 rule 2).
  app.get('/api/models', async (_request, reply) => {
    const { loadModelsTable } = await import('@mec/prompts')
    const { opencodeProbeEnv, probeModelAvailability } = await import('@mec/slots')
    let loaded: ReturnType<typeof loadModelsTable>
    try {
      loaded = loadModelsTable({ userPath: join(keystoreRoot, 'models.yaml') })
    } catch (error) {
      reply.code(500).send({
        error: 'models table invalid',
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const availability: Array<{
      slotId: string
      engine: string
      provider?: string
      models: Record<string, string>
      note: string
    }> = []
    for (const doc of store.slots.list()) {
      const slot = doc as unknown as {
        id?: string
        engine?: string
        provider?: string
        home?: string
      }
      if (
        slot.id === undefined ||
        (slot.engine !== 'claude' && slot.engine !== 'codex' && slot.engine !== 'opencode')
      ) {
        continue
      }
      const engine = slot.engine
      const run = (cmd: string, args: readonly string[], env?: Record<string, string>) =>
        probeCmd(cmd, args, env !== undefined ? { env: { ...process.env, ...env } } : undefined)
      const report = await probeModelAvailability(run, engine, {
        ...(engine === 'opencode' && slot.home !== undefined ? { env: opencodeProbeEnv(slot.home) } : {}),
      })
      // Merge the probe with the table: a listed model is available; a model the
      // listing omitted while the probe RAN is unavailable; a probe that could not
      // run leaves its entries unlisted — never a guess in either direction. An
      // OpenCode slot only serves its own provider's block (§3), so only that
      // block's entries are marked for it.
      const entryTable = loaded.table.engines[engine]
      const providerKeyOf = (provider: string | undefined): string | undefined => {
        if (provider !== 'zai-coding-plan' && provider !== 'google') return undefined
        return provider in (loaded.table.engines.opencode?.providers ?? {}) ? provider : undefined
      }
      const models: Record<string, string> = {}
      if (engine === 'opencode') {
        const providerKey = providerKeyOf(slot.provider)
        const block = providerKey !== undefined ? entryTable.providers?.[providerKey] : undefined
        if (block !== undefined) {
          for (const id of Object.keys(block.models)) {
            const key = `${providerKey}/${id}`
            models[key] = report.probed ? (report.availability[key] ?? 'unavailable') : 'unlisted'
          }
        }
      } else {
        for (const id of Object.keys(entryTable.models ?? {})) {
          models[id] = report.probed ? (report.availability[id] ?? 'unavailable') : 'unlisted'
        }
      }
      availability.push({
        slotId: slot.id,
        engine,
        ...(slot.provider !== undefined && { provider: slot.provider }),
        models,
        note: report.note,
      })
    }
    return { table: loaded.table, provenance: loaded.provenance, availability }
  })

  app.put('/api/models', async (request, reply) => {
    const body = (request.body ?? {}) as { yaml?: unknown; base_sha256?: unknown }
    const yaml = typeof body.yaml === 'string' ? body.yaml : ''
    if (yaml.trim() === '') {
      reply.code(400).send({ error: 'yaml (the full models.yaml text) is required' })
      return
    }
    const { loadModelsTable, parseModelsYaml, validateModelsTable } = await import('@mec/prompts')
    try {
      validateModelsTable(parseModelsYaml(yaml))
    } catch (error) {
      reply.code(400).send({
        error: 'invalid models table',
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const modelsPath = join(keystoreRoot, 'models.yaml')
    const base =
      typeof body.base_sha256 === 'string' && body.base_sha256 !== '' ? body.base_sha256 : undefined
    if (base !== undefined) {
      let current: string
      try {
        current = loadModelsTable({ userPath: modelsPath }).provenance.sha256
      } catch (error) {
        reply.code(500).send({
          error: 'the currently stored models table is invalid — fix or remove it first',
          detail: error instanceof Error ? error.message : String(error),
        })
        return
      }
      if (current !== base) {
        reply
          .code(409)
          .send({ error: 'stale base — reload the table and reapply the edit', current_sha256: current })
        return
      }
    }
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(keystoreRoot, { recursive: true })
    writeFileSync(modelsPath, yaml, { mode: 0o600 })
    const at = now().toISOString()
    const sha256 = loadModelsTable({ userPath: modelsPath }).provenance.sha256
    store.atomic(() => {
      appendEvent(store, 'models', 'models_table_updated', { path: modelsPath, sha256, at }, at)
    })
    return { provenance: { source: 'user', path: modelsPath, sha256 } }
  })

  // ─── T4 prompt routes (review 2026-11-04 §6.2 · plan §16) ───────────────────────
  // The editable prompt surface: shipped defaults, overrides with provenance, immutable
  // revisions, stale-base refusal, preview and Default-updated diffs — one contiguous block;
  // other route work appends below it. The store is rooted at <keystoreRoot>/prompts, so
  // tests inject a temp root through the existing keystoreRoot seam; the imports come from
  // @mec/prompts (declared in package.json), matching how every other package lands here.
  const prompts = new PromptStore(join(keystoreRoot, 'prompts'))

  // The live config as the Settings page reads it: the FULL catalogue (every shipped
  // default) with edited/default-updated flags, plus the revision. Overrides ride along
  // as their own field so draft tooling keeps its shape.
  app.get('/api/prompts', async () => {
    const { revision, parts } = prompts.config()
    const overridePaths = new Set(parts.map((part) => part.path))
    const changed = new Set(prompts.changes().map((change) => change.path))
    const catalogue = defaultParts().map((part) => ({
      id: part.path,
      layer: part.layer,
      name: part.name,
      edited: overridePaths.has(part.path),
      defaultUpdated: changed.has(part.path),
      provenance: overridePaths.has(part.path) ? 'user override' : 'shipped default',
    }))
    return { revision, parts: catalogue, overrides: parts }
  })

  // One save = one immutable revision (§16.2). The body names the revision it was drafted
  // against; a stale base is refused with 409 and NOTHING is written — the draft survives.
  // A part saved identical to its current default removes the override so the part follows
  // future defaults.
  app.put('/api/prompts', async (request, reply) => {
    const body = (request.body ?? {}) as {
      base_revision?: unknown
      origin?: unknown
      parts?: unknown
    }
    if (
      typeof body.base_revision !== 'number' ||
      !Number.isInteger(body.base_revision) ||
      body.base_revision < 0
    ) {
      reply.code(400).send({ error: 'base_revision must be a non-negative integer' })
      return
    }
    const origin = body.origin === undefined || body.origin === 'panel' ? 'panel' : body.origin
    if (origin !== 'user' && origin !== 'agent' && origin !== 'panel') {
      reply.code(400).send({ error: "origin must be 'user', 'agent' or 'panel'" })
      return
    }
    if (!Array.isArray(body.parts)) {
      reply.code(400).send({ error: 'parts must be an array of {path, text}' })
      return
    }
    const parts: Array<{ path: string; text: string }> = []
    for (const entry of body.parts) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { path?: unknown }).path !== 'string' ||
        typeof (entry as { text?: unknown }).text !== 'string'
      ) {
        reply.code(400).send({ error: 'parts must be an array of {path, text}' })
        return
      }
      parts.push({ path: (entry as { path: string }).path, text: (entry as { text: string }).text })
    }
    try {
      const { revision } = prompts.save({ baseRevision: body.base_revision, origin, parts, now })
      return { revision }
    } catch (error) {
      if (error instanceof StaleBaseError) {
        reply.code(409).send({ error: 'stale_base', current_revision: error.currentRevision })
        return
      }
      if (error instanceof UnknownPartError) {
        reply.code(400).send({ error: error.message })
        return
      }
      throw error
    }
  })

  // Every shipped default (path, layer, name, text, hash) — the read-only side of the editor.
  app.get('/api/prompts/defaults', async () => ({ parts: defaultParts() }))

  // One immutable revision snapshot, verbatim.
  app.get('/api/prompts/revisions/:n', async (request, reply) => {
    const raw = String((request.params as { n?: string }).n ?? '')
    const n = Number.parseInt(raw, 10)
    const snapshot = Number.isInteger(n) && raw === String(n) ? prompts.getRevision(n) : undefined
    if (snapshot === undefined) {
      reply.code(404).send({ error: 'no such revision' })
      return
    }
    return snapshot
  })

  // Assemble a role's full text WITHOUT saving (§6.2): shared → role → conventions → delivery
  // → engine → skills → generated, with the live overrides applied. What the editor's Full
  // prompt tab shows and what an attempt pins.
  app.post('/api/prompts/preview', async (request, reply) => {
    const body = (request.body ?? {}) as { role?: unknown; engine?: unknown }
    if (typeof body.role !== 'string' || body.role.trim() === '') {
      reply.code(400).send({ error: 'role is required' })
      return
    }
    const engine = typeof body.engine === 'string' && body.engine !== '' ? body.engine : undefined
    try {
      const { revision, text } = prompts.assemble(body.role.trim(), engine)
      return { revision, text }
    } catch (error) {
      if (error instanceof Error && /unknown (role|engine)/.test(error.message)) {
        reply.code(400).send({ error: error.message })
        return
      }
      throw error
    }
  })

  // Default-updated parts (§16.3): overrides whose shipped default changed — old default
  // (recovered from revision history), new default, user text — plus removed parts, dropped
  // on the next save.
  app.get('/api/prompts/changes', async () => ({ changes: prompts.changes() }))

  const webDist = deps.webDist ?? WEB_DIST
  if (existsSync(webDist)) {
    app.setNotFoundHandler((request, reply) => {
      // An unknown API path is a JSON 404 for every method, never the app shell: the web client reads
      // a 404 as "not served", and an HTML 200 would parse as a broken payload (or, worse, as data).
      const pathname = decodePath(request.url.split('?')[0] ?? '/')
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        reply.code(404).send({ error: 'not found' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        reply.code(404).send({ error: 'not found' })
        return
      }
      const path = decodePath(request.url.split('?')[0] ?? '/')
      const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
      const candidate = segments.length === 0 ? resolve(webDist, 'index.html') : resolve(webDist, ...segments)
      const withinRoot = candidate === webDist || candidate.startsWith(webDist + sep)
      const isFile = withinRoot && existsSync(candidate) && statSync(candidate).isFile()
      // SPA fallback: anything that is not a file on disk resolves to the app shell.
      const file = isFile ? candidate : resolve(webDist, 'index.html')
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

/** The pre-authorised class names a policy text carries — [] when it cannot load (honest empty). */
function safePolicyPreAuthorised(text: string): string[] {
  try {
    return Object.keys(loadPolicy(text).preAuthorised)
  } catch {
    return []
  }
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
