import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type ConfigServer, makeConfigServer, nothingInstalled, seedSlot } from './config-server'

/** §21.3: readiness is read from saved facts. Moving through the steps changes none of them. */

const servers: ConfigServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

function server(): ConfigServer {
  const ctx = makeConfigServer()
  servers.push(ctx)
  return ctx
}

type Step = { id: string; status: string; detail: string; next: { label: string; route: string } | null }
type Readiness = {
  steps: Step[]
  finish: { enabled: boolean; reason?: string }
  completion: { repository: { id: string; url: string }; metaSlot: { id: string; label: string } } | null
}

const readiness = async (ctx: ConfigServer): Promise<Readiness> =>
  (await ctx.get('/api/setup/readiness')).json() as Readiness
const step = (body: Readiness, id: string): Step => {
  const found = body.steps.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no step ${id}`)
  return found
}

async function addRepository(ctx: ConfigServer, checks: Array<{ name: string; cmd: string }>) {
  const path = join(ctx.dir, 'repo')
  mkdirSync(path, { recursive: true })
  const res = await ctx.post('/api/repositories', {
    urlOrPath: path,
    bootstrapCmds: [],
    checkCmds: checks,
    trusted: false,
  })
  return res.json() as { id: string; url: string }
}

const PROBE_DOC = { id: 'slot_claude_probe', label: 'startup probe', home: undefined }

async function complete(ctx: ConfigServer): Promise<void> {
  const slotId = seedSlot(ctx.store, { label: 'max-1' })
  await addRepository(ctx, [{ name: 'test', cmd: 'pnpm test' }])
  expect((await ctx.post('/api/wizard/meta-slot', { slotId })).statusCode).toBe(200)
}

describe('GET /api/setup/readiness?engines=known', () => {
  /** A probe that answers only when told, so the first read cannot be waiting for it by luck. */
  function heldProbe(ctx: ConfigServer) {
    const release: Array<() => void> = []
    let calls = 0
    ctx.setProbe(
      (cmd) =>
        new Promise((resolve) => {
          calls += 1
          release.push(() => resolve({ code: 0, stdout: `${cmd} 9.9.9\n`, stderr: '' }))
        }),
    )
    return {
      calls: () => calls,
      release: () => {
        for (const go of release.splice(0)) go()
      },
    }
  }
  const known = async (ctx: ConfigServer) =>
    (await ctx.get('/api/setup/readiness?engines=known')).json() as Readiness
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  it('answers the saved facts at once while the engines are still being looked for', async () => {
    const ctx = server()
    const probe = heldProbe(ctx)
    seedSlot(ctx.store, { label: 'max-1' })
    const body = await known(ctx)
    expect(step(body, 'engines').status).toBe('checking')
    expect(step(body, 'engines').detail).toMatch(/checking/i)
    expect(step(body, 'connection').status).toBe('done')
    expect(body.finish.enabled).toBe(false)
    expect(body.finish.reason).toMatch(/still checking/i)
    expect(body.completion).toBeNull()
    expect(probe.calls()).toBe(3)
    probe.release()
  })

  it('one look serves the reads behind it, and its answer takes over', async () => {
    const ctx = server()
    const probe = heldProbe(ctx)
    await known(ctx)
    await known(ctx)
    expect(probe.calls()).toBe(3)
    probe.release()
    await settle()
    const body = await known(ctx)
    expect(step(body, 'engines').status).toBe('done')
    expect(step(body, 'engines').detail).toContain('claude 9.9.9')
    probe.release()
  })

  it('a finished look stays usable while the next one runs, and its answer replaces it', async () => {
    const ctx = server()
    await readiness(ctx)
    ctx.setProbe(nothingInstalled)
    expect(step(await known(ctx), 'engines').status).toBe('done')
    await settle()
    expect(step(await known(ctx), 'engines').status).toBe('missing')
  })

  it('a probe that throws leaves the next look free to run', async () => {
    const ctx = server()
    ctx.setProbe(async () => {
      throw new Error('spawn failed')
    })
    await known(ctx)
    await settle()
    ctx.setProbe(async (cmd) => ({ code: 0, stdout: `${cmd} 1.0.0\n`, stderr: '' }))
    await known(ctx)
    await settle()
    expect(step(await known(ctx), 'engines').status).toBe('done')
  })

  it('the plain read still waits for what the engines say', async () => {
    const ctx = server()
    const probe = heldProbe(ctx)
    const pending = readiness(ctx)
    await settle()
    probe.release()
    expect(step(await pending, 'engines').status).toBe('done')
  })
})

describe('GET /api/setup/readiness', () => {
  it('gives five stages in order, each with a state and the next action', async () => {
    const ctx = server()
    const body = await readiness(ctx)
    expect(body.steps.map((entry) => entry.id)).toEqual([
      'engines',
      'connection',
      'repository',
      'meta_slot',
      'first_request',
    ])
    expect(step(body, 'connection').next).toMatchObject({ route: 'slots' })
  })

  it('navigation alone marks nothing done', async () => {
    const ctx = server()
    ctx.setProbe(nothingInstalled)
    await ctx.get('/api/setup/readiness')
    await ctx.get('/api/wizard/engines')
    const body = await readiness(ctx)
    expect(body.steps.every((entry) => entry.status === 'missing')).toBe(true)
    expect(body.finish.enabled).toBe(false)
    expect(body.finish.reason).toMatch(/engine/i)
    expect(body.completion).toBeNull()
  })

  it('skipped is not done', async () => {
    const ctx = server()
    expect((await ctx.post('/api/setup/skip', { step: 'connection' })).statusCode).toBe(200)
    const body = await readiness(ctx)
    expect(step(body, 'connection').status).toBe('skipped')
    expect(body.finish.enabled).toBe(false)
    expect(body.finish.reason).toMatch(/connection/i)
  })

  it('a saved fact outranks an old skip, and a skip must name a step', async () => {
    const ctx = server()
    await ctx.post('/api/setup/skip', { step: 'connection' })
    seedSlot(ctx.store, { label: 'max-1' })
    expect(step(await readiness(ctx), 'connection').status).toBe('done')
    expect((await ctx.post('/api/setup/skip', { step: 'nonsense' })).statusCode).toBe(400)
  })

  it('a setup-agent repository counts as a repository', async () => {
    const ctx = server()
    const path = join(ctx.dir, 'agent-repo')
    mkdirSync(path, { recursive: true })
    const draftId = 'draft_repo'
    ctx.store.engines.save({
      id: `draft/${draftId}`,
      draftId,
      target: 'repository',
      patch: { label: 'agent', url_or_path: path, checks: ['pnpm test'] },
      reason: 'register it',
      diff: 'target: repository',
      status: 'pending',
      conversationId: 'setup',
      createdAt: '2026-11-05T10:00:00.000Z',
    })
    expect((await ctx.post(`/api/setup/drafts/${draftId}/apply`, {})).statusCode).toBe(200)

    const status = (await ctx.get('/api/status')).json() as { setup: { has_repository: boolean } }
    expect(status.setup.has_repository).toBe(true)
    const repositories = (await ctx.get('/api/repositories')).json() as Array<{
      id: string
      checks: Array<{ name: string; cmd: string }>
    }>
    expect(repositories).toHaveLength(1)
    expect(repositories[0]?.checks).toEqual([{ name: 'check_1', cmd: 'pnpm test' }])
    expect(step(await readiness(ctx), 'repository').status).toBe('done')
    expect(ctx.store.events.read('repositories').map((event) => event.type)).toContain(
      'repository_registered',
    )
  })

  it('a healthy slot with no home is not a connection, and a key slot with one is', async () => {
    const ctx = server()
    seedSlot(ctx.store, PROBE_DOC)
    const probeOnly = step(await readiness(ctx), 'connection')
    expect(probeOnly.status).toBe('missing')
    expect(probeOnly.detail).toBe('No connection yet.')

    seedSlot(ctx.store, { label: 'api', kind: 'claude-api', provider: 'anthropic-api' })
    const withKey = step(await readiness(ctx), 'connection')
    expect(withKey.status).toBe('done')
    expect(withKey.detail).toBe('1 usable connection.')
  })

  it('a chosen slot with no home leaves the step open, with the reason', async () => {
    const ctx = server()
    seedSlot(ctx.store, PROBE_DOC)
    ctx.store.engines.save({ id: 'settings/meta-slot', slotId: PROBE_DOC.id })
    const meta = step(await readiness(ctx), 'meta_slot')
    expect(meta.status).toBe('missing')
    expect(meta.detail).toContain('startup probe has no home')
  })

  it('a repository with no check profile is incomplete', async () => {
    const ctx = server()
    await addRepository(ctx, [])
    const body = await readiness(ctx)
    expect(step(body, 'repository').status).toBe('missing')
    expect(step(body, 'repository').detail).toMatch(/check/i)
    expect(step(body, 'repository').next).toMatchObject({ route: 'settings' })
  })

  it('no usable meta slot blocks finish', async () => {
    const ctx = server()
    await complete(ctx)
    expect((await readiness(ctx)).finish.enabled).toBe(true)

    seedSlot(ctx.store, { label: 'other', engine: 'codex', kind: 'codex-sub' })
    const slot = ctx.store.slots.get('slot_max-1')
    ctx.store.slots.save({ ...slot, id: 'slot_max-1', state: 'degraded', state_reason: 'auth_expired' })
    const body = await readiness(ctx)
    expect(step(body, 'meta_slot').status).toBe('missing')
    expect(body.finish.enabled).toBe(false)
    expect(body.finish.reason).toMatch(/meta/i)
    expect(body.completion).toBeNull()
  })

  it('completion names the repository and the meta slot', async () => {
    const ctx = server()
    await complete(ctx)
    const body = await readiness(ctx)
    expect(body.completion).toMatchObject({ metaSlot: { id: 'slot_max-1', label: 'max-1' } })
    expect(body.completion?.repository.url).toContain('repo')
    expect(step(body, 'first_request').status).toBe('missing')
  })
})
