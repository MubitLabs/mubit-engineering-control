import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, HealthClaim, HealthName, Store, StoreDoc } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, type ProbeCmd, type ServerDeps } from '../src/server'

/**
 * T1 model routes (review 2026-11-04 §3 + §6.2): the capability table with
 * provenance, the probe-driven availability marks, and the one write path. The
 * keystore root is a tmp dir (never ~/.mec) and every probe rides an injected
 * `probeCmd` — no route in here runs a real engine binary.
 */
const AT = '2026-11-04T12:00:00.000Z'

class FakeHealthBoard implements HealthBoard {
  readonly entries = new Map<
    HealthName,
    { state: 'starting' | 'ready' | 'paused' | 'error'; detail?: string }
  >()
  claim(name: HealthName): HealthClaim {
    const entry: { state: 'starting' | 'ready' | 'paused' | 'error'; detail?: string } = { state: 'starting' }
    this.entries.set(name, entry)
    return {
      starting: () => {},
      ready: () => {},
      paused: () => {},
      error: (detail: string) => {
        entry.detail = detail
      },
    }
  }
}

type MakeServer = {
  root: string
  probeCalls: Array<{ cmd: string; args: readonly string[]; env?: NodeJS.ProcessEnv }>
}

const tmps: string[] = []
afterEach(() => {
  while (tmps.length > 0) rmSync(tmps.pop()!, { recursive: true, force: true })
})

function makeServer(over: { probeCmd?: ProbeCmd } = {}): MakeServer & {
  store: Store
  app: ReturnType<typeof buildServer>
} {
  const root = mkdtempSync(join(tmpdir(), 'mec-models-api-'))
  tmps.push(root)
  const store: Store = new MemoryRepositories()
  const probeCalls: MakeServer['probeCalls'] = []
  const probeCmd: ProbeCmd =
    over.probeCmd ??
    (async (cmd, args, opts) => {
      probeCalls.push({ cmd, args, env: opts?.env })
      return { code: 0, stdout: '', stderr: '' }
    })
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health: new FakeHealthBoard(),
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    keystoreRoot: root,
    probeCmd,
  }
  return { root, store, probeCalls, app: buildServer(deps) }
}

const servers: ReturnType<typeof buildServer>[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})
const track = (server: ReturnType<typeof buildServer>): ReturnType<typeof buildServer> => {
  servers.push(server)
  return server
}

const defaultYaml = (): string =>
  readFileSync(join(__dirname, '../../../packages/prompts/defaults/models.yaml'), 'utf8')

const SLOT_GLM = {
  id: 'slot_glm1',
  label: 'glm1',
  engine: 'opencode',
  kind: 'opencode-glm',
  provider: 'zai-coding-plan',
  home: join(mkdtempSync(join(tmpdir(), 'mec-glm-home-')), 'slot'),
  state: 'healthy',
  createdAt: AT,
  updatedAt: AT,
}

describe('GET /api/models', () => {
  it('serves the shipped default table with default provenance when no user table exists', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({ method: 'GET', url: '/api/models' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      table: { tiers: string[]; engines: Record<string, { models?: Record<string, { tier: string }> }> }
      provenance: { source: string; path: string; sha256: string }
      availability: unknown[]
    }
    expect(body.table.tiers).toEqual(['fast', 'balanced', 'strong', 'frontier'])
    expect(body.table.engines.claude?.models?.opus?.tier).toBe('strong')
    expect(body.provenance.source).toBe('default')
    expect(body.provenance.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(body.provenance.path).toContain('defaults/models.yaml')
    expect(body.availability).toEqual([]) // no slots: nothing to probe
  })

  it('marks table entries per slot: opencode config-declared, claude honestly unlisted', async () => {
    // Config-declared availability (T8): the probe reads the slot's own opencode.json —
    // glm-5.3 is declared; the flash variant is absent from the config, hence unlisted.
    const configDir = join(SLOT_GLM.home, 'config')
    mkdirSync(join(configDir, 'opencode'), { recursive: true })
    writeFileSync(
      join(configDir, 'opencode', 'opencode.json'),
      JSON.stringify({ provider: { 'zai-coding-plan': { models: { 'glm-5.3': { name: 'GLM 5.3' } } } } }),
    )
    const { app, store } = makeServer({})
    store.slots.save(SLOT_GLM as unknown as StoreDoc)
    store.slots.save({
      id: 'slot_max1',
      engine: 'claude',
      kind: 'claude-sub',
      state: 'healthy',
    } as unknown as StoreDoc)
    const res = await track(app).inject({ method: 'GET', url: '/api/models' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      availability: Array<{
        slotId: string
        engine: string
        provider?: string
        models: Record<string, string>
        note: string
      }>
    }
    const glm = body.availability.find((entry) => entry.slotId === 'slot_glm1')
    expect(glm?.provider).toBe('zai-coding-plan')
    expect(glm?.models).toEqual({
      'zai-coding-plan/glm-5.3': 'available',
      // the slot WAS probed (config-declared) and flash is absent from its config —
      // unavailable ON THIS SLOT, which is the placement-relevant mark.
      'zai-coding-plan/glm-5.3-flash': 'unavailable',
    })
    expect(glm?.note).toContain('config-declared')
    const claude = body.availability.find((entry) => entry.slotId === 'slot_max1')
    expect(claude?.models).toEqual({
      haiku: 'unlisted',
      sonnet: 'unlisted',
      opus: 'unlisted',
      fable: 'unlisted',
    })
    // (The config-declared probe spawns nothing — isolation is the slot's config path,
    // proven by the marks above; there is no argv to assert.)
  })

  it('a broken user table is a loud 500 with the parse detail, never a quiet default', async () => {
    const { app, root } = makeServer()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(root, 'models.yaml'), 'version: 1\ntiers: [fast]\n')
    const res = await track(app).inject({ method: 'GET', url: '/api/models' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ error: 'models table invalid' })
    expect(res.json().detail).toBeTruthy()
  })
})

describe('PUT /api/models', () => {
  it('validates, writes ~/.mec-rooted models.yaml and records models_table_updated', async () => {
    const { app, store, root } = makeServer()
    const yaml = defaultYaml().replace(
      'cost: 3,  context: 1m, output: 128k, api_usd_per_mtok: [2, 10]',
      'cost: 4,  context: 1m, output: 128k, api_usd_per_mtok: [2, 10]',
    )
    const res = await track(app).inject({
      method: 'PUT',
      url: '/api/models',
      payload: { yaml, base_sha256: undefined },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { provenance: { source: string; path: string; sha256: string } }
    expect(body.provenance.source).toBe('user')
    expect(body.provenance.path).toBe(join(root, 'models.yaml'))
    expect(existsSync(join(root, 'models.yaml'))).toBe(true)
    expect(store.events.read('models').map((event) => event.type)).toEqual(['models_table_updated'])
    expect((store.events.read('models')[0]?.body as { sha256?: string } | undefined)?.sha256).toBe(
      body.provenance.sha256,
    )
    // and GET now serves the edit
    const after = (await app.inject({ method: 'GET', url: '/api/models' })).json() as {
      table: { engines: { claude: { models: Record<string, { cost: number }> } } }
      provenance: { source: string }
    }
    expect(after.provenance.source).toBe('user')
    expect(after.table.engines.claude.models.sonnet?.cost).toBe(4)
  })

  it('an invalid table is a 400 with the schema/parse detail, and nothing is written', async () => {
    const { app, root } = makeServer()
    const res = await track(app).inject({
      method: 'PUT',
      url: '/api/models',
      payload: { yaml: 'version: 1\ntiers: [fast]\n' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid models table' })
    expect(existsSync(join(root, 'models.yaml'))).toBe(false)
  })

  it('a stale base is a 409 naming the current sha; the right base wins', async () => {
    const { app } = makeServer()
    const current = (
      (await app.inject({ method: 'GET', url: '/api/models' })).json() as {
        provenance: { sha256: string }
      }
    ).provenance.sha256
    const stale = await track(app).inject({
      method: 'PUT',
      url: '/api/models',
      payload: { yaml: defaultYaml(), base_sha256: '0'.repeat(64) },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({
      error: 'stale base — reload the table and reapply the edit',
      current_sha256: current,
    })
    const fresh = await app.inject({
      method: 'PUT',
      url: '/api/models',
      payload: { yaml: defaultYaml(), base_sha256: current },
    })
    expect(fresh.statusCode).toBe(200)
  })

  it('a yaml payload is required', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({ method: 'PUT', url: '/api/models', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'yaml (the full models.yaml text) is required' })
  })
})
