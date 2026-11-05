import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../src/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(respond: () => { status?: number; body: unknown }): void {
  globalThis.fetch = (async () => {
    const { status = 200, body } = respond()
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

describe('reads the server does not serve (M1.1)', () => {
  it('a 404 read never returns demo data', async () => {
    stubFetch(() => ({ status: 404, body: { error: 'not found' } }))
    await expect(api.prompts()).rejects.toThrow()
    await expect(api.models()).rejects.toThrow()
    await expect(api.questions()).rejects.toThrow()
    await expect(api.backups()).rejects.toThrow()
  })

  it('malformed payload rejects', async () => {
    stubFetch(() => ({ body: { parts: 'nope' } }))
    await expect(api.prompts()).rejects.toThrow()
    stubFetch(() => ({ body: [{ id: 'q', options: [1] }] }))
    await expect(api.questions()).rejects.toThrow()
    stubFetch(() => ({ body: { table: {} } }))
    await expect(api.models()).rejects.toThrow()
  })
})
