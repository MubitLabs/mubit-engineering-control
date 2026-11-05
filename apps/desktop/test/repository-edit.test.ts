import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type ConfigServer, makeConfigServer } from './config-server'

/** §14, #22: a repository is edited here. Work already admitted keeps what it was pinned to. */

const servers: ConfigServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

type Repo = {
  id: string
  url: string
  bootstrap: string[]
  checks: Array<{ name: string; cmd: string }>
  trust: boolean
  revision: string
}

async function withRepository(): Promise<ConfigServer & { repo: Repo }> {
  const ctx = makeConfigServer()
  servers.push(ctx)
  const path = join(ctx.dir, 'repo')
  mkdirSync(path, { recursive: true })
  const res = await ctx.post('/api/repositories', {
    urlOrPath: path,
    bootstrapCmds: ['pnpm install'],
    checkCmds: [{ name: 'test', cmd: 'pnpm test' }],
    trusted: false,
  })
  expect(res.statusCode).toBe(200)
  const { id } = res.json() as { id: string }
  const repo = ((await ctx.get('/api/repositories')).json() as Repo[]).find((row) => row.id === id) as Repo
  return Object.assign(ctx, { repo })
}

const NEW_CHECKS = [{ name: 'lint', cmd: 'pnpm lint' }]

describe('PATCH /api/repositories/:id', () => {
  it('edits bootstrap, checks and trust, and GET shows them', async () => {
    const ctx = await withRepository()
    const res = await ctx.patch(`/api/repositories/${ctx.repo.id}`, {
      base_revision: ctx.repo.revision,
      bootstrapCmds: ['npm ci'],
      checkCmds: NEW_CHECKS,
      trusted: true,
    })
    expect(res.statusCode).toBe(200)
    const [row] = (await ctx.get('/api/repositories')).json() as Repo[]
    expect(row).toMatchObject({ bootstrap: ['npm ci'], checks: NEW_CHECKS, trust: true, url: ctx.repo.url })
  })

  it('stale edit is refused', async () => {
    const ctx = await withRepository()
    const first = await ctx.patch(`/api/repositories/${ctx.repo.id}`, {
      base_revision: ctx.repo.revision,
      checkCmds: NEW_CHECKS,
    })
    expect(first.statusCode).toBe(200)
    const stale = await ctx.patch(`/api/repositories/${ctx.repo.id}`, {
      base_revision: ctx.repo.revision,
      checkCmds: [],
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'stale_base' })
    const [row] = (await ctx.get('/api/repositories')).json() as Repo[]
    expect(row?.checks).toEqual(NEW_CHECKS)
    expect(ctx.store.events.read('repositories').map((event) => event.type)).toEqual([
      'repository_registered',
      'repository_updated',
    ])
  })

  it('shell metacharacters are refused', async () => {
    const ctx = await withRepository()
    for (const body of [
      { bootstrapCmds: ['pnpm install; rm -rf /'] },
      { checkCmds: [{ name: 'test', cmd: 'pnpm test | tee out' }] },
      { checkCmds: [{ name: 'test', cmd: 'echo $HOME' }] },
    ]) {
      const res = await ctx.patch(`/api/repositories/${ctx.repo.id}`, {
        base_revision: ctx.repo.revision,
        ...body,
      })
      expect(res.statusCode).toBe(400)
    }
    const [row] = (await ctx.get('/api/repositories')).json() as Repo[]
    expect(row).toMatchObject({ bootstrap: ['pnpm install'], checks: ctx.repo.checks })
  })

  it('edit appends to the repositories stream, trust included', async () => {
    const ctx = await withRepository()
    await ctx.patch(`/api/repositories/${ctx.repo.id}`, {
      base_revision: ctx.repo.revision,
      trusted: true,
    })
    const event = ctx.store.events.read('repositories').at(-1)
    expect(event).toMatchObject({
      type: 'repository_updated',
      body: { repositoryId: ctx.repo.id, changed: ['trust'], trust: { from: false, to: true } },
    })
    expect(ctx.store.events.read(ctx.repo.id)).toEqual([])
  })

  it('editing does not change a pinned work item', async () => {
    const ctx = await withRepository()
    const pin = {
      repoId: ctx.repo.id,
      url: ctx.repo.url,
      profileHash: 'pinned',
      policyHash: 'p',
      promptRevision: 'r',
    }
    const at = '2026-11-05T10:00:00.000Z'
    ctx.store.workItems.save({
      id: 'wi_1',
      repoId: ctx.repo.id,
      pin,
      state: 'planning',
      createdAt: at,
      updatedAt: at,
    })
    await ctx.patch(`/api/repositories/${ctx.repo.id}`, {
      base_revision: ctx.repo.revision,
      bootstrapCmds: ['npm ci'],
      checkCmds: NEW_CHECKS,
      trusted: true,
    })
    expect(ctx.store.workItems.get('wi_1')).toMatchObject({ pin, updatedAt: at })
  })

  it('needs a base, and answers 404 for an unknown repository', async () => {
    const ctx = await withRepository()
    expect((await ctx.patch(`/api/repositories/${ctx.repo.id}`, { trusted: true })).statusCode).toBe(400)
    const unknown = await ctx.patch('/api/repositories/repo_none', { base_revision: 'x', trusted: true })
    expect(unknown.statusCode).toBe(404)
  })
})

describe('a setup proposal and trust (§22, requirement 13)', () => {
  const proposal = (ctx: ConfigServer, id: string, patch: Record<string, unknown>) => {
    const path = join(ctx.dir, id)
    mkdirSync(path, { recursive: true })
    ctx.store.engines.save({
      id: `draft/${id}`,
      draftId: id,
      target: 'repository',
      patch: { label: id, url_or_path: path, ...patch } as never,
      reason: 'register it',
      diff: 'target: repository',
      status: 'pending',
      conversationId: 'setup',
      createdAt: '2026-11-05T10:00:00.000Z',
    })
    return path
  }
  const rowAt = async (ctx: ConfigServer, url: string) =>
    ((await ctx.get('/api/repositories')).json() as Repo[]).find((row) => row.url === url)
  const cardOf = async (ctx: ConfigServer, id: string) =>
    ((await ctx.get('/api/setup/drafts')).json() as Array<{ id: string; trustIgnored?: boolean }>).find(
      (entry) => entry.id === id,
    )

  it('a proposal cannot trust a repository', async () => {
    const ctx = await withRepository()
    const path = proposal(ctx, 'wants_trust', { trust: true })
    expect((await ctx.post('/api/setup/drafts/wants_trust/apply', {})).statusCode).toBe(200)
    const row = await rowAt(ctx, path)
    expect(row?.trust).toBe(false)

    // Settings stays the way in: the same repository takes trust from the two-step control's route.
    const edited = await ctx.patch(`/api/repositories/${row?.id}`, {
      base_revision: row?.revision,
      trusted: true,
    })
    expect(edited.statusCode).toBe(200)
    expect((await rowAt(ctx, path))?.trust).toBe(true)
  })

  it('says so on the card when a proposal carried trust, and only then', async () => {
    const ctx = await withRepository()
    proposal(ctx, 'wants_trust', { trust: true })
    proposal(ctx, 'wants_string', { trust: 'true' })
    proposal(ctx, 'plain', {})
    proposal(ctx, 'declines', { trust: false })
    expect((await cardOf(ctx, 'wants_trust'))?.trustIgnored).toBe(true)
    expect((await cardOf(ctx, 'wants_string'))?.trustIgnored).toBe(true)
    expect((await cardOf(ctx, 'plain'))?.trustIgnored).toBeUndefined()
    expect((await cardOf(ctx, 'declines'))?.trustIgnored).toBeUndefined()
  })

  it("the setup agent's own tool cannot trust a repository either", async () => {
    const ctx = makeConfigServer({
      setupDecide: async ({ text }) => ({
        calls: [{ tool: 'register_repository', args: { label: 'tool', url_or_path: text, trust: 'true' } }],
      }),
    })
    servers.push(ctx)
    expect((await ctx.post('/api/chat/messages', { setup: true, text: ctx.dir })).statusCode).toBe(200)
    expect((await rowAt(ctx, ctx.dir))?.trust).toBe(false)
  })

  it("the owner's own form still chooses trust", async () => {
    const ctx = await withRepository()
    const path = join(ctx.dir, 'form')
    mkdirSync(path, { recursive: true })
    const res = await ctx.post('/api/repositories', {
      urlOrPath: path,
      bootstrapCmds: [],
      checkCmds: [],
      trusted: true,
    })
    expect(res.statusCode).toBe(200)
    expect((await rowAt(ctx, path))?.trust).toBe(true)
  })
})
