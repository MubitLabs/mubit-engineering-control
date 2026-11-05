import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProbeCmd, ServerDeps } from '../src/server'
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

async function withKey(extra: Partial<ServerDeps> = {}): Promise<ConfigServer & { keyFile: string }> {
  const ctx = makeConfigServer(extra)
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

/** Holds a check open at a known point, so another request lands inside it. */
function held(): { entered: Promise<void>; pass: () => Promise<void>; release: () => void } {
  let enter = (): void => {}
  let release = (): void => {}
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release: () => release(),
    pass: () => {
      enter()
      return released
    },
  }
}

/** The vendor's status command says signed in, and it waits at the gate first. */
const signedIn =
  (gate: ReturnType<typeof held>): ProbeCmd =>
  async (_cmd, args) => {
    if (args[0] !== 'auth') return { code: 0, stdout: '2.1.317 (Claude Code)\n', stderr: '' }
    await gate.pass()
    return { code: 0, stdout: '{"loggedIn":true,"email":"owner@example.test"}', stderr: '' }
  }

describe('a retire that lands during a check', () => {
  const HOME = 'max-2'
  const HOME_ID = `slot_${HOME}`
  const retired = { error: 'slot is retired' }

  async function signInSlot(gate: ReturnType<typeof held>): Promise<ConfigServer> {
    const ctx = makeConfigServer()
    servers.push(ctx)
    ctx.setProbe(signedIn(gate))
    await ctx.post('/api/slots/dedicated', { engine: 'claude', label: HOME })
    return ctx
  }

  const typesOf = (ctx: ConfigServer, label: string): string[] =>
    ctx.store.events.read(`slot:${label}`).map((event) => event.type)

  it('a local probe that finishes afterwards does not bring the slot back', async () => {
    const gate = held()
    const ctx = await signInSlot(gate)
    const check = Promise.resolve(ctx.post(`/api/slots/${HOME_ID}/probe`))
    await gate.entered

    const retire = await ctx.post(`/api/slots/${HOME_ID}/retire`, { label: HOME })
    expect(retire.statusCode).toBe(200)
    gate.release()

    const res = await check
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual(retired)
    expect(ctx.store.slots.get(HOME_ID)?.state).toBe('retired')
    const rows = (await ctx.get('/api/connections')).json() as { rows: unknown[] }
    expect(rows.rows).toEqual([])
    expect(typesOf(ctx, HOME).at(-1)).toBe('slot_retired')
  })

  it('a local probe keeps what was saved while it ran', async () => {
    const gate = held()
    const ctx = await signInSlot(gate)
    const check = Promise.resolve(ctx.post(`/api/slots/${HOME_ID}/probe`))
    await gate.entered

    const current = ctx.store.slots.get(HOME_ID)
    ctx.store.slots.save({ ...current, id: HOME_ID, label: 'saved-meanwhile' })
    gate.release()

    expect((await check).statusCode).toBe(200)
    expect(ctx.store.slots.get(HOME_ID)).toMatchObject({ state: 'healthy', label: 'saved-meanwhile' })
  })

  it('a local probe answers 409 when the slot is gone', async () => {
    const gate = held()
    const ctx = await signInSlot(gate)
    const check = Promise.resolve(ctx.post(`/api/slots/${HOME_ID}/probe`))
    await gate.entered

    ctx.db.prepare("DELETE FROM docs WHERE kind = 'slot' AND id = ?").run(HOME_ID)
    gate.release()

    const res = await check
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual(retired)
    expect(ctx.store.slots.get(HOME_ID)).toBeUndefined()
  })

  it.each([
    [200, 'healthy'],
    [401, 'key_rejected'],
  ])('a provider answer of %i (%s) does not bring the slot back', async (status) => {
    const gate = held()
    const ctx = await withKey({
      validateFetch: async () => {
        await gate.pass()
        return new Response('{"data":[]}', { status })
      },
    })
    const check = Promise.resolve(ctx.post(`/api/slots/${SLOT_ID}/validate`))
    await gate.entered

    expect((await ctx.post(`/api/slots/${SLOT_ID}/retire`, { label: LABEL })).statusCode).toBe(200)
    gate.release()

    const res = await check
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual(retired)
    expect(ctx.store.slots.get(SLOT_ID)?.state).toBe('retired')
    expect(typesOf(ctx, LABEL).at(-1)).toBe('slot_retired')
  })

  it('a key replacement says the slot was retired, and leaves it retired', async () => {
    const gate = held()
    const ctx = await withKey({
      validateFetch: async () => {
        await gate.pass()
        return new Response('{"data":[]}', { status: 200 })
      },
    })
    const replace = Promise.resolve(ctx.post(`/api/slots/${SLOT_ID}/key`, { key: SYNTHETIC_KEY_2 }))
    await gate.entered

    expect((await ctx.post(`/api/slots/${SLOT_ID}/retire`, { label: LABEL })).statusCode).toBe(200)
    gate.release()

    const res = await replace
    expect(res.statusCode).toBe(200)
    expect((res.json() as { probe: unknown }).probe).toEqual({ ok: false, reason: retired.error })
    expect(ctx.store.slots.get(SLOT_ID)?.state).toBe('retired')
    expect(existsSync(ctx.keyFile)).toBe(false)
    expect(typesOf(ctx, LABEL).at(-1)).toBe('slot_retired')
  })

  it.each([
    [200, 'healthy'],
    [401, 'key_rejected'],
  ])('a provider answer of %i (%s) keeps a key replaced while it ran', async (status) => {
    const gate = held()
    let calls = 0
    const ctx = await withKey({
      validateFetch: async () => {
        calls += 1
        if (calls === 1) await gate.pass()
        return new Response('{"data":[]}', { status })
      },
    })
    const check = Promise.resolve(ctx.post(`/api/slots/${SLOT_ID}/validate`))
    await gate.entered

    expect((await ctx.post(`/api/slots/${SLOT_ID}/key`, { key: SYNTHETIC_KEY_2 })).statusCode).toBe(200)
    gate.release()

    expect((await check).statusCode).toBe(200)
    const fingerprint = ctx.store.slots.get(SLOT_ID)?.fingerprint as { last4: string }
    expect(fingerprint.last4).toBe(SYNTHETIC_KEY_2.slice(-4))
  })
})
