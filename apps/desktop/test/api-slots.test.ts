import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard } from '@mec/contracts'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, type ServerDeps } from '../src/server'

const AT = '2026-11-03T12:00:00.000Z'

/** A deliberately fake key that passes the contracts' anthropic pattern (SECRET_PATTERNS[0]). */
const KEY = 'sk-ant-api03-mec-test-fixture-000000000000abcd'
const LABEL = 'max-1'
const SLOT_ID = 'slot_max-1'
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'

type FetchCall = { url: string; method: string; headers: Record<string, string> }

type TestServer = {
  store: SqliteStore
  app: ReturnType<typeof buildServer>
  db: Database.Database
  dir: string
  enginesRoot: string
  calls: FetchCall[]
  /** Points the stubbed validate fetch at a new response (or a thrown network error). */
  setRespond: (respond: () => Response) => void
}

const servers: TestServer[] = []
afterEach(async () => {
  while (servers.length > 0) {
    const ctx = servers.pop()
    if (ctx === undefined) break
    await ctx.app.close()
    ctx.db.close()
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

/**
 * The §5.7 makeServer pattern: buildServer over a REAL SqliteStore in a tmpdir (so custody
 * can be asserted against the persisted docs/events json, not just memory), a tmpdir
 * keystoreRoot, and an injectable validateFetch stub that records what the probe sent.
 */
function makeServer(): TestServer {
  const dir = mkdtempSync(join(tmpdir(), `mec-api-slots-${randomBytes(4).toString('hex')}-`))
  const db = new Database(join(dir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  const health: HealthBoard = {
    claim: () => ({ starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }),
  }
  const calls: FetchCall[] = []
  let respond: () => Response = () => new Response('{"data":[]}', { status: 200 })
  const validateFetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
    })
    return respond()
  }
  const enginesRoot = join(dir, 'engines-root')
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    keystoreRoot: enginesRoot,
    validateFetch,
  }
  const ctx: TestServer = {
    store,
    app: buildServer(deps),
    db,
    dir,
    enginesRoot,
    calls,
    setRespond: (fn) => {
      respond = fn
    },
  }
  servers.push(ctx)
  return ctx
}

function keyFileOf(ctx: TestServer, label = LABEL): string {
  return join(ctx.enginesRoot, 'engines', 'claude', label, 'keys', 'anthropic-api.key')
}

async function addKey(
  app: ReturnType<typeof buildServer>,
  label = LABEL,
  key: string = KEY,
): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/slots/api-key',
    payload: { label, provider: 'anthropic-api', key },
  })
  return { statusCode: res.statusCode, body: res.body, json: () => res.json() }
}

/** Every persisted doc, concatenated — what a leak into the store would show up in. */
function allDocsJson(ctx: TestServer): string {
  const rows = ctx.db.prepare('SELECT json FROM docs').all() as Array<{ json: string }>
  return rows.map((row) => row.json).join('\n')
}

/** Every persisted event body, concatenated. */
function allEventsJson(ctx: TestServer): string {
  const rows = ctx.db.prepare('SELECT body FROM events').all() as Array<{ body: string | null }>
  return rows.map((row) => row.body ?? '').join('\n')
}

describe('slots api-key routes (§5.4/§5.7/§5.8)', () => {
  it('couriers a pasted key into the slot keystore and NOWHERE else', async () => {
    const ctx = makeServer()
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/slots/api-key',
      payload: { label: LABEL, provider: 'anthropic-api', key: KEY },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      id: SLOT_ID,
      fingerprint: { provider: 'anthropic-api', last4: 'abcd' },
    })
    expect(res.body).not.toContain(KEY)

    const doc = ctx.store.slots.get(SLOT_ID)
    expect(doc).toMatchObject({
      id: SLOT_ID,
      label: LABEL,
      engine: 'claude',
      kind: 'claude-api',
      provider: 'anthropic-api',
      state: 'login_pending',
    })
    const fingerprint = (doc as { fingerprint?: { last4: string; hash: string } }).fingerprint
    expect(fingerprint?.last4).toBe('abcd')
    expect(fingerprint?.hash).toMatch(/^[0-9a-f]{64}$/)

    // §5.4: the key lives at <root>/engines/claude/<slot>/keys/<provider>.key, 0600 — and only there.
    const file = keyFileOf(ctx)
    expect(readFileSync(file, 'utf8')).toBe(KEY)
    expect(statSync(file).mode & 0o777).toBe(0o600)

    // Custody: the key string appears in NO store doc and NO event body.
    expect(allDocsJson(ctx)).not.toContain(KEY)
    expect(allEventsJson(ctx)).not.toContain(KEY)
  })

  it('rejects a non-anthropic key (and an escaping label) with 400, writing nothing', async () => {
    const ctx = makeServer()
    const bad = await addKey(ctx.app, 'bad-1', 'not-an-anthropic-key-at-all')
    expect(bad.statusCode).toBe(400)
    expect(bad.body).not.toContain('not-an-anthropic-key-at-all')

    const escaping = await addKey(ctx.app, '../escape', KEY)
    expect(escaping.statusCode).toBe(400)

    expect(ctx.store.slots.list()).toHaveLength(0)
    expect(existsSync(join(ctx.enginesRoot, 'engines'))).toBe(false)
  })

  it('validate: a 200 from /v1/models marks the slot healthy and sent the file’s key as x-api-key', async () => {
    const ctx = makeServer()
    ctx.setRespond(() => new Response('{"data":[]}', { status: 200 }))
    await addKey(ctx.app)
    const file = keyFileOf(ctx)

    const res = await ctx.app.inject({ method: 'POST', url: `/api/slots/${SLOT_ID}/validate` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(ctx.store.slots.get(SLOT_ID)?.state).toBe('healthy')
    expect(res.body).not.toContain(KEY)

    expect(ctx.calls).toHaveLength(1)
    expect(ctx.calls[0]).toMatchObject({ url: ANTHROPIC_MODELS_URL, method: 'GET' })
    // The header equals the bytes still on disk — read straight from the keystore file.
    expect(ctx.calls[0]?.headers['x-api-key']).toBe(readFileSync(file, 'utf8'))
    expect(ctx.calls[0]?.headers['x-api-key']).toBe(KEY)
  })

  it('validate: a 401 degrades the slot to key_rejected', async () => {
    const ctx = makeServer()
    ctx.setRespond(() => new Response('{"error":{"type":"authentication_error"}}', { status: 401 }))
    await addKey(ctx.app)

    const res = await ctx.app.inject({ method: 'POST', url: `/api/slots/${SLOT_ID}/validate` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, reason: 'key_rejected' })

    const doc = ctx.store.slots.get(SLOT_ID) as { state?: string; state_reason?: string }
    expect(doc.state).toBe('degraded')
    expect(doc.state_reason).toBe('key_rejected')
    expect(allEventsJson(ctx)).not.toContain(KEY)
  })

  it('validate: a network failure reports provider_unreachable and changes no state', async () => {
    const ctx = makeServer()
    ctx.setRespond(() => {
      throw new Error('dns is down')
    })
    await addKey(ctx.app)

    const res = await ctx.app.inject({ method: 'POST', url: `/api/slots/${SLOT_ID}/validate` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, reason: 'provider_unreachable' })
    expect(ctx.store.slots.get(SLOT_ID)?.state).toBe('login_pending')
  })

  it('retire shreds the key file and retires the slot doc', async () => {
    const ctx = makeServer()
    await addKey(ctx.app)
    const file = keyFileOf(ctx)
    expect(existsSync(file)).toBe(true)

    const res = await ctx.app.inject({ method: 'POST', url: `/api/slots/${SLOT_ID}/retire` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: SLOT_ID, state: 'retired' })

    expect(existsSync(file)).toBe(false)
    expect(ctx.store.slots.get(SLOT_ID)?.state).toBe('retired')
  })

  it('GET /api/slots lists slot docs as fingerprints only', async () => {
    const ctx = makeServer()
    await addKey(ctx.app, 'alpha-1')
    await addKey(ctx.app, 'beta-1')

    const res = await ctx.app.inject({ method: 'GET', url: '/api/slots' })
    expect(res.statusCode).toBe(200)
    const list = res.json() as Array<{
      id: string
      label: string
      state: string
      fingerprint?: { provider: string; last4: string }
    }>
    expect(list.map((slot) => slot.id)).toEqual(['slot_alpha-1', 'slot_beta-1'])
    expect(list[0]?.fingerprint).toEqual({ provider: 'anthropic-api', last4: 'abcd' })
    expect(res.body).not.toContain(KEY)
  })

  it('validate and retire answer 404 for an unknown slot; a duplicate add is 409', async () => {
    const ctx = makeServer()
    const missingValidate = await ctx.app.inject({
      method: 'POST',
      url: '/api/slots/slot_unknown/validate',
    })
    expect(missingValidate.statusCode).toBe(404)
    const missingRetire = await ctx.app.inject({
      method: 'POST',
      url: '/api/slots/slot_unknown/retire',
    })
    expect(missingRetire.statusCode).toBe(404)

    await addKey(ctx.app)
    const duplicate = await addKey(ctx.app)
    expect(duplicate.statusCode).toBe(409)
    // The refused re-add did not disturb the stored key.
    expect(readFileSync(keyFileOf(ctx), 'utf8')).toBe(KEY)
  })
})
