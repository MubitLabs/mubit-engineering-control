import { afterEach, describe, expect, it } from 'vitest'
import { type ConfigServer, makeConfigServer, seedSlot } from './config-server'

/** §6: the real brain is Claude on a signed-in home, and the server refuses anything else. */

const servers: ConfigServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

function server(): ConfigServer {
  const ctx = makeConfigServer()
  servers.push(ctx)
  return ctx
}

type Candidate = { id: string; usable: boolean; reason?: string }

describe('POST /api/wizard/meta-slot', () => {
  it('a retired slot is refused', async () => {
    const ctx = server()
    const slotId = seedSlot(ctx.store, { label: 'old', state: 'retired' })
    const res = await ctx.post('/api/wizard/meta-slot', { slotId })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/retired/)
    expect(ctx.store.engines.get('settings/meta-slot')).toBeUndefined()
  })

  it('a non-Claude slot is refused', async () => {
    const ctx = server()
    const slotId = seedSlot(ctx.store, { label: 'cx', engine: 'codex', kind: 'codex-sub' })
    const res = await ctx.post('/api/wizard/meta-slot', { slotId })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/runs on Claude only/)
    expect(ctx.store.engines.get('settings/meta-slot')).toBeUndefined()
  })

  it('an unhealthy slot is refused', async () => {
    const ctx = server()
    const slotId = seedSlot(ctx.store, {
      label: 'expired',
      state: 'degraded',
      state_reason: 'auth_expired',
    })
    const res = await ctx.post('/api/wizard/meta-slot', { slotId })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/auth_expired/)
  })

  it('a Claude API-key slot is refused: the brain launches on a signed-in home only', async () => {
    const ctx = server()
    const slotId = seedSlot(ctx.store, { label: 'api', kind: 'claude-api', provider: 'anthropic-api' })
    const res = await ctx.post('/api/wizard/meta-slot', { slotId })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/sign/i)
  })

  it('a healthy Claude subscription slot is accepted', async () => {
    const ctx = server()
    const slotId = seedSlot(ctx.store, { label: 'max-1' })
    expect((await ctx.post('/api/wizard/meta-slot', { slotId })).statusCode).toBe(200)
  })
})

describe('the setup agent', () => {
  it('meets the same refusal through its own tool', async () => {
    const ctx = makeConfigServer({
      setupDecide: async ({ text }) => ({
        calls: [{ tool: 'set_meta_slot', args: { slot_id: text } }],
      }),
    })
    servers.push(ctx)
    const slotId = seedSlot(ctx.store, { label: 'cx', engine: 'codex', kind: 'codex-sub' })
    const res = await ctx.post('/api/chat/messages', { setup: true, text: slotId })
    expect(res.statusCode).toBe(500)
    expect(ctx.store.engines.get('settings/meta-slot')).toBeUndefined()
  })
})

describe('the setup screen reads the same predicate', () => {
  it('lists every live slot with the server’s own verdict', async () => {
    const ctx = server()
    seedSlot(ctx.store, { label: 'max-1' })
    seedSlot(ctx.store, { label: 'cx', engine: 'codex', kind: 'codex-sub' })
    seedSlot(ctx.store, { label: 'old', state: 'retired' })
    const body = (await ctx.get('/api/setup/readiness')).json() as { metaCandidates: Candidate[] }
    expect(body.metaCandidates.find((slot) => slot.id === 'slot_max-1')).toMatchObject({ usable: true })
    expect(body.metaCandidates.find((slot) => slot.id === 'slot_cx')?.usable).toBe(false)
    expect(body.metaCandidates.find((slot) => slot.id === 'slot_old')?.usable).toBe(false)
  })
})
