/**
 * Typed wrappers over the workbench server's HTTP API. All views go through
 * this module; the server contract is the one in docs/handoff (status, chat,
 * inbox, work, events).
 *
 * Reads the server really serves go through the decoders in api-decode.ts (the real shapes are
 * pinned by test/web-contract.test.ts). Reads it does not serve yet reject with NotServedError
 * (a JSON 404 from the server) and the view shows an honest, finite "not served" state: this
 * module holds no demo data and never invents a payload. Operations that would fake an effect
 * (hold/stop/pause, backups) report the gap instead. Screens supply their own mocks in
 * test/screens.playwright.ts.
 */

import { decodeBackups, decodeModels, decodePrompts, decodeQuestions } from './api-decode'

export type PartState = 'ok' | 'degraded' | 'error'
export type PartEntry = { state: PartState; detail?: string }
export type RuntimeState = 'starting' | 'ready' | 'paused' | 'error'

/** GET /api/status — the health snapshot behind the runtime line and Slots view. */
export type StatusSnapshot = {
  runtime: { state: RuntimeState; instances: number; answering: boolean }
  parts: Record<string, PartEntry>
  setup: { has_slot: boolean; has_repository: boolean }
}

/**
 * GET /api/chat/messages — newest last. The server persists plain rows today
 * ({id, text, createdAt}); `kind`, `meta`, `plan` and `noticeRoute` are the
 * conversation vocabulary the design needs (user / agent / status / notice and
 * plan cards).
 *
 * TODO(server) #6 of 10: chat message kinds + plan payloads — until the server
 * attaches them, a message with no `kind` renders as a plain line (never
 * guessed), and plan cards arrive only where the feed carries them.
 */
export type ChatMessageKind = 'user' | 'agent' | 'status' | 'notice'
export type PlanTaskRow = {
  id: string
  task: string
  role: string
  tier: string
  slot: string
  state: string
  stateKind?: 'ok' | 'warn' | 'attn' | 'bad' | 'done'
}
export type ChatPlan = { title: string; note?: string; approvedNote?: string; tasks: PlanTaskRow[] }
export type ChatMessage = {
  id: string
  text: string
  createdAt: string
  repoId?: string
  workItemId?: string
  /** The meta agent's acknowledgement, stored on the message it answers. */
  ackText?: string
  /** The server redacted this message: it looked like a key. */
  secretGuard?: boolean
  /** Said while processing was paused. It is not a receipt: the turn has not run. */
  pausedAck?: string
  kind?: ChatMessageKind
  /** Who said it, e.g. "Meta agent on max-1" / "You". */
  meta?: string
  plan?: ChatPlan
  /** A notice's optional action, e.g. { label: "See slots", route: "slots" }. */
  noticeRoute?: { label: string; route: string }
}

/** §12.1: a New request starts work; a follow-up names the work it binds to. */
export type ChatIntent = 'new' | 'follow_up'
export type ChatTarget = { repoId: string; referencesWorkItem?: string; intent?: ChatIntent }

/** POST /api/chat/messages response. */
export type SendChatResult = { messageId: string; workItemId?: string }

/** GET /api/inbox — confirmations still waiting on a person. */
export type InboxItem = { id: string; cls: string; operationHash: string; expiresAt: string }

/**
 * The evidence a decision card states in words (§7): what will happen, why it
 * is being asked, the facts (branch, bound head SHA, checks, findings), the
 * consequences of either answer, and the diff summary.
 *
 * TODO(server) #1 of 10: decision what/why/facts/consequences/checks/findings/diff —
 * the inbox serves {id, cls, operationHash, expiresAt}; the detail route serves release cards and
 * the meta agent's cards, and any other card says the evidence is not served.
 */
export type DecisionCheck = { name: string; state: 'passed' | 'failed' | 'running' | 'none'; note?: string }
export type DecisionFinding = { title: string; disposition: string }
export type DecisionDetail = {
  /** True when this is the honest placeholder: the server does not serve this evidence. */
  absent?: true
  what: string
  /** The effect in words for the confirm button; a served card names its own. */
  verb?: string
  why: string
  facts: Array<{ label: string; value: string; mono?: boolean }>
  operation: string
  requestedBy: string
  consequences: { approve: string; deny: string }
  checks: DecisionCheck[]
  findings: DecisionFinding[]
  diff: { summary: string; files: Array<{ path: string; added: number; removed: number }> }
}

/**
 * A specialist's question as a card with choices (§5 "A question from a
 * specialist").
 *
 * Decoded from the server's question records (decodeQuestions): the record has the
 * question, its options and a `why`; the asker's role, side note and evidence code are
 * not recorded yet, so those fields stay absent.
 */
export type Question = {
  id: string
  eyebrow: string
  what: string
  why: string
  options: string[]
  sideNote?: string
  evidence?: { note: string; code: string }
}

export type WorkTaskCounts = { total: number; byStatus: Record<string, number> }

/**
 * GET /api/work — one row per work item, exactly as the server serves it:
 * {id, state, stage, held, taskCounts: {total, byStatus}, updatedAt} (stage is the
 * item's own lifecycle state until the §10 projection lands). `repoId` is absent on legacy
 * rows, which are read-only. `title` is the origin message's first line.
 */
export type WorkItem = {
  id: string
  repoId?: string
  title?: string
  state: string
  stage: string
  held?: boolean
  taskCounts: WorkTaskCounts
  updatedAt: string
}

/**
 * TODO(server) #3 of 10: work-item detail — the pane's full record (mandate,
 * policy hash, bundle revision, tasks, handoffs, "so far"). Not served yet: the
 * pane says so instead of inventing a record.
 */
export type WorkItemDetail = {
  /** True when this is the honest placeholder: the server does not serve this detail. */
  absent?: true
  title: string
  stage: string
  kv: Array<{ label: string; value: string; mono?: boolean }>
  tasks: Array<{
    id?: string
    name: string
    state: string
    stateKind?: 'ok' | 'warn' | 'attn' | 'bad' | 'done'
  }>
  handoffs: Array<{ title: string; note: string }>
  soFar?: Array<{ label: string; value: string }>
}

/**
 * TODO(server) #4 of 10: task / attempt detail — role, tier and resolved model,
 * slot, head, state, report summary.
 */
export type TaskDetail = {
  /** True when this is the honest placeholder: the server does not serve this detail. */
  absent?: true
  name: string
  kv: Array<{ label: string; value: string; mono?: boolean }>
  report?: string
  note?: string
}

/**
 * GET /api/slots — slot docs from the store. Fingerprints only: a key never leaves the
 * slot keystore on disk (§5.4), so no endpoint could ever echo one.
 */
export type SlotEntry = {
  id: string
  label: string
  engine: string
  kind: string
  provider: string
  state: string
  stateReason?: string
  home?: string
  fingerprint?: { provider: string; last4: string }
  /**
   * TODO(server) #5 of 10: slot usage with `unknown` — a reading only when the
   * provider has a usage API; `unknown` renders as "No reading yet", never 0%.
   */
  usage?: SlotUsage
}
export type SlotUsage =
  | { kind: 'unknown'; reason: string }
  | { kind: 'percent'; label: string; percent: number; resetsAt?: string; lines?: string[] }

/** POST /api/slots/api-key — the §5.7 courier's receipt: identity + fingerprint, never the key. */
export type AddApiKeyResult = { id: string; fingerprint: { provider: string; last4: string } }

/** POST /api/slots/:id/validate — the §5.8 zero-token probe verdict. */
export type ValidateSlotResult = { ok: boolean; reason?: 'key_rejected' | 'provider_unreachable' }

/** GET /api/wizard/engines — §21.3 step 1: one row per engine the setup flow knows. */
export type EngineName = 'claude' | 'codex' | 'opencode'
export type EngineStatus = { engine: EngineName; installed: boolean; version?: string }

/**
 * GET /api/wizard/existing-logins — §21.3 step 2: what the engine's own status command
 * reports in its DEFAULT home. null where v0 does not probe (codex/opencode) or the
 * binary is missing — unknown, never "signed out".
 */
export type ExistingLogin = { engine: EngineName; loggedIn: boolean; email?: string; plan?: string }
export type ExistingLogins = Record<EngineName, ExistingLogin | null>

/** POST /api/slots/link — the §5.3 slot-0 receipt: the default home, linked, no key involved. */
export type LinkedSlotResult = {
  id: string
  label: string
  engine: string
  kind: string
  state: string
  home: string
}

/** GET/POST /api/repositories — a registered repository (§14): where work lands. */
export type RepositoryEntry = {
  id: string
  url: string
  bootstrap: string[]
  checks: Array<{ name: string; cmd: string }>
  trust: boolean
}

export type ResolveAnswer = 'approve' | 'deny'
/** What an answer did. `status` is the card's own; the rest is the truth about the action. */
export type ResolveResult = {
  status: string
  reason?: string
  error?: string
  merged?: boolean
  pushed?: boolean
  prNumber?: number
  /** A running agent was waiting on this answer, and now has it. */
  continues?: boolean
}

/**
 * TODO(server) #7 of 10: prompts endpoint — the part list by layer with edited
 * and default-updated marks, provenance and revision history.
 */
export type PromptPart = {
  id: string
  layer: string
  name: string
  edited?: boolean
  defaultUpdated?: boolean
  provenance?: string
  text?: string
  more?: number
}

/**
 * TODO(server) #8 of 10: models endpoint — the tier ladder with the vendor's
 * own words, per provider.
 */
export type ModelTiers = {
  providers: string[]
  rows: Array<{ tier: string; cells: Array<{ text: string; note?: string } | undefined> }>
  note: string
}

/**
 * TODO(server) #10 of 10: backups — the last run and what it excludes.
 */
export type BackupsStatus = { lastAt?: string; note: string; excluded: string }

/** A non-2xx response from the workbench server. */
export class HttpError extends Error {
  readonly path: string
  readonly status: number
  /** The server's own `{error}` text when it sent one — the exact 400 reason, shown inline. */
  readonly reason?: string
  /** The server's `{detail}` when it sent one: why, where `reason` is often only a code. */
  readonly detail?: string

  constructor(path: string, status: number, reason?: string, detail?: string) {
    super(
      reason === undefined
        ? `${path} failed with HTTP ${status}`
        : `${path} failed with HTTP ${status}: ${reason}`,
    )
    this.name = 'HttpError'
    this.path = path
    this.status = status
    this.reason = reason
    if (detail !== undefined) this.detail = detail
  }
}

/** POST /api/inbox/:id/resolve returned 409: another actor handled it first. */
export class AlreadyHandledError extends Error {
  readonly alreadyHandled: true = true

  constructor() {
    super('already resolved by someone else')
    this.name = 'AlreadyHandledError'
  }
}

export function isAlreadyHandled(error: unknown): boolean {
  return error instanceof AlreadyHandledError
}

/** An endpoint the server does not serve yet (one of the ten marked seams above). */
export class NotServedError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`${path} is not served by the server yet`)
    this.name = 'NotServedError'
    this.path = path
  }
}

export function isNotServed(error: unknown): boolean {
  return error instanceof NotServedError
}

/** One idempotency key per draft; the UUID generator stays inside this module. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/** The checked response, for the one route whose body is not always JSON. */
export async function requestResponse(path: string, init?: RequestInit): Promise<Response> {
  // §22 CSRF discipline: the custom header every mutating call must carry; a
  // cross-origin page cannot add it without a preflight this server never answers.
  const withHeader: RequestInit = {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), 'x-mec-client': '1' },
  }
  const response = await fetch(path, withHeader)
  if (!response.ok) {
    const { error, detail } = await errorOf(response)
    throw new HttpError(path, response.status, error, detail)
  }
  return response
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await requestResponse(path, init)).json()) as T
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** The body's `error` and `detail` text when the server sent them; never throws. */
async function errorOf(response: Response): Promise<{ error?: string; detail?: string }> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null) {
      const { error, detail } = body as { error?: unknown; detail?: unknown }
      return { error: text(error), detail: text(detail) }
    }
  } catch {
    // A non-JSON error body carries no reason worth showing.
  }
  return {}
}

/** Reads a not-yet-served endpoint; a 404 (route absent) becomes NotServedError. */
async function requestOrNotServed<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await request<T>(path, init)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw new NotServedError(path)
    throw error
  }
}

/**
 * A read the server does not serve (NotServedError: a JSON 404) degrades to the honest `absent`
 * placeholder, which says so in words. Any other failure propagates — a 500 is a real error.
 */
async function orAbsent<T>(call: () => Promise<T>, absent: () => T): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof NotServedError) return absent()
    throw error
  }
}

const repoQuery = (repoId?: string): string =>
  repoId === undefined ? '' : `?repoId=${encodeURIComponent(repoId)}`

export const api = {
  status(): Promise<StatusSnapshot> {
    return request<StatusSnapshot>('/api/status')
  },

  async sendChat(text: string, target: ChatTarget, idempotencyKey?: string): Promise<SendChatResult> {
    const key = idempotencyKey ?? newIdempotencyKey()
    const body: Record<string, string> = { text, repoId: target.repoId }
    if (target.referencesWorkItem !== undefined) body.referencesWorkItem = target.referencesWorkItem
    if (target.intent !== undefined) body.intent = target.intent
    return request<SendChatResult>('/api/chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': key },
      body: JSON.stringify(body),
    })
  },

  /** Everything with no `repoId`, one repository's rows with one, `unassigned` for legacy rows. */
  chat(repoId?: string, signal?: AbortSignal): Promise<ChatMessage[]> {
    return request<ChatMessage[]>(`/api/chat/messages${repoQuery(repoId)}`, { signal })
  },

  inbox(): Promise<InboxItem[]> {
    return request<InboxItem[]>('/api/inbox')
  },

  /** Throws AlreadyHandledError when the confirmation was resolved elsewhere. */
  async resolve(id: string, answer: ResolveAnswer): Promise<ResolveResult> {
    const path = `/api/inbox/${encodeURIComponent(id)}/resolve`
    try {
      return await request<ResolveResult>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer }),
      })
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) throw new AlreadyHandledError()
      throw error
    }
  },

  /** Same scopes as `chat`. */
  work(repoId?: string, signal?: AbortSignal): Promise<WorkItem[]> {
    return request<WorkItem[]>(`/api/work${repoQuery(repoId)}`, { signal })
  },

  slots(): Promise<SlotEntry[]> {
    return request<SlotEntry[]>('/api/slots')
  },

  /** The card's evidence in words (an honest "not served" placeholder when the server has none). */
  decisionDetail(id: string): Promise<DecisionDetail> {
    return orAbsent(
      () => requestOrNotServed<DecisionDetail>(`/api/inbox/${encodeURIComponent(id)}/detail`),
      () => absentDecisionDetail(id),
    )
  },

  /** Open questions as cards, decoded from the server's question records. */
  async questions(): Promise<Question[]> {
    return decodeQuestions(await request<unknown>('/api/questions'))
  },

  /** The pane's work-item record; unknown ids degrade to the honest /api/work row. */
  workItemDetail(id: string): Promise<WorkItemDetail> {
    return orAbsent(
      () => requestOrNotServed<WorkItemDetail>(`/api/work/${encodeURIComponent(id)}`),
      () => absentWorkItemDetail(id),
    )
  },

  /** The pane's task / attempt record. */
  taskDetail(id: string): Promise<TaskDetail> {
    return orAbsent(
      () => requestOrNotServed<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
      () => absentTaskDetail(id),
    )
  },

  /** §5.6: cancel the running login card (the terminal card's own Cancel). */
  cancelLogin(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/slots/login/cancel', { method: 'POST' })
  },

  /**
   * The §5.7 courier: provider → masked key → slot keystore. The key is sent exactly once
   * and the receipt carries only the fingerprint — the key is never echoed back.
   */
  /** The provider kinds the courier accepts (server's API_KEY_PROVIDERS table). */
  addApiKey(
    label: string,
    key: string,
    provider: 'anthropic-api' | 'glm-api' | 'gemini-api' = 'anthropic-api',
  ): Promise<AddApiKeyResult> {
    return request<AddApiKeyResult>('/api/slots/api-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, provider, key }),
    })
  },

  /** §5.8 zero-token probe (GET /v1/models) against the slot's stored key. */
  validateSlot(id: string): Promise<ValidateSlotResult> {
    return request<ValidateSlotResult>(`/api/slots/${encodeURIComponent(id)}/validate`, {
      method: 'POST',
    })
  },

  /** §5.7 retire: shreds the slot's keystore file and retires the slot doc. */
  retireSlot(id: string): Promise<{ id: string; state: string }> {
    return request<{ id: string; state: string }>(`/api/slots/${encodeURIComponent(id)}/retire`, {
      method: 'POST',
    })
  },

  /** §21.3 step 1: which engines are installed, and which versions. */
  wizardEngines(): Promise<EngineStatus[]> {
    return request<EngineStatus[]>('/api/wizard/engines')
  },

  /** §21.3 step 2: existing logins in each engine's DEFAULT home (claude-only in v0). */
  wizardExistingLogins(): Promise<ExistingLogins> {
    return request<ExistingLogins>('/api/wizard/existing-logins')
  },

  /** §5.3 slot 0: link the engine's existing default-home login as a slot (no key involved). */
  linkSlot(engine: string, label: string): Promise<LinkedSlotResult> {
    return request<LinkedSlotResult>('/api/slots/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine, label }),
    })
  },

  /**
   * §5.6 terminal card: starts the vendor's own login command in a dedicated slot home
   * (the server resolves the label to a home — the browser never composes slot paths).
   */
  startLogin(engine: string, label: string): Promise<{ id: string; busy: boolean }> {
    return request<{ id: string; busy: boolean }>('/api/slots/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine, label }),
    })
  },

  /** §14/§21.3 step 3: register the repository work lands in (path or credential-free https). */
  addRepository(input: {
    urlOrPath: string
    bootstrapCmds: string[]
    checkCmds: Array<{ name: string; cmd: string }>
    trusted: boolean
  }): Promise<RepositoryEntry> {
    return request<RepositoryEntry>('/api/repositories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  },

  repositories(): Promise<RepositoryEntry[]> {
    return request<RepositoryEntry[]>('/api/repositories')
  },

  /** §21.3 step 4: the slot the meta agent runs on; last write wins. */
  setMetaSlot(slotId: string): Promise<{ id: string; slotId: string }> {
    return request<{ id: string; slotId: string }>('/api/wizard/meta-slot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotId }),
    })
  },

  metaSlot(): Promise<{ slotId: string | null }> {
    return request<{ slotId: string | null }>('/api/wizard/meta-slot')
  },

  /** The prompt parts by layer, decoded from `{revision, parts, overrides}`. */
  async prompts(): Promise<PromptPart[]> {
    return decodePrompts(await request<unknown>('/api/prompts'))
  },

  /** The tier ladder with the vendor's own words, decoded from the capability table. */
  async models(): Promise<ModelTiers> {
    return decodeModels(await request<unknown>('/api/models'))
  },

  /** POST /api/questions/:id/answer — the server's body key is `answer`; 404/409 are real answers, not "not served". */
  answerQuestion(id: string, answer: string): Promise<{ status: string }> {
    return request<{ status: string }>(`/api/questions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    })
  },

  /**
   * The operator commands beyond approve/deny. An older server without a route still reports
   * the gap honestly instead of pretending the effect happened.
   */
  holdWorkItem(id: string): Promise<{ status: string }> {
    return requestOrNotServed<{ status: string }>(`/api/work/${encodeURIComponent(id)}/hold`, {
      method: 'POST',
    })
  },

  /** POST /api/work/:id/lift — the only release of a hold; 409 carries why it was refused. */
  liftWorkItem(id: string): Promise<{ status: string; launches: number }> {
    return requestOrNotServed<{ status: string; launches: number }>(
      `/api/work/${encodeURIComponent(id)}/lift`,
      { method: 'POST' },
    )
  },

  stopWorkItem(id: string): Promise<{ status: string }> {
    return requestOrNotServed<{ status: string }>(`/api/work/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    })
  },

  pauseProcessing(): Promise<{ status: string; pausedAt?: string }> {
    return requestOrNotServed<{ status: string; pausedAt?: string }>('/api/processing/pause', {
      method: 'POST',
    })
  },

  resumeProcessing(): Promise<{ status: string }> {
    return requestOrNotServed<{ status: string }>('/api/processing/resume', { method: 'POST' })
  },

  processing(): Promise<{ paused: boolean; pausedAt?: string }> {
    return requestOrNotServed<{ paused: boolean; pausedAt?: string }>('/api/processing')
  },

  /** #10 read side: the backups record; rejects with NotServedError until the server serves one. */
  async backups(): Promise<BackupsStatus> {
    return decodeBackups(await requestOrNotServed<unknown>('/api/backups'))
  },

  backupNow(): Promise<{ status: string }> {
    return requestOrNotServed<{ status: string }>('/api/backups', { method: 'POST' })
  },
}

/**
 * The honest placeholders for what the server does not serve yet: they never
 * invent evidence, they say the server does not serve it.
 */
function absentDecisionDetail(id: string): DecisionDetail {
  return {
    absent: true,
    what: 'This confirmation’s evidence is not served by the server yet.',
    why: `The inbox serves only the class, the operation hash and the expiry today; the card’s what, why, facts, checks, findings and diff arrive with the decision-detail endpoint.`,
    facts: [
      { label: 'Class', value: id },
      { label: 'Operation', value: 'not served yet', mono: true },
    ],
    operation: '—',
    requestedBy: '—',
    consequences: {
      approve: 'unknown until the endpoint serves it',
      deny: 'unknown until the endpoint serves it',
    },
    checks: [],
    findings: [],
    diff: { summary: 'not served by the server yet', files: [] },
  }
}

function absentWorkItemDetail(id: string): WorkItemDetail {
  return {
    absent: true,
    title: id,
    stage: 'unknown — work-item detail is not served by the server yet',
    kv: [{ label: 'Work item', value: id, mono: true }],
    tasks: [],
    handoffs: [],
  }
}

function absentTaskDetail(id: string): TaskDetail {
  return {
    absent: true,
    name: id,
    kv: [
      { label: 'Task', value: id, mono: true },
      { label: 'State', value: 'not served by the server yet' },
    ],
  }
}

export type ServerEvent = { seq: number } & Record<string, unknown>

/** §5.6 card events — output and URLs flow live; exit/timeout end the card. */
export type LoginCardEvent =
  | { kind: 'output'; data: string }
  | { kind: 'exit'; code: number }
  | { kind: 'timeout' }
  | { kind: 'url'; url: string }

/**
 * Subscribes to the live login card (`GET /api/slots/login/current`, §5.6). The stream
 * is live-only — no backlog, no persistence — so this attaches right after starting a
 * card; the terminal event closes the source so it never reconnects into a 404.
 * Frames that are not JSON, or lack a string `kind`, are dropped. Returns a disposer.
 */
export function subscribeLoginCard(onEvent: (event: LoginCardEvent) => void): () => void {
  const source = new EventSource('/api/slots/login/current')
  let done = false
  source.onmessage = (message) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(message.data)
    } catch {
      return
    }
    const kind =
      typeof parsed === 'object' && parsed !== null ? (parsed as { kind?: unknown }).kind : undefined
    if (!done && typeof kind === 'string') onEvent(parsed as LoginCardEvent)
    if (kind === 'exit' || kind === 'timeout') {
      done = true
      source.close()
    }
  }
  return () => {
    done = true
    source.close()
  }
}

/**
 * Subscribes to the server's SSE feed (`GET /api/events?stream=&after=`).
 * Frames that are not JSON, or lack a numeric `seq`, are dropped. Returns a
 * disposer that closes the stream.
 */
export function subscribeEvents(
  stream: string,
  after: number,
  onEvent: (event: ServerEvent) => void,
): () => void {
  return subscribeMerged([{ stream, after }], onEvent)
}

/**
 * ONE EventSource for every stream (browsers cap ~6 connections per origin on HTTP/1.1,
 * and the workbench needs more streams than that — a stream-per-connection starves every
 * fetch behind the cap, which is exactly the stuck-"sending…" bug). The server accepts a
 * comma-separated stream list with comma-aligned cursors.
 */
export function subscribeMerged(
  subscriptions: ReadonlyArray<{ stream: string; after: number }>,
  onEvent: (event: ServerEvent) => void,
): () => void {
  if (subscriptions.length === 0) return () => {}
  const streams = subscriptions.map((s) => s.stream).join(',')
  const after = subscriptions.map((s) => s.after).join(',')
  const source = new EventSource(`/api/events?stream=${encodeURIComponent(streams)}&after=${after}`)
  source.onmessage = (message) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(message.data)
    } catch {
      return
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { seq?: unknown }).seq === 'number'
    ) {
      onEvent(parsed as ServerEvent)
    }
  }
  return () => source.close()
}
