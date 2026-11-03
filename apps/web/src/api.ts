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

export type ResolveAnswer = 'approve' | 'deny'
export type ResolveResult = { status: string }

/** A non-2xx response from the workbench server. */
export class HttpError extends Error {
  readonly path: string
  readonly status: number

  constructor(path: string, status: number) {
    super(`${path} failed with HTTP ${status}`)
    this.name = 'HttpError'
    this.path = path
    this.status = status
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
  const response = await fetch(path, init)
  if (!response.ok) throw new HttpError(path, response.status)
  return (await response.json()) as T
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
}

export type ServerEvent = { seq: number } & Record<string, unknown>

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
