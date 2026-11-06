import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../src/api'
import { configApi, StaleError } from '../src/api-config'
import { decodeCapabilities, decodeChanges, decodeConnections, decodeReadiness } from '../src/config-decode'

type Sent = { path: string; method?: string; body?: Record<string, unknown> }

function stub(status: number, body: unknown): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    sent.push({
      path,
      ...(init?.method !== undefined && { method: init.method }),
      ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) as Record<string, unknown> }),
    })
    return new Response(JSON.stringify(body), { status })
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saves always name their base', () => {
  it('models carries base_sha256', async () => {
    const sent = stub(200, { provenance: { source: 'user', path: '/x', sha256: 'b' } })
    await configApi.saveModels('yaml: text', 'abc')
    expect(sent[0]).toMatchObject({
      path: '/api/models',
      method: 'PUT',
      body: { yaml: 'yaml: text', base_sha256: 'abc' },
    })
  })

  it('prompts carries base_revision', async () => {
    const sent = stub(200, { revision: 4 })
    await configApi.savePromptPart('roles/x.md', 'text', 3)
    expect(sent[0]?.body).toEqual({
      base_revision: 3,
      parts: [{ path: 'roles/x.md', text: 'text' }],
    })
  })

  it('policy carries base_sha256', async () => {
    const sent = stub(200, { sha256: 'n', revision: 1 })
    await configApi.savePolicy('{}', 'old')
    expect(sent[0]?.body).toEqual({ text: '{}', base_sha256: 'old' })
  })

  it('a 409 is a StaleError, so the caller keeps the draft', async () => {
    stub(409, { error: 'stale_base' })
    await expect(configApi.savePolicy('{}', 'old')).rejects.toBeInstanceOf(StaleError)
  })

  it('retire repeats the label', async () => {
    const sent = stub(200, { id: 'slot_a', state: 'retired' })
    await configApi.retireSlot('slot_a', 'a')
    expect(sent[0]).toMatchObject({ path: '/api/slots/slot_a/retire', body: { label: 'a' } })
  })
})

describe('a refusal keeps the words the server gave', () => {
  const refusal = async (body: unknown): Promise<HttpError> => {
    stub(400, body)
    const failure = await configApi.savePolicy('{}', 'old').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HttpError)
    return failure as HttpError
  }

  it('carries detail beside the error', async () => {
    const failure = await refusal({ error: 'invalid_policy', detail: 'line 1: bad' })
    expect(failure.reason).toBe('invalid_policy')
    expect(failure.detail).toBe('line 1: bad')
  })

  it('leaves detail unset when there is none to show', async () => {
    expect((await refusal({ error: 'invalid_policy' })).detail).toBeUndefined()
    expect((await refusal({ error: 'invalid_policy', detail: '' })).detail).toBeUndefined()
    expect((await refusal({ error: 'invalid_policy', detail: 7 })).detail).toBeUndefined()
  })
})

describe('decoders refuse what does not fit', () => {
  it('readiness with an unknown status', () => {
    expect(() =>
      decodeReadiness({
        steps: [{ id: 'engines', title: 't', status: 'finished', detail: '', next: null }],
        engines: [],
        metaCandidates: [],
        metaSlotId: null,
        finish: { enabled: false },
        completion: null,
      }),
    ).toThrow(/status/)
  })

  it('a connection row with a usage reading is kept as no reading only when null', () => {
    const body = {
      rows: [
        {
          id: 's',
          label: 'a',
          engine: 'claude',
          kind: 'claude-sub',
          provider: 'anthropic',
          state: 'healthy',
          linked: false,
          credential: 'sign_in',
          usage: null,
          pin: null,
          pair: null,
        },
      ],
      options: [],
    }
    expect(decodeConnections(body).rows[0]?.usage).toBeNull()
    expect(() => decodeConnections({ rows: 'none', options: [] })).toThrow()
  })

  it('a default history no longer holds stays absent, never an empty string', () => {
    const changes = decodeChanges({
      changes: [{ path: 'a.md', oldDefault: undefined, newDefault: { text: 'new', hash: 'h' } }],
    })
    expect(changes).toEqual([{ path: 'a.md', newDefault: 'new' }])
    expect(() => decodeChanges({ changes: 'none' })).toThrow()
  })

  it('capabilities missing from an older server read as all off', () => {
    expect(decodeCapabilities({ runtime: {} })).toEqual({
      switchWork: false,
      drain: false,
      backups: false,
      isolationEdit: false,
      pause: false,
    })
    expect(decodeCapabilities({ capabilities: { backups: true, pause: 'yes' } })).toMatchObject({
      backups: true,
      pause: false,
    })
  })
})
