/**
 * Typed wrappers over the workbench server's HTTP API. All views go through
 * this module; the server contract is the one in docs/handoff (status, chat,
 * inbox, work, events).
 */

export type PartState = 'ok' | 'degraded' | 'error'
export type PartEntry = { state: PartState; detail?: string }
export type RuntimeState = 'starting' | 'ready' | 'paused' | 'error'

/** GET /api/status — the health snapshot behind the top badge and Slots view. */
export type StatusSnapshot = {
  runtime: { state: RuntimeState; instances: number; answering: boolean }
  parts: Record<string, PartEntry>
  setup: { has_slot: boolean; has_repository: boolean }
}

/** GET /api/chat/messages — newest last. */
export type ChatMessage = { id: string; text: string; at: string; workItemId?: string }

/** POST /api/chat/messages response. */
export type SendChatResult = { messageId: string; workItemId?: string }

/** GET /api/inbox — confirmations still waiting on a person. */
export type InboxItem = { id: string; cls: string; operationHash: string; expiresAt: string }

export type WorkTaskCounts = {
  ready: number
  active: number
  awaiting_review: number
  integrated: number
}

/** GET /api/work — one row per work item, placed on the board by `stage`. */
export type WorkItem = { id: string; stage: string; taskCounts: WorkTaskCounts; createdAt: string }

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
}

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
export type ResolveResult = { status: string }

/** A non-2xx response from the workbench server. */
export class HttpError extends Error {
  readonly path: string
  readonly status: number
  /** The server's own `{error}` text when it sent one — the exact 400 reason, shown inline. */
  readonly reason?: string

  constructor(path: string, status: number, reason?: string) {
    super(
      reason === undefined
        ? `${path} failed with HTTP ${status}`
        : `${path} failed with HTTP ${status}: ${reason}`,
    )
    this.name = 'HttpError'
    this.path = path
    this.status = status
    this.reason = reason
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

/** One idempotency key per draft; the UUID generator stays inside this module. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // §22 CSRF discipline: the custom header every mutating call must carry; a
  // cross-origin page cannot add it without a preflight this server never answers.
  const withHeader: RequestInit = {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), 'x-mec-client': '1' },
  }
  const response = await fetch(path, withHeader)
  if (!response.ok) throw new HttpError(path, response.status, await errorOf(response))
  return (await response.json()) as T
}

/** The body's `error` text when the server sent one; never throws. */
async function errorOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null) {
      const error = (body as { error?: unknown }).error
      if (typeof error === 'string' && error !== '') return error
    }
  } catch {
    // A non-JSON error body carries no reason worth showing.
  }
  return undefined
}

export const api = {
  status(): Promise<StatusSnapshot> {
    return request<StatusSnapshot>('/api/status')
  },

  async sendChat(
    text: string,
    referencesWorkItem?: string,
    idempotencyKey?: string,
  ): Promise<SendChatResult> {
    const key = idempotencyKey ?? newIdempotencyKey()
    const body: Record<string, string> = { text }
    if (referencesWorkItem !== undefined) body.referencesWorkItem = referencesWorkItem
    return request<SendChatResult>('/api/chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': key },
      body: JSON.stringify(body),
    })
  },

  chat(): Promise<ChatMessage[]> {
    return request<ChatMessage[]>('/api/chat/messages')
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

  work(): Promise<WorkItem[]> {
    return request<WorkItem[]>('/api/work')
  },

  slots(): Promise<SlotEntry[]> {
    return request<SlotEntry[]>('/api/slots')
  },

  /**
   * The §5.7 courier: provider → masked key → slot keystore. The key is sent exactly once
   * and the receipt carries only the fingerprint — the key is never echoed back.
   */
  addApiKey(label: string, key: string): Promise<AddApiKeyResult> {
    return request<AddApiKeyResult>('/api/slots/api-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, provider: 'anthropic-api', key }),
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
  const source = new EventSource(`/api/events?stream=${encodeURIComponent(stream)}&after=${after}`)
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
