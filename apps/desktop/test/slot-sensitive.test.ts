import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ConfigServer,
  makeConfigServer,
  SYNTHETIC_KEY,
  SYNTHETIC_KEY_2,
  seedSlot,
} from './config-server'

/** §5.7, §13: the controls that cannot be undone. Synthetic keys, a scratch keystore root. */

const servers: ConfigServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

const LABEL = 'api-1'
const SLOT_ID = `slot_${LABEL}`

async function withKey(): Promise<ConfigServer & { keyFile: string }> {
  const ctx = makeConfigServer()
  servers.push(ctx)
  const res = await ctx.post('/api/slots/api-key', {
    label: LABEL,
    provider: 'anthropic-api',
    key: SYNTHETIC_KEY,
  })
  expect(res.statusCode).toBe(200)
  const keyFile = join(ctx.keystoreRoot, 'engines', 'claude', LABEL, 'keys', 'anthropic-api.key')
  expect(existsSync(keyFile)).toBe(true)
  return Object.assign(ctx, { keyFile })
}

describe('POST /api/slots/:id/retire', () => {
  it('retire without the label shreds nothing', async () => {
    const ctx = await withKey()
    for (const body of [undefined, {}, { label: 'api-2' }, { label: ' api-1 ' }]) {
      const res = await ctx.post(`/api/slots/${SLOT_ID}/retire`, body)
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toBe('label_mismatch')
    }
    expect(existsSync(ctx.keyFile)).toBe(true)
    expect(ctx.store.slots.get(SLOT_ID)?.state).not.toBe('retired')
    expect(ctx.store.events.read(`slot:${LABEL}`).map((event) => event.type)).not.toContain('slot_retired')
  })

  it('retire with the label shreds and retires', async () => {
    const ctx = await withKey()
    const res = await ctx.post(`/api/slots/${SLOT_ID}/retire`, { label: LABEL })
    expect(res.statusCode).toBe(200)
    expect(existsSync(ctx.keyFile)).toBe(false)
    expect(ctx.store.slots.get(SLOT_ID)?.state).toBe('retired')
    expect(ctx.store.events.read(`slot:${LABEL}`).map((event) => event.type)).toContain('slot_retired')
  })
})

describe('GET /api/slots/:id/impact', () => {
  it('counts running and queued work on that slot and says when it runs the meta agent', async () => {
    const ctx = await withKey()
    const at = '2026-11-05T10:00:00.000Z'
    const attempt = (id: string, state: string, slotId: string) =>
      ctx.store.attempts.save({
        id,
        workItemId: 'wi_1',
        taskId: 't',
        slotId,
        state,
        createdAt: at,
        updatedAt: at,
      })
    attempt('a1', 'running', SLOT_ID)
    attempt('a2', 'queued', SLOT_ID)
    attempt('a3', 'queued', SLOT_ID)
    attempt('a4', 'done', SLOT_ID)
    attempt('a5', 'running', 'slot_other')
    ctx.store.engines.save({ id: 'settings/meta-slot', slotId: SLOT_ID, updatedAt: at })

    const res = await ctx.get(`/api/slots/${SLOT_ID}/impact`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      slotId: SLOT_ID,
      label: LABEL,
      running: 1,
      queued: 2,
      metaSlot: true,
      keyStored: true,
    })
  })

  it('answers 404 for an unknown slot', async () => {
    const ctx = await withKey()
    expect((await ctx.get('/api/slots/slot_none/impact')).statusCode).toBe(404)
  })
})

describe('POST /api/slots/:id/key', () => {
  it('replace rotates in place and re-probes', async () => {
    const ctx = await withKey()
    const before = ctx.store.slots.get(SLOT_ID) as { fingerprint: { hash: string } }
    const res = await ctx.post(`/api/slots/${SLOT_ID}/key`, { key: SYNTHETIC_KEY_2 })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(ctx.keyFile, 'utf8')).toBe(SYNTHETIC_KEY_2)
    expect(ctx.fetches).toHaveLength(1)
    const doc = ctx.store.slots.get(SLOT_ID) as {
      state: string
      fingerprint: { last4: string; hash: string }
    }
    expect(doc.state).toBe('healthy')
    expect(doc.fingerprint.last4).toBe('wxyz')
    expect(doc.fingerprint.hash).not.toBe(before.fingerprint.hash)
    expect(ctx.store.events.read(`slot:${LABEL}`).map((event) => event.type)).toContain('slot_key_rotated')
  })

  it('replace never returns the key', async () => {
    const ctx = await withKey()
    const res = await ctx.post(`/api/slots/${SLOT_ID}/key`, { key: SYNTHETIC_KEY_2 })
    expect(res.json()).toEqual({
      id: SLOT_ID,
      fingerprint: { provider: 'anthropic-api', last4: 'wxyz' },
      probe: { ok: true },
    })
    expect(res.body).not.toContain(SYNTHETIC_KEY_2)
    expect(JSON.stringify(ctx.store.events.read(`slot:${LABEL}`))).not.toContain(SYNTHETIC_KEY_2)
    expect(JSON.stringify(ctx.store.slots.get(SLOT_ID))).not.toContain(SYNTHETIC_KEY_2)
  })

  it('a rejected replacement says so and leaves the slot degraded', async () => {
    const ctx = await withKey()
    ctx.setRespond(() => new Response('{}', { status: 401 }))
    const res = await ctx.post(`/api/slots/${SLOT_ID}/key`, { key: SYNTHETIC_KEY_2 })
    expect(res.json()).toMatchObject({ probe: { ok: false, reason: 'key_rejected' } })
    expect(ctx.store.slots.get(SLOT_ID)).toMatchObject({ state: 'degraded', state_reason: 'key_rejected' })
  })

  it('a wrong-shape key changes nothing', async () => {
    const ctx = await withKey()
    const docBefore = JSON.stringify(ctx.store.slots.get(SLOT_ID))
    const res = await ctx.post(`/api/slots/${SLOT_ID}/key`, { key: 'not-a-key' })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('not-a-key')
    expect(readFileSync(ctx.keyFile, 'utf8')).toBe(SYNTHETIC_KEY)
    expect(JSON.stringify(ctx.store.slots.get(SLOT_ID))).toBe(docBefore)
    expect(ctx.fetches).toHaveLength(0)
  })

  it('refuses a retired slot and a slot that holds no key', async () => {
    const ctx = await withKey()
    const signedIn = seedSlot(ctx.store, { label: 'max-1' })
    expect((await ctx.post(`/api/slots/${signedIn}/key`, { key: SYNTHETIC_KEY_2 })).statusCode).toBe(400)
    await ctx.post(`/api/slots/${SLOT_ID}/retire`, { label: LABEL })
    expect((await ctx.post(`/api/slots/${SLOT_ID}/key`, { key: SYNTHETIC_KEY_2 })).statusCode).toBe(409)
    expect(existsSync(ctx.keyFile)).toBe(false)
  })
})
