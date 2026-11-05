import { afterEach, describe, expect, it } from 'vitest'
import { type ConfigServer, makeConfigServer, seedSlot } from './config-server'

/** §18.4: one row per slot from saved facts; what is not recorded is said, never invented. */

const servers: ConfigServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

function server(): ConfigServer {
  const ctx = makeConfigServer()
  servers.push(ctx)
  return ctx
}

type Row = Record<string, unknown> & { id: string }
type Connections = {
  rows: Row[]
  options: Array<{ engine: string; paths: string[]; providers: Array<{ id: string }> }>
}

describe('GET /api/connections', () => {
  it('offers only the paths each engine really supports', async () => {
    const body = (await server().get('/api/connections')).json() as Connections
    expect(body.options.find((o) => o.engine === 'claude')?.paths).toEqual(['link', 'sign_in', 'api_key'])
    expect(body.options.find((o) => o.engine === 'codex')?.paths).toEqual(['sign_in'])
    expect(body.options.find((o) => o.engine === 'opencode')?.paths).toEqual(['api_key'])
    expect(body.options.find((o) => o.engine === 'opencode')?.providers.map((p) => p.id)).toEqual([
      'glm-api',
      'gemini-api',
    ])
  })

  it('a row carries saved facts, hides retired slots and invents no reading', async () => {
    const ctx = server()
    seedSlot(ctx.store, {
      label: 'max-1',
      state: 'degraded',
      state_reason: 'auth_expired',
      engine_version: '2.1.317',
      identity: { email: 'owner@example.test', plan: 'max' },
      last_probe_at: '2026-11-05T10:00:00.000Z',
    })
    seedSlot(ctx.store, { label: 'old', state: 'retired' })
    const body = (await ctx.get('/api/connections')).json() as Connections
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({
      id: 'slot_max-1',
      engineVersion: '2.1.317',
      identity: { email: 'owner@example.test', plan: 'max' },
      state: 'degraded',
      stateReason: 'auth_expired',
      lastProbeAt: '2026-11-05T10:00:00.000Z',
      usage: null,
      pin: null,
      pair: null,
    })
  })
})

describe('POST /api/slots/dedicated', () => {
  it('creates the slot a sign-in fills, and refuses an escaping label', async () => {
    const ctx = server()
    const res = await ctx.post('/api/slots/dedicated', { engine: 'claude', label: 'max-2' })
    expect(res.statusCode).toBe(200)
    expect(ctx.store.slots.get('slot_max-2')).toMatchObject({
      engine: 'claude',
      kind: 'claude-sub',
      state: 'home_ready',
    })
    expect((await ctx.post('/api/slots/dedicated', { engine: 'claude', label: '../x' })).statusCode).toBe(400)
    expect((await ctx.post('/api/slots/dedicated', { engine: 'opencode', label: 'o' })).statusCode).toBe(400)
    expect((await ctx.post('/api/slots/dedicated', { engine: 'claude', label: 'max-2' })).statusCode).toBe(
      409,
    )
  })
})

describe('POST /api/slots/:id/probe', () => {
  it('a signed-in Claude home turns healthy and records identity and version', async () => {
    const ctx = server()
    const seen: Array<Record<string, string | undefined> | undefined> = []
    ctx.setProbe(async (_cmd, args, opts) => {
      seen.push(opts?.env)
      return args[0] === 'auth'
        ? {
            code: 0,
            stdout: '{"loggedIn":true,"email":"owner@example.test","subscriptionType":"max"}',
            stderr: '',
          }
        : { code: 0, stdout: '2.1.317 (Claude Code)\n', stderr: '' }
    })
    await ctx.post('/api/slots/dedicated', { engine: 'claude', label: 'max-2' })
    const res = await ctx.post('/api/slots/slot_max-2/probe')
    expect(res.json()).toMatchObject({ ok: true, state: 'healthy' })
    const doc = ctx.store.slots.get('slot_max-2')
    expect(doc).toMatchObject({
      state: 'healthy',
      engine_version: '2.1.317',
      identity: { email: 'owner@example.test', plan: 'max' },
    })
    expect(seen[0]?.CLAUDE_CONFIG_DIR).toBe(doc?.home)
    expect(ctx.store.events.read('slot:max-2').map((event) => event.type)).toContain('slot_healthy')
  })

  it('a linked home keeps CLAUDE_CONFIG_DIR unset', async () => {
    const ctx = server()
    const seen: Array<Record<string, string | undefined> | undefined> = []
    ctx.setProbe(async (_cmd, _args, opts) => {
      seen.push(opts?.env)
      return { code: 0, stdout: '{"loggedIn":true}', stderr: '' }
    })
    await ctx.post('/api/slots/link', { engine: 'claude', label: 'max-0' })
    await ctx.post('/api/slots/slot_max-0/probe')
    expect(seen.length).toBeGreaterThan(0)
    for (const env of seen) expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('a signed-out home degrades with the reason', async () => {
    const ctx = server()
    ctx.setProbe(async () => ({ code: 1, stdout: '{"loggedIn":false}', stderr: '' }))
    await ctx.post('/api/slots/dedicated', { engine: 'claude', label: 'max-2' })
    const res = await ctx.post('/api/slots/slot_max-2/probe')
    expect(res.json()).toMatchObject({ ok: false, state: 'degraded', reason: 'auth_expired' })
    expect(ctx.store.slots.get('slot_max-2')).toMatchObject({ state_reason: 'auth_expired' })
  })

  it('codex reads its own login status, and an API-key slot is refused', async () => {
    const ctx = server()
    const calls: string[] = []
    ctx.setProbe(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`)
      return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' }
    })
    await ctx.post('/api/slots/dedicated', { engine: 'codex', label: 'cx' })
    expect((await ctx.post('/api/slots/slot_cx/probe')).json()).toMatchObject({ ok: true })
    expect(calls).toContain('codex login status')
    seedSlot(ctx.store, { label: 'api', kind: 'claude-api', provider: 'anthropic-api' })
    expect((await ctx.post('/api/slots/slot_api/probe')).statusCode).toBe(400)
  })
})
