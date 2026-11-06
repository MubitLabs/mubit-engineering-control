import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startServer } from '../src/composition'
import { type ConfigServer, makeConfigServer } from './config-server'

/** §13, §18: the policy is edited here and validated here; agents can only propose. */

const servers: ConfigServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  vi.unstubAllEnvs()
})

function server(): ConfigServer {
  const ctx = makeConfigServer()
  servers.push(ctx)
  return ctx
}

type Policy = {
  text: string
  sha256: string
  revision: number
  source: string
  activeSha256: string
  restartRequired: boolean
}
const read = async (ctx: ConfigServer): Promise<Policy> => (await ctx.get('/api/policy')).json() as Policy
const TIGHT = '{"preAuthorised":{"install":[{"scope":"repo","repoId":"repo_a"}]}}'

function draft(ctx: ConfigServer, id: string, target: string, patch: Record<string, unknown>): void {
  ctx.store.engines.save({
    id: `draft/${id}`,
    draftId: id,
    target,
    patch: patch as never,
    reason: 'proposed',
    diff: 'proposed',
    status: 'pending',
    conversationId: 'setup',
    createdAt: '2026-11-05T10:00:00.000Z',
  })
}

describe('GET and PUT /api/policy', () => {
  it('reads the default before anything is saved', async () => {
    const body = await read(server())
    expect(body).toMatchObject({ source: 'default', revision: 0, restartRequired: false })
    expect(body.sha256).toBe(body.activeSha256)
  })

  it('an always-confirm class cannot be pre-authorised', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    for (const cls of ['push', 'pr_create', 'pr_merge']) {
      const res = await ctx.put('/api/policy', {
        text: `{"preAuthorised":{"${cls}":[{"scope":"repo","repoId":"repo_a"}]}}`,
        base_sha256: sha256,
      })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toBe('invalid_policy')
    }
    expect((await read(ctx)).source).toBe('default')
  })

  it('stale base is refused and nothing is written', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    expect((await ctx.put('/api/policy', { text: TIGHT, base_sha256: sha256 })).statusCode).toBe(200)
    const eventsBefore = ctx.store.events.read('policy').length
    const stale = await ctx.put('/api/policy', { text: '{"preAuthorised":{}}', base_sha256: sha256 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'stale_base' })
    expect((await read(ctx)).text).toBe(TIGHT)
    expect(ctx.store.events.read('policy')).toHaveLength(eventsBefore)
  })

  it('a missing base is refused: this route never skips the stale check', async () => {
    const ctx = server()
    expect((await ctx.put('/api/policy', { text: TIGHT })).statusCode).toBe(400)
    expect((await read(ctx)).source).toBe('default')
  })

  it('the version hash changes with the text', async () => {
    const ctx = server()
    const before = await read(ctx)
    const saved = await ctx.put('/api/policy', { text: TIGHT, base_sha256: before.sha256 })
    const after = await read(ctx)
    expect(saved.json()).toMatchObject({ sha256: after.sha256, revision: 1 })
    expect(after.sha256).not.toBe(before.sha256)
    expect(after).toMatchObject({ source: 'saved', revision: 1 })
    const event = ctx.store.events.read('policy').at(-1)
    expect(event).toMatchObject({ type: 'policy_updated' })
    expect(JSON.stringify(event)).toContain(after.sha256)
  })

  it('says the saved text is not in force until a restart', async () => {
    const ctx = server()
    const { sha256, activeSha256 } = await read(ctx)
    await ctx.put('/api/policy', { text: TIGHT, base_sha256: sha256 })
    const after = await read(ctx)
    expect(after.restartRequired).toBe(true)
    expect(after.activeSha256).toBe(activeSha256)
  })

  it('refuses a key-shaped string instead of storing it', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    const text = '{"preAuthorised":{},"note":"sk-ant-api03-mec-test-fixture-000000000000abcd"}'
    const res = await ctx.put('/api/policy', { text, base_sha256: sha256 })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('sk-ant-api03')
    expect((await read(ctx)).source).toBe('default')
  })
})

describe('a saved policy at boot', () => {
  it('a saved policy survives restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mec-policy-boot-'))
    vi.stubEnv('MEC_FAKE_ENGINE', '1')
    const call = async (url: string, path: string, init?: RequestInit) =>
      (await fetch(`${url}${path}`, init)).json() as Promise<Record<string, unknown>>
    try {
      const first = await startServer({ dataDir })
      const before = await call(first.url, '/api/policy')
      await call(first.url, '/api/policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: TIGHT, base_sha256: before.sha256 }),
      })
      await first.close()

      const second = await startServer({ dataDir })
      const after = await call(second.url, '/api/policy')
      await second.close()
      expect(after).toMatchObject({ text: TIGHT, source: 'saved', restartRequired: false })
      expect(after.activeSha256).toBe(after.sha256)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

type Preview = { base: string | number; changes: Array<{ label: string; before: string; after: string }> }
const previewOf = async (ctx: ConfigServer, id: string): Promise<Preview | undefined> => {
  const drafts = (await ctx.get('/api/setup/drafts')).json() as Array<{ id: string; preview?: Preview }>
  return drafts.find((entry) => entry.id === id)?.preview
}

describe('GET /api/setup/drafts compares each proposal with what it replaces', () => {
  it('a policy proposal shows the entry its key replaces, and Apply saves exactly that', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    await ctx.put('/api/policy', { text: TIGHT, base_sha256: sha256 })
    const saved = await read(ctx)
    draft(ctx, 'p1', 'policy', { preAuthorised: { install: [{ scope: 'repo', repoId: 'repo_prop' }] } })

    const preview = await previewOf(ctx, 'p1')
    expect(preview?.base).toBe(saved.sha256)
    expect(preview?.changes).toHaveLength(1)
    const change = preview?.changes[0]
    expect(change?.before).toContain('repo_a')
    expect(change?.after).toContain('repo_prop')
    expect(change?.after).not.toContain('repo_a')

    expect((await ctx.post('/api/setup/drafts/p1/apply', { base: preview?.base })).statusCode).toBe(200)
    expect(JSON.parse((await read(ctx)).text)).toEqual(JSON.parse(change?.after ?? ''))
  })

  it('a policy comparison shows only what changes, whatever the saved spacing', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    await ctx.put('/api/policy', {
      text: '{"capsOverride":{"usd":5},"preAuthorised":{"install":[{"scope":"repo","repoId":"repo_a"}]}}',
      base_sha256: sha256,
    })
    draft(ctx, 'p2', 'policy', { preAuthorised: {} })
    const change = (await previewOf(ctx, 'p2'))?.changes[0]
    expect(change?.before.split('\n')).toContain('  "capsOverride": {')
    expect(change?.after.split('\n')).toContain('  "capsOverride": {')
  })

  it('a whole policy text is compared as proposed, even one that will not load', async () => {
    const ctx = server()
    draft(ctx, 'p3', 'policy', { text: 'not json' })
    expect((await previewOf(ctx, 'p3'))?.changes[0]?.after).toBe('not json')
  })

  it('a models proposal compares the table with the one Apply saves', async () => {
    const ctx = server()
    const { yaml, sha256 } = (await ctx.get('/api/models/text')).json() as { yaml: string; sha256: string }
    draft(ctx, 'p4', 'models', { yaml: `${yaml}\n# proposed\n` })
    expect(await previewOf(ctx, 'p4')).toEqual({
      base: sha256,
      changes: [{ label: 'Capability table', before: yaml, after: `${yaml}\n# proposed\n` }],
    })
  })

  it('a prompts proposal compares each part with its current text, edited or default', async () => {
    const ctx = server()
    const { parts } = (await ctx.get('/api/prompts/defaults')).json() as {
      parts: Array<{ path: string; text: string }>
    }
    const [first, second] = parts
    const edited = first?.path ?? ''
    await ctx.put('/api/prompts', { base_revision: 0, parts: [{ path: edited, text: 'my edit' }] })
    draft(ctx, 'p5', 'prompts', {
      parts: [
        { path: edited, text: 'proposed one' },
        { path: second?.path, text: 'proposed two' },
      ],
    })
    expect(await previewOf(ctx, 'p5')).toEqual({
      base: 1,
      changes: [
        { label: edited, before: 'my edit', after: 'proposed one' },
        { label: second?.path, before: second?.text, after: 'proposed two' },
      ],
    })

    draft(ctx, 'p6', 'prompts', { path: edited, text: 'proposed three' })
    expect((await previewOf(ctx, 'p6'))?.changes).toEqual([
      { label: edited, before: 'my edit', after: 'proposed three' },
    ])
  })

  it('a stale comparison cannot apply: its base is refused once the text moves', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    draft(ctx, 'p7', 'policy', { preAuthorised: {} })
    const preview = await previewOf(ctx, 'p7')
    await ctx.put('/api/policy', { text: TIGHT, base_sha256: sha256 })
    expect((await ctx.post('/api/setup/drafts/p7/apply', { base: preview?.base })).statusCode).toBe(409)
    expect(ctx.store.engines.get('draft/p7')?.status).toBe('pending')
  })

  it('a stored text that no longer loads costs the comparison, not the list', async () => {
    const ctx = server()
    ctx.store.engines.save({ id: 'settings/policy', text: 'not json', revision: 1 })
    draft(ctx, 'p13', 'policy', { preAuthorised: {} })
    const res = await ctx.get('/api/setup/drafts')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject([{ id: 'p13', status: 'pending' }])
    expect(await previewOf(ctx, 'p13')).toBeUndefined()
  })

  it('has nothing to compare for a new repository, a settled draft or an empty one', async () => {
    const ctx = server()
    draft(ctx, 'p8', 'repository', { label: 'repo', url_or_path: '/tmp/repo' })
    draft(ctx, 'p9', 'policy', { preAuthorised: {} })
    await ctx.post('/api/setup/drafts/p9/dismiss', {})
    draft(ctx, 'p10', 'policy', {})
    draft(ctx, 'p11', 'models', {})
    draft(ctx, 'p12', 'prompts', { parts: [{ path: 'no text' }] })
    for (const id of ['p8', 'p9', 'p10', 'p11', 'p12']) expect(await previewOf(ctx, id)).toBeUndefined()
  })
})

describe('POST /api/setup/drafts/:id/apply', () => {
  it('an applied draft goes through the same validation', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    draft(ctx, 'd1', 'policy', { preAuthorised: { push: [{ scope: 'repo', repoId: 'repo_a' }] } })
    const res = await ctx.post('/api/setup/drafts/d1/apply', { base: sha256 })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toBe('invalid_policy')
    expect((await read(ctx)).source).toBe('default')
    expect(ctx.store.engines.get('draft/d1')?.status).toBe('pending')
  })

  it('applies a policy draft against the base the owner saw, and only once', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    draft(ctx, 'd2', 'policy', { preAuthorised: { install: [{ scope: 'repo', repoId: 'repo_a' }] } })
    expect((await read(ctx)).source).toBe('default')
    expect((await ctx.post('/api/setup/drafts/d2/apply', { base: sha256 })).statusCode).toBe(200)
    const after = await read(ctx)
    expect(JSON.parse(after.text)).toEqual(JSON.parse(TIGHT))
    expect(ctx.store.engines.get('draft/d2')?.status).toBe('applied')
    expect((await ctx.post('/api/setup/drafts/d2/apply', { base: after.sha256 })).statusCode).toBe(409)
  })

  it('a stale apply is refused and the draft stands', async () => {
    const ctx = server()
    draft(ctx, 'd3', 'policy', { preAuthorised: {} })
    const res = await ctx.post('/api/setup/drafts/d3/apply', { base: 'f'.repeat(64) })
    expect(res.statusCode).toBe(409)
    expect(ctx.store.engines.get('draft/d3')?.status).toBe('pending')
  })

  it('a prompts draft saves a revision through the prompt route, stale base refused', async () => {
    const ctx = server()
    const { parts } = (await ctx.get('/api/prompts/defaults')).json() as { parts: Array<{ path: string }> }
    const path = parts[0]?.path ?? ''
    draft(ctx, 'd4', 'prompts', { path, text: 'a proposed part' })
    expect((await ctx.post('/api/setup/drafts/d4/apply', { base: 7 })).statusCode).toBe(409)
    expect(ctx.store.engines.get('draft/d4')?.status).toBe('pending')
    expect((await ctx.post('/api/setup/drafts/d4/apply', { base: 0 })).statusCode).toBe(200)
    const prompts = (await ctx.get('/api/prompts')).json() as { revision: number; overrides: unknown[] }
    expect(prompts.revision).toBe(1)
    expect(prompts.overrides).toHaveLength(1)
  })

  it('a models draft is validated and stale-checked like a manual save', async () => {
    const ctx = server()
    const { yaml, sha256 } = (await ctx.get('/api/models/text')).json() as { yaml: string; sha256: string }
    draft(ctx, 'd5', 'models', { yaml: 'not: a table' })
    expect((await ctx.post('/api/setup/drafts/d5/apply', { base: sha256 })).statusCode).toBe(400)
    draft(ctx, 'd6', 'models', { yaml: `${yaml}\n# proposed\n` })
    expect((await ctx.post('/api/setup/drafts/d6/apply', { base: 'f'.repeat(64) })).statusCode).toBe(409)
    expect((await ctx.post('/api/setup/drafts/d6/apply', { base: sha256 })).statusCode).toBe(200)
    const after = (await ctx.get('/api/models/text')).json() as { yaml: string; source: string }
    expect(after).toMatchObject({ source: 'user' })
    expect(after.yaml).toContain('# proposed')
  })

  it('a draft that is denied never applies', async () => {
    const ctx = server()
    const { sha256 } = await read(ctx)
    draft(ctx, 'd7', 'policy', { preAuthorised: {} })
    expect((await ctx.post('/api/setup/drafts/d7/dismiss', {})).statusCode).toBe(200)
    expect(ctx.store.engines.get('draft/d7')?.status).toBe('denied')
    expect((await ctx.post('/api/setup/drafts/d7/apply', { base: sha256 })).statusCode).toBe(409)
  })
})
