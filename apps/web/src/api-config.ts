/**
 * Calls for Setup, Connections and Settings. Every read goes through a decoder in
 * config-decode.ts; every save names the base it was drafted against, so a stale one is refused
 * by the server and the screen keeps the draft.
 */

import { HttpError, request } from './api'
import {
  decodeBackupsRecord,
  decodeCapabilities,
  decodeChanges,
  decodeConnections,
  decodeDrafts,
  decodeImpact,
  decodeModelsText,
  decodeParked,
  decodePartTexts,
  decodePolicy,
  decodePreview,
  decodePromptsConfig,
  decodeReadiness,
  decodeRepositories,
  decodeSetupAnswer,
} from './config-decode'
import type {
  Capabilities,
  CheckProfile,
  Connections,
  DraftView,
  ModelsText,
  ParkedRow,
  PolicyView,
  PromptChange,
  PromptsConfig,
  Readiness,
  RepositoryView,
  SetupAnswer,
  SlotImpact,
} from './next/config-model'

/** The server refused a base that is no longer current: 409, and the draft stands. */
export class StaleError extends Error {
  constructor() {
    super('stale')
    this.name = 'StaleError'
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' }

const send = <T>(path: string, method: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method,
    ...(body !== undefined && { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  })

async function saving<T>(save: Promise<T>): Promise<T> {
  try {
    return await save
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) throw new StaleError()
    throw error
  }
}

const slot = (id: string, leaf: string): string => `/api/slots/${encodeURIComponent(id)}/${leaf}`

export const configApi = {
  async capabilities(): Promise<Capabilities> {
    return decodeCapabilities(await request<unknown>('/api/status'))
  },

  /** `known` answers at once from the last look at the engines, which may not have finished. */
  async readiness(engines: 'probe' | 'known' = 'probe'): Promise<Readiness> {
    const query = engines === 'known' ? '?engines=known' : ''
    return decodeReadiness(await request<unknown>(`/api/setup/readiness${query}`))
  },

  skipStep(step: string): Promise<unknown> {
    return send('/api/setup/skip', 'POST', { step })
  },

  chooseMetaSlot(slotId: string): Promise<unknown> {
    return send('/api/wizard/meta-slot', 'POST', { slotId })
  },

  async connections(): Promise<Connections> {
    return decodeConnections(await request<unknown>('/api/connections'))
  },

  async parked(): Promise<ParkedRow[]> {
    return decodeParked(await request<unknown>('/api/parked'))
  },

  /** A refusal is the server's reason on an HttpError, never read as stale. */
  switchWork(workItemId: string, toSlot: string): Promise<{ status: unknown }> {
    return send(`/api/work/${encodeURIComponent(workItemId)}/switch-slot`, 'POST', { toSlot })
  },

  async impact(id: string): Promise<SlotImpact> {
    return decodeImpact(await request<unknown>(slot(id, 'impact')))
  },

  retireSlot(id: string, label: string): Promise<unknown> {
    return send(slot(id, 'retire'), 'POST', { label })
  },

  replaceKey(
    id: string,
    key: string,
  ): Promise<{ fingerprint: { last4: string }; probe: { ok: boolean; reason?: string } }> {
    return send(slot(id, 'key'), 'POST', { key })
  },

  validate(id: string): Promise<{ ok: boolean; reason?: string }> {
    return send(slot(id, 'validate'), 'POST')
  },

  probe(id: string): Promise<{ ok: boolean; state: string; reason?: string }> {
    return send(slot(id, 'probe'), 'POST')
  },

  link(engine: string, label: string): Promise<{ id: string }> {
    return send('/api/slots/link', 'POST', { engine, label })
  },

  dedicated(engine: string, label: string): Promise<{ id: string }> {
    return send('/api/slots/dedicated', 'POST', { engine, label })
  },

  addKey(label: string, provider: string, key: string): Promise<{ id: string }> {
    return send('/api/slots/api-key', 'POST', { label, provider, key })
  },

  startLogin(engine: string, label: string): Promise<{ id: string; busy: boolean }> {
    return send('/api/slots/login', 'POST', { engine, label })
  },

  cancelLogin(id: string): Promise<unknown> {
    return fetch('/api/slots/login/cancel', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-mec-client': '1' },
      body: JSON.stringify({ id }),
    })
  },

  async policy(): Promise<PolicyView> {
    return decodePolicy(await request<unknown>('/api/policy'))
  },

  savePolicy(text: string, baseSha256: string): Promise<{ sha256: string; revision: number }> {
    return saving(send('/api/policy', 'PUT', { text, base_sha256: baseSha256 }))
  },

  async modelsText(): Promise<ModelsText> {
    return decodeModelsText(await request<unknown>('/api/models/text'))
  },

  saveModels(yaml: string, baseSha256: string): Promise<{ provenance: { sha256: string } }> {
    return saving(send('/api/models', 'PUT', { yaml, base_sha256: baseSha256 }))
  },

  async prompts(): Promise<PromptsConfig> {
    return decodePromptsConfig(await request<unknown>('/api/prompts'))
  },

  async promptDefaults(): Promise<Record<string, string>> {
    const path = '/api/prompts/defaults'
    return decodePartTexts(await request<unknown>(path), path)
  },

  async promptRevision(n: number): Promise<Record<string, string>> {
    const path = `/api/prompts/revisions/${n}`
    return decodePartTexts(await request<unknown>(path), path)
  },

  async promptChanges(): Promise<PromptChange[]> {
    return decodeChanges(await request<unknown>('/api/prompts/changes'))
  },

  async promptPreview(role: string): Promise<{ revision: string; text: string }> {
    return decodePreview(await send<unknown>('/api/prompts/preview', 'POST', { role }))
  },

  savePromptPart(path: string, text: string, baseRevision: number): Promise<{ revision: number }> {
    return saving(send('/api/prompts', 'PUT', { base_revision: baseRevision, parts: [{ path, text }] }))
  },

  async repositories(): Promise<RepositoryView[]> {
    return decodeRepositories(await request<unknown>('/api/repositories'))
  },

  addRepository(input: {
    urlOrPath: string
    bootstrapCmds: string[]
    checkCmds: CheckProfile[]
  }): Promise<{ id: string }> {
    return send('/api/repositories', 'POST', { ...input, trusted: false })
  },

  /** The owner's own words on the armed panel; the server takes them from nowhere else. */
  agreeHostRun(id: string): Promise<unknown> {
    return send(`/api/repositories/${encodeURIComponent(id)}/host-run/agree`, 'POST', {})
  },

  withdrawHostRun(id: string): Promise<unknown> {
    return send(`/api/repositories/${encodeURIComponent(id)}/host-run/withdraw`, 'POST', {})
  },

  editRepository(
    id: string,
    baseRevision: string,
    patch: { bootstrapCmds?: string[]; checkCmds?: CheckProfile[]; trusted?: boolean },
  ): Promise<{ id: string; revision: string }> {
    return saving(
      send(`/api/repositories/${encodeURIComponent(id)}`, 'PATCH', {
        base_revision: baseRevision,
        ...patch,
      }),
    )
  },

  /** Setup mode: the setup agent answers, and no repository is named. */
  async setupMessage(text: string): Promise<SetupAnswer> {
    return decodeSetupAnswer(await send<unknown>('/api/chat/messages', 'POST', { text, setup: true }))
  },

  async drafts(): Promise<DraftView[]> {
    return decodeDrafts(await request<unknown>('/api/setup/drafts'))
  },

  applyDraft(id: string, base?: string | number): Promise<unknown> {
    return saving(
      send(`/api/setup/drafts/${encodeURIComponent(id)}/apply`, 'POST', {
        ...(base !== undefined && { base }),
      }),
    )
  },

  dismissDraft(id: string): Promise<unknown> {
    return send(`/api/setup/drafts/${encodeURIComponent(id)}/dismiss`, 'POST', {})
  },

  async backups() {
    return decodeBackupsRecord(await request<unknown>('/api/backups'))
  },

  takeBackup(): Promise<{ status: string; lastAt: string; archive: string }> {
    return send('/api/backups', 'POST', {})
  },

  processing(): Promise<{ paused: boolean; pausedAt?: string }> {
    return request('/api/processing')
  },

  pause(): Promise<{ status: string }> {
    return send('/api/processing/pause', 'POST')
  },

  resume(): Promise<{ status: string }> {
    return send('/api/processing/resume', 'POST')
  },
}
