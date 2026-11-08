import type { HealthBoard, HealthClaim, HealthName, Store } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, type ServerDeps } from '../src/server'
import { ownerApproval, ownerHeaders } from './approval-rig'

/**
 * §22 "rejects non-local origins and requires a custom request header (v1's CSRF
 * discipline)" — the two legs of the browser-surface hook — plus the §26
 * secrets-in-chat guard at the route level (issue #8: it lived only in the module).
 *
 * The division the hook implements: browsers always carry Origin/Sec-Fetch-*; local
 * non-browser clients (the CLI, tests, the engine MCP client on /mcp with its token)
 * carry neither and authenticate through their own seams.
 */

/** A HealthBoard double shaped like HealthBoardImpl: one mutable entry per claim, readable back. */
class FakeHealthBoard implements HealthBoard {
  readonly entries = new Map<
    HealthName,
    { state: 'starting' | 'ready' | 'paused' | 'error'; detail?: string }
  >()

  claim(name: HealthName): HealthClaim {
    const entry: { state: 'starting' | 'ready' | 'paused' | 'error'; detail?: string } = { state: 'starting' }
    this.entries.set(name, entry)
    return {
      starting: () => {
        entry.state = 'starting'
        entry.detail = undefined
      },
      ready: (detail?: string) => {
        entry.state = 'ready'
        entry.detail = detail
      },
      paused: () => {
        entry.state = 'paused'
      },
      error: (detail: string) => {
        entry.state = 'error'
        entry.detail = detail
      },
    }
  }

  names(): HealthName[] {
    return [...this.entries.keys()]
  }

  entry(name: HealthName): { state: string; detail?: string } | undefined {
    const entry = this.entries.get(name)
    return entry === undefined ? undefined : { ...entry }
  }
}

function makeServer(): { store: Store; app: ReturnType<typeof buildServer> } {
  const store: Store = new MemoryRepositories()
  const health = new FakeHealthBoard()
  health.claim('effects:launch').ready()
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date('2026-11-03T12:00:00Z'),
    approval: ownerApproval(),
  }
  return { store, app: buildServer(deps) }
}

const servers: ReturnType<typeof buildServer>[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

function track(server: ReturnType<typeof buildServer>): ReturnType<typeof buildServer> {
  servers.push(server)
  return server
}

async function registerRepo(app: ReturnType<typeof buildServer>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    payload: { urlOrPath: 'https://example.test/a', trusted: true, bootstrapCmds: [], checkCmds: [] },
  })
  return (res.json() as { id: string }).id
}

describe('§22 leg 1: non-local origins are rejected before any route runs', () => {
  it('a mutation from https://evil.com is 403 and nothing is stored', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'hello from a web page' },
      headers: { ...ownerHeaders, origin: 'https://evil.com' },
    })
    expect(res.statusCode).toBe(403)
    const listed = await app.inject({ method: 'GET', url: '/api/chat/messages' })
    expect(listed.json() as { text: string }[]).toHaveLength(0)
  })

  it('a read from https://evil.com is 403 too (CORS response blocking is not execution blocking)', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({
      method: 'GET',
      url: '/api/status',
      headers: { origin: 'https://evil.com' },
    })
    expect(res.statusCode).toBe(403)
  })

  it("an opaque 'null' origin is rejected with the remote ones", async () => {
    const { app } = makeServer()
    const res = await track(app).inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'sandboxed frame' },
      headers: { ...ownerHeaders, origin: 'null' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('a loopback origin (the workbench, or its dev proxy) is allowed on reads — EventSource parity', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({
      method: 'GET',
      url: '/api/status',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('§22 leg 2: browser-shaped mutations need the custom client header', () => {
  it('a loopback-origin POST without the header is 403 (another local page cannot post as the user)', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'hello' },
      headers: { ...ownerHeaders, origin: 'http://localhost:5173' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('the same POST with x-mec-client is accepted (the workbench request() wrapper)', async () => {
    const { app } = makeServer()
    const repoId = await registerRepo(track(app))
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'hello', repoId },
      headers: { ...ownerHeaders, origin: 'http://localhost:5173', 'x-mec-client': '1' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { messageId: string }).messageId).toMatch(/^msg_/)
  })

  it('a cross-site fetch that omits Origin but carries Sec-Fetch-Site is still fenced', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'hello' },
      headers: { ...ownerHeaders, 'sec-fetch-site': 'cross-site' },
    })
    expect(res.statusCode).toBe(403)
  })

  it("a local non-browser client posts only with the key: a chat message is the owner's word", async () => {
    // Owner ruling, 8 November 2026. Being on loopback is no authority: a repository's check is too.
    const { app } = makeServer()
    const repoId = await registerRepo(track(app))
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        payload: { text: 'hello from the CLI', repoId },
        headers,
      })
    expect((await post({})).statusCode).toBe(403)
    expect((await post(ownerHeaders)).statusCode).toBe(200)
  })
})

describe('§26 secrets-in-chat at the route level (issue #8)', () => {
  it('a key-shaped message is stored redacted, answered with the Slots pointer, and the raw key never persists', async () => {
    const { app } = makeServer()
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
    const res = await track(app).inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: ownerHeaders,
      payload: { text: `here is my key ${key} please use it` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { secretGuard: boolean; message: string }
    expect(body.secretGuard).toBe(true)
    expect(body.message).toContain('Slots')

    const listed = await app.inject({ method: 'GET', url: '/api/chat/messages' })
    const messages = JSON.stringify(listed.json())
    expect(messages).not.toContain(key)
    const stored = (listed.json() as { text: string; secretGuard?: boolean }[]).at(-1)
    expect(stored?.secretGuard).toBe(true)
  })
})
