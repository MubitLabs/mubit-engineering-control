/**
 * §5.4 keystore root: `MEC_DATA_DIR` moves the whole of a server's state, or a scratch server
 * reads and writes the real `~/.mec`. The home directory here is a throwaway folder behind a
 * `node:os` double, so a run that gets this wrong lands in that folder and never in a real home.
 * The first test proves the double reaches the server before any test writes.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, HealthClaim, Store } from '@mec/contracts'
import { readMetaProtocol } from '@mec/meta'
import { DEFAULT_MODELS_YAML_PATH, loadModelsTable } from '@mec/prompts'
import { MemoryRepositories } from '@mec/testkit'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../src/server'

const { fakeHome, scratch } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const os = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    fakeHome: mkdtempSync(join(os.tmpdir(), 'mec-fake-home-')),
    scratch: mkdtempSync(join(os.tmpdir(), 'mec-scratch-state-')),
  }
})

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => fakeHome, default: { ...os, homedir: () => fakeHome } }
})

const fakeHealth: HealthBoard = {
  claim(): HealthClaim {
    return { starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }
  },
}

const realDefault = join(fakeHome, '.mec')
const yaml = (): string => readFileSync(DEFAULT_MODELS_YAML_PATH, 'utf8')
const seedModels = (root: string): void => {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'models.yaml'), yaml())
}
const seedProtocol = (root: string, text: string): void => {
  const dir = join(root, 'prompts', 'roles', 'meta_agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'protocol.md'), text)
}

const servers: ReturnType<typeof buildServer>[] = []
function server(keystoreRoot?: string): ReturnType<typeof buildServer> {
  const store: Store = new MemoryRepositories()
  const app = buildServer({
    store,
    effects: store.effects,
    health: fakeHealth,
    policyText: '{"preAuthorised":{}}',
    ...(keystoreRoot !== undefined && { keystoreRoot }),
  })
  servers.push(app)
  return app
}

const savedPrompt = {
  base_revision: 0,
  origin: 'panel',
  parts: [{ path: 'roles/implementer.md', text: 'My implementer rules.\n' }],
}

const wipe = (): void => {
  rmSync(realDefault, { recursive: true, force: true })
  for (const entry of ['models.yaml', 'prompts', 'engines']) {
    rmSync(join(scratch, entry), { recursive: true, force: true })
  }
}

const saved = process.env.MEC_DATA_DIR
beforeEach(() => {
  wipe()
  delete process.env.MEC_DATA_DIR
})
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  if (saved === undefined) delete process.env.MEC_DATA_DIR
  else process.env.MEC_DATA_DIR = saved
})
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

describe('MEC_DATA_DIR unset: the root stays ~/.mec', () => {
  it('the home double reaches the server, the models table and the planner', async () => {
    expect(homedir()).toBe(fakeHome)
    seedModels(realDefault)
    seedProtocol(realDefault, 'home protocol')
    const res = await server().inject({ method: 'GET', url: '/api/models' })
    expect(res.json()).toMatchObject({
      provenance: { source: 'user', path: join(realDefault, 'models.yaml') },
    })
    expect(loadModelsTable().provenance.path).toBe(join(realDefault, 'models.yaml'))
    expect(readMetaProtocol()).toContain('home protocol')
  })

  it('a prompt save lands under ~/.mec/prompts', async () => {
    const res = await server().inject({ method: 'PUT', url: '/api/prompts', payload: savedPrompt })
    expect(res.statusCode).toBe(200)
    expect(existsSync(join(realDefault, 'prompts'))).toBe(true)
  })
})

describe('MEC_DATA_DIR set: nothing reaches past it', () => {
  beforeEach(() => {
    process.env.MEC_DATA_DIR = scratch
  })

  it('reads the models table from the data dir', async () => {
    seedModels(scratch)
    const res = await server().inject({ method: 'GET', url: '/api/models' })
    expect(res.json()).toMatchObject({ provenance: { source: 'user', path: join(scratch, 'models.yaml') } })
  })

  it('writes the models table and prompts under the data dir, and nothing under ~/.mec', async () => {
    const app = server()
    const models = await app.inject({ method: 'PUT', url: '/api/models', payload: { yaml: yaml() } })
    expect(models.statusCode).toBe(200)
    const prompts = await app.inject({ method: 'PUT', url: '/api/prompts', payload: savedPrompt })
    expect(prompts.statusCode).toBe(200)
    expect(existsSync(join(scratch, 'models.yaml'))).toBe(true)
    expect(existsSync(join(scratch, 'prompts'))).toBe(true)
    expect(existsSync(realDefault)).toBe(false)
  })

  it('the planner’s table and its protocol follow the data dir too', () => {
    seedModels(scratch)
    seedProtocol(scratch, 'scratch protocol')
    expect(loadModelsTable().provenance.path).toBe(join(scratch, 'models.yaml'))
    expect(readMetaProtocol()).toContain('scratch protocol')
  })

  it('an explicit keystoreRoot still wins', async () => {
    const root = join(scratch, 'engines')
    seedModels(root)
    const res = await server(root).inject({ method: 'GET', url: '/api/models' })
    expect(res.json()).toMatchObject({ provenance: { path: join(root, 'models.yaml') } })
  })
})
