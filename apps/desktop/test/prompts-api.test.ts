import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, HealthClaim, HealthName, Store } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, type ServerDeps } from '../src/server'

/**
 * T4 prompt routes (review 2026-11-04 §6.2 · plan §16): the editable prompt surface over the
 * makeServer pattern — config + revision, defaults, stale-base refusal (409), immutable
 * revisions, preview without saving, and the Default-updated diff. The store roots at the
 * keystoreRoot seam, so each test gets a throwaway prompts tree.
 */

const AT = new Date('2026-11-04T12:00:00.000Z')

class FakeHealthBoard implements HealthBoard {
  claim(_name: HealthName): HealthClaim {
    return {
      starting: () => {},
      ready: () => {},
      paused: () => {},
      error: () => {},
    }
  }
}

const roots: string[] = []

function makeServer(): { store: Store; app: ReturnType<typeof buildServer>; promptsRoot: string } {
  const promptsRoot = mkdtempSync(join(tmpdir(), 'mec-prompts-api-'))
  roots.push(promptsRoot)
  const store: Store = new MemoryRepositories()
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health: new FakeHealthBoard(),
    policyText: '{"preAuthorised":{}}',
    now: () => AT,
    keystoreRoot: promptsRoot,
  }
  return { store, app: buildServer(deps), promptsRoot }
}

const servers: ReturnType<typeof buildServer>[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function track(server: ReturnType<typeof buildServer>): ReturnType<typeof buildServer> {
  servers.push(server)
  return server
}

describe('T4 prompt routes', () => {
  it('GET /api/prompts answers the empty config at revision 0', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({ method: 'GET', url: '/api/prompts' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ revision: 0, parts: [] })
  })

  it('GET /api/prompts/defaults lists the 21 shipped markdown parts, models.yaml excluded', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({ method: 'GET', url: '/api/prompts/defaults' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { parts: Array<{ path: string; layer: string; text: string; hash: string }> }
    expect(body.parts).toHaveLength(21)
    expect(body.parts.some((part) => part.path.endsWith('.yaml'))).toBe(false)
    const delivery = body.parts.find((part) => part.path === 'shared/delivery.md')
    expect(delivery?.layer).toBe('delivery')
    for (const part of body.parts) {
      expect(part.text.startsWith('# '), part.path).toBe(true)
      expect(part.hash).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('PUT /api/prompts saves one override as one immutable revision', async () => {
    const { app, promptsRoot } = makeServer()
    const res = await track(app).inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: {
        base_revision: 0,
        origin: 'panel',
        parts: [{ path: 'roles/implementer.md', text: 'My implementer rules.\n' }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ revision: 1 })
    expect(readFileSync(join(promptsRoot, 'prompts/roles/implementer.md'), 'utf8')).toBe(
      'My implementer rules.\n',
    )
    expect(existsSync(join(promptsRoot, 'prompts/revisions/1.json'))).toBe(true)

    const config = await app.inject({ method: 'GET', url: '/api/prompts' })
    expect(config.statusCode).toBe(200)
    const body = config.json() as { revision: number; parts: Array<{ path: string; layer: string }> }
    expect(body.revision).toBe(1)
    expect(body.parts).toEqual([
      {
        path: 'roles/implementer.md',
        text: 'My implementer rules.\n',
        defaultBaseHash: expect.any(String),
        layer: 'role',
      },
    ])
  })

  it('PUT with a stale base is refused with 409 and writes nothing', async () => {
    const { app, promptsRoot } = makeServer()
    const first = await track(app).inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: { base_revision: 0, origin: 'panel', parts: [{ path: 'shared/scope.md', text: 'Mine.\n' }] },
    })
    expect(first.statusCode).toBe(200)
    const stale = await app.inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: { base_revision: 0, origin: 'agent', parts: [{ path: 'shared/scope.md', text: 'Race.\n' }] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'stale_base', current_revision: 1 })
    expect(readFileSync(join(promptsRoot, 'prompts/shared/scope.md'), 'utf8')).toBe('Mine.\n')
    const config = await app.inject({ method: 'GET', url: '/api/prompts' })
    expect((config.json() as { revision: number }).revision).toBe(1)
  })

  it('PUT rejects a bad origin, a non-array parts list, and unknown part paths', async () => {
    const { app } = makeServer()
    const badOrigin = await track(app).inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: { base_revision: 0, origin: 'engine', parts: [] },
    })
    expect(badOrigin.statusCode).toBe(400)
    const badParts = await app.inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: { base_revision: 0, origin: 'panel', parts: 'nope' },
    })
    expect(badParts.statusCode).toBe(400)
    const unknownPart = await app.inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: { base_revision: 0, origin: 'panel', parts: [{ path: 'roles/ghost.md', text: 'Boo.\n' }] },
    })
    expect(unknownPart.statusCode).toBe(400)
    expect((unknownPart.json() as { error: string }).error).toContain('roles/ghost.md')
  })

  it('PUT with text identical to the default removes the override (§16.2)', async () => {
    const { app } = makeServer()
    const defaults = await track(app).inject({ method: 'GET', url: '/api/prompts/defaults' })
    const scope = (defaults.json() as { parts: Array<{ path: string; text: string }> }).parts.find(
      (part) => part.path === 'shared/scope.md',
    )!
    await app.inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: { base_revision: 0, origin: 'panel', parts: [{ path: 'shared/scope.md', text: 'Mine.\n' }] },
    })
    const reverted = await app.inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: { base_revision: 1, origin: 'panel', parts: [{ path: 'shared/scope.md', text: scope.text }] },
    })
    expect(reverted.statusCode).toBe(200)
    expect(reverted.json()).toEqual({ revision: 2 })
    const config = await app.inject({ method: 'GET', url: '/api/prompts' })
    expect(config.json()).toEqual({ revision: 2, parts: [] })
  })

  it('GET /api/prompts/revisions/:n serves the snapshot verbatim, 404 for the missing', async () => {
    const { app } = makeServer()
    await track(app).inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: {
        base_revision: 0,
        origin: 'agent',
        parts: [{ path: 'roles/implementer.md', text: 'Agent edit.\n' }],
      },
    })
    const found = await app.inject({ method: 'GET', url: '/api/prompts/revisions/1' })
    expect(found.statusCode).toBe(200)
    expect(found.json()).toMatchObject({ n: 1, base: 0, origin: 'agent', time: AT.toISOString() })
    const missing = await app.inject({ method: 'GET', url: '/api/prompts/revisions/9' })
    expect(missing.statusCode).toBe(404)
  })

  it('POST /api/prompts/preview assembles a role with overrides applied, without saving', async () => {
    const { app } = makeServer()
    await track(app).inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: {
        base_revision: 0,
        origin: 'panel',
        parts: [{ path: 'roles/implementer.md', text: 'My implementer rules.\n' }],
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompts/preview',
      payload: { role: 'implementer', engine: 'claude' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { revision: string; text: string }
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/)
    const headers = [
      '## shared/communication',
      '## role/implementer',
      '## conventions/conventions',
      '## delivery/delivery',
      '## engine/claude',
    ]
    for (const header of headers) expect(body.text, header).toContain(header)
    expect(body.text).toContain('My implementer rules.')
    // Preview saved nothing: the config is unchanged.
    const config = await app.inject({ method: 'GET', url: '/api/prompts' })
    expect((config.json() as { revision: number }).revision).toBe(1)
  })

  it('POST /api/prompts/preview rejects an unknown role with 400', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({
      method: 'POST',
      url: '/api/prompts/preview',
      payload: { role: 'nonexistent_role' },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain('unknown role')
  })

  it('GET /api/prompts/changes reports a part whose default moved under the override', async () => {
    const { app, promptsRoot } = makeServer()
    await track(app).inject({
      method: 'PUT',
      url: '/api/prompts',
      payload: {
        base_revision: 0,
        origin: 'panel',
        parts: [{ path: 'shared/communication.md', text: 'My rules.\n' }],
      },
    })
    // Simulate the app update: the override's recorded base no longer matches the shipped
    // default (hand-edit the index to a hash the tree never had).
    const basesPath = join(promptsRoot, 'prompts/.bases.json')
    const bases = JSON.parse(readFileSync(basesPath, 'utf8')) as Record<string, string>
    bases['shared/communication.md'] = 'deadbeef00000000'
    writeFileSync(basesPath, `${JSON.stringify(bases, null, 2)}\n`)

    const res = await app.inject({ method: 'GET', url: '/api/prompts/changes' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      changes: Array<{ path: string; newDefault: { hash: string }; userText: string }>
    }
    expect(body.changes).toHaveLength(1)
    expect(body.changes[0]!.path).toBe('shared/communication.md')
    expect(body.changes[0]!.userText).toBe('My rules.\n')
    const defaults = await app.inject({ method: 'GET', url: '/api/prompts/defaults' })
    const shipped = (defaults.json() as { parts: Array<{ path: string; hash: string }> }).parts.find(
      (part) => part.path === 'shared/communication.md',
    )!
    expect(body.changes[0]!.newDefault.hash).toBe(shipped.hash)
  })
})
