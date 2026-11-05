import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, HealthClaim, HealthName, Store } from '@mec/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// Relative on purpose, as in web-contract.test.ts: the one place these decoders meet real routes.
import { MemoryRepositories } from '../../../packages/testkit/src/index'
import { buildServer } from '../../desktop/src/server'
import { HttpError } from '../src/api'
import { configApi, StaleError } from '../src/api-config'
import { failureText } from '../src/live/config'
import { roleOfPart } from '../src/next/config-model'

const AT = new Date('2026-11-05T12:00:00.000Z')

class FakeHealthBoard implements HealthBoard {
  claim(_name: HealthName): HealthClaim {
    return { starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }
  }
}

const originalFetch = globalThis.fetch
let root: string
let store: Store
let app: ReturnType<typeof buildServer>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mec-config-contract-'))
  store = new MemoryRepositories()
  app = buildServer({
    store,
    effects: store.effects,
    health: new FakeHealthBoard(),
    policyText: '{"preAuthorised":{}}',
    now: () => AT,
    keystoreRoot: root,
    probeCmd: async (cmd) => ({ code: 0, stdout: `${cmd} 1.0.0\n`, stderr: '' }),
    backups: {
      take: () => {
        const archivePath = join(root, 'sample.tgz')
        writeFileSync(archivePath, '')
        return { archivePath, excluded: [] }
      },
    },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
    })
    return new Response(res.body, { status: res.statusCode, headers: res.headers as HeadersInit })
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the configuration client against the real routes', () => {
  it('reads status capabilities and readiness on a clean install', async () => {
    expect(await configApi.capabilities()).toMatchObject({ backups: true, switchWork: false })
    const readiness = await configApi.readiness()
    expect(readiness.steps).toHaveLength(5)
    expect(readiness.steps[0]?.status).toBe('done')
    expect(readiness.steps[1]?.status).toBe('missing')
    expect(readiness.finish.enabled).toBe(false)
    expect(readiness.completion).toBeNull()
  })

  it('walks a repository and a dedicated connection end to end', async () => {
    const path = join(root, 'repo')
    mkdirSync(path)
    const { id } = await configApi.addRepository({
      urlOrPath: path,
      bootstrapCmds: ['pnpm install'],
      checkCmds: [{ name: 'test', cmd: 'pnpm test' }],
    })
    const [repository] = await configApi.repositories()
    expect(repository).toMatchObject({ id, trust: false })
    const saved = await configApi.editRepository(id, repository?.revision ?? '', { trusted: true })
    expect(saved.revision).not.toBe(repository?.revision)
    await expect(
      configApi.editRepository(id, repository?.revision ?? '', { trusted: false }),
    ).rejects.toBeInstanceOf(StaleError)

    await configApi.dedicated('claude', 'max-1')
    const connections = await configApi.connections()
    expect(connections.rows[0]).toMatchObject({ label: 'max-1', credential: 'sign_in', state: 'home_ready' })
    expect(connections.options.map((option) => option.engine)).toEqual(['claude', 'codex', 'opencode'])
    expect(await configApi.impact('slot_max-1')).toMatchObject({ running: 0, keyStored: false })
    await configApi.retireSlot('slot_max-1', 'max-1')
    expect((await configApi.connections()).rows).toEqual([])
  })

  it('saves policy, prompts and models through their decoders', async () => {
    const policy = await configApi.policy()
    expect(policy.source).toBe('default')
    const saved = await configApi.savePolicy('{"preAuthorised":{"spend":[]}}', policy.sha256)
    expect((await configApi.policy()).sha256).toBe(saved.sha256)
    await expect(configApi.savePolicy('{"preAuthorised":{}}', policy.sha256)).rejects.toBeInstanceOf(
      StaleError,
    )

    const prompts = await configApi.prompts()
    const defaults = await configApi.promptDefaults()
    const path = prompts.parts[0]?.path ?? ''
    expect(defaults[path]).toBeDefined()
    const { revision } = await configApi.savePromptPart(path, 'a saved part', prompts.revision)
    expect((await configApi.prompts()).overrides[path]).toBe('a saved part')
    expect((await configApi.promptRevision(revision))[path]).toBe('a saved part')
    const role = prompts.parts.find((part) => part.layer === 'role')
    const name = roleOfPart(role?.path ?? '') ?? ''
    expect((await configApi.promptPreview(name)).text.length).toBeGreaterThan(0)

    expect(await configApi.promptChanges()).toEqual([])

    const models = await configApi.modelsText()
    await configApi.saveModels(`${models.yaml}\n# edited\n`, models.sha256)
    expect((await configApi.modelsText()).source).toBe('user')
  })

  const refusalOf = (attempt: Promise<unknown>): Promise<string> =>
    attempt.then(
      () => 'accepted',
      (failure: unknown) => failureText(failure),
    )

  it('a refused policy says why, from a save and from a proposal', async () => {
    const policy = await configApi.policy()
    const said = await refusalOf(configApi.savePolicy('{"preAuthorised":{"pr_merge":[]}}', policy.sha256))
    expect(said).toContain('invalid_policy')
    expect(said).toContain("class 'pr_merge' is always-confirm")

    store.engines.save({
      id: 'draft/d2',
      draftId: 'd2',
      target: 'policy',
      patch: { preAuthorised: { pr_merge: [] } },
      reason: 'a reason',
      diff: 'a diff',
      status: 'pending',
      conversationId: 'setup',
      createdAt: AT.toISOString(),
    })
    const applied = await refusalOf(configApi.applyDraft('d2', policy.sha256))
    expect(applied).toContain('invalid_policy')
    expect(applied).toContain("class 'pr_merge' is always-confirm")
  })

  it("reads a proposal's comparison, and Apply with its base saves that text", async () => {
    const policy = await configApi.policy()
    store.engines.save({
      id: 'draft/d3',
      draftId: 'd3',
      target: 'policy',
      patch: { preAuthorised: { install: [{ scope: 'repo', repoId: 'repo_prop' }] } },
      reason: 'a reason',
      diff: 'a diff',
      status: 'pending',
      conversationId: 'setup',
      createdAt: AT.toISOString(),
    })
    const [draft] = await configApi.drafts()
    expect(draft?.preview?.base).toBe(policy.sha256)
    expect(draft?.preview?.changes[0]?.after).toContain('repo_prop')
    await configApi.applyDraft('d3', draft?.preview?.base)
    expect((await configApi.policy()).text).toBe(draft?.preview?.changes[0]?.after)
  })

  it('reads that a proposal carried a trust setting it cannot apply', async () => {
    const save = (id: string, patch: Record<string, unknown>) =>
      store.engines.save({
        id: `draft/${id}`,
        draftId: id,
        target: 'repository',
        patch: { label: id, url_or_path: '/tmp', ...patch } as never,
        reason: 'a reason',
        diff: 'a diff',
        status: 'pending',
        conversationId: 'setup',
        createdAt: AT.toISOString(),
      })
    save('d4', { trust: true })
    save('d5', {})
    const drafts = await configApi.drafts()
    expect(drafts.find((draft) => draft.id === 'd4')?.trustIgnored).toBe(true)
    expect(drafts.find((draft) => draft.id === 'd5')?.trustIgnored).toBeUndefined()
  })

  it('a refused models table says which line', async () => {
    const models = await configApi.modelsText()
    const said = await refusalOf(configApi.saveModels('tiers: [fast', models.sha256))
    expect(said).toContain('invalid models table')
    expect(said).toContain('line 1')
  })

  it('a failure with only an error reads as that error', () => {
    expect(failureText(new HttpError('/x', 400, 'a slot with that label already exists'))).toBe(
      'a slot with that label already exists',
    )
    expect(failureText(new HttpError('/x', 500))).toBe('The server answered 500.')
  })

  it('lists drafts and takes a backup', async () => {
    store.engines.save({
      id: 'draft/d1',
      draftId: 'd1',
      target: 'policy',
      patch: { preAuthorised: {} },
      reason: 'a reason',
      diff: 'a diff',
      status: 'pending',
      conversationId: 'setup',
      createdAt: AT.toISOString(),
    })
    expect(await configApi.drafts()).toMatchObject([{ id: 'd1', target: 'policy', status: 'pending' }])
    await configApi.dismissDraft('d1')
    expect((await configApi.drafts())[0]?.status).toBe('denied')

    expect((await configApi.backups()).lastAt).toBeUndefined()
    expect((await configApi.takeBackup()).status).toBe('done')
    expect((await configApi.backups()).lastAt).toBeDefined()
  })
})
