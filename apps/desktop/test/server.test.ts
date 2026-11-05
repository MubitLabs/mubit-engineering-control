import type { HealthBoard, HealthClaim, HealthName, Json, Store, StoreDoc } from '@mec/contracts'
import {
  MetaAgentService,
  type MetaBrain,
  type MetaDecision,
  saveProcessing,
  stableMessageId,
} from '@mec/meta'
import { type ConfirmationRecord, openConfirmation } from '@mec/policy'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHealthSnapshot } from '../src/health'
import { buildServer, type ServerDeps } from '../src/server'

const AT = '2026-11-03T12:00:00.000Z'

/** A HealthBoard double shaped like HealthBoardImpl: one mutable entry per claim, readable back. */
class FakeHealthBoard implements HealthBoard {
  readonly entries = new Map<
    HealthName,
    { state: 'starting' | 'ready' | 'paused' | 'error'; detail?: string }
  >()

  claim(name: HealthName): HealthClaim {
    const entry: { state: 'starting' | 'ready' | 'paused' | 'error'; detail?: string } = { state: 'starting' }
    this.entries.set(name, entry)
    return {
      starting: () => {
        entry.state = 'starting'
        entry.detail = undefined
      },
      ready: (detail?: string) => {
        entry.state = 'ready'
        entry.detail = detail
      },
      paused: () => {
        entry.state = 'paused'
      },
      error: (detail: string) => {
        entry.state = 'error'
        entry.detail = detail
      },
    }
  }

  names(): HealthName[] {
    return [...this.entries.keys()]
  }

  entry(name: HealthName): { state: string; detail?: string } | undefined {
    const entry = this.entries.get(name)
    return entry === undefined ? undefined : { ...entry }
  }
}

function makeServer(metaFor?: (store: Store) => ServerDeps['metaAgent']): {
  store: Store
  app: ReturnType<typeof buildServer>
} {
  const store: Store = new MemoryRepositories()
  const health = new FakeHealthBoard()
  health.claim('effects:launch').ready()
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    ...(metaFor !== undefined && { metaAgent: metaFor(store) }),
  }
  return { store, app: buildServer(deps) }
}

function pendingConfirmation(id: string): ConfirmationRecord {
  return openConfirmation({
    id,
    cls: 'install',
    operationHash: 'f'.repeat(64),
    expiresAt: '2999-01-01T00:00:00.000Z',
  })
}

async function postMessage(
  app: ReturnType<typeof buildServer>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ messageId: string; workItemId?: string; routing: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/chat/messages', payload, headers })
  expect(res.statusCode).toBe(200)
  return res.json() as { messageId: string; workItemId?: string; routing: string }
}

const servers: ReturnType<typeof buildServer>[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

function track(server: ReturnType<typeof buildServer>): ReturnType<typeof buildServer> {
  servers.push(server)
  return server
}

async function registerRepo(app: ReturnType<typeof buildServer>, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    payload: { urlOrPath: `https://example.test/${name}`, trusted: true, bootstrapCmds: [], checkCmds: [] },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { id: string }).id
}

describe('repo identity at the chat route', () => {
  const inject = (app: ReturnType<typeof buildServer>, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/chat/messages', payload })

  it('unknown repoId is refused before any write', async () => {
    const { store, app } = makeServer()
    const res = await inject(track(app), { text: 'ship it', repoId: 'repo_nope' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'unknown_repo' })
    expect(store.messages.list()).toHaveLength(0)
    expect(store.workItems.list()).toHaveLength(0)
  })

  it('a key-shaped message under an unknown repo stores nothing at all', async () => {
    const { store, app } = makeServer()
    const res = await inject(track(app), { text: `sk-ant-${'a'.repeat(40)}`, repoId: 'repo_nope' })
    expect(res.statusCode).toBe(400)
    expect(store.messages.list()).toHaveLength(0)
  })

  it('a repoId of the wrong type is a 400', async () => {
    const { store, app } = makeServer()
    track(app)
    for (const repoId of [7, '', null]) {
      expect((await inject(app, { text: 'ship it', repoId })).statusCode).toBe(400)
    }
    expect(store.messages.list()).toHaveLength(0)
  })

  it('repo A live work does not route repo B to conversation', async () => {
    const { store, app } = makeServer()
    track(app)
    const repoA = await registerRepo(app, 'a')
    const repoB = await registerRepo(app, 'b')

    const a = await postMessage(app, { text: 'work in a', repoId: repoA })
    const b = await postMessage(app, { text: 'work in b', repoId: repoB })
    const note = await postMessage(app, { text: 'more on a', repoId: repoA })

    expect(a.routing).toBe('new_work')
    expect(b.routing).toBe('new_work')
    expect(note.routing).toBe('conversation')
    expect(store.workItems.get(b.workItemId!)).toMatchObject({ repoId: repoB })
    expect(store.messages.get(note.messageId)).toMatchObject({ repoId: repoA })
    expect((store.workItems.get(a.workItemId!)!.pin as { url?: string }).url).toBe('https://example.test/a')
  })

  it('a reference across repos is a 400', async () => {
    const { store, app } = makeServer()
    track(app)
    const repoA = await registerRepo(app, 'a')
    const repoB = await registerRepo(app, 'b')
    const a = await postMessage(app, { text: 'work in a', repoId: repoA })

    const res = await inject(app, { text: 'x', repoId: repoB, referencesWorkItem: a.workItemId })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'repo_mismatch' })
    expect(store.messages.list()).toHaveLength(1)
  })

  it('an idempotency key replayed under another repo is a 400', async () => {
    const { app } = makeServer()
    track(app)
    const repoA = await registerRepo(app, 'a')
    const repoB = await registerRepo(app, 'b')
    const headers = { 'x-idempotency-key': 'key-1' }
    await postMessage(app, { text: 'x', repoId: repoA }, headers)

    const same = await postMessage(app, { text: 'x', repoId: repoA }, headers)
    expect(same.routing).toBe('duplicate')
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'x', repoId: repoB },
      headers,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'repo_mismatch' })
  })

  it('legacy rows stay in the global read, and repo reads are filtered', async () => {
    const { store, app } = makeServer()
    track(app)
    const repoA = await registerRepo(app, 'a')
    store.atomic(() => store.workItems.save({ id: 'wi_legacy', state: 'stopped' }))
    const scoped = await postMessage(app, { text: 'in a', repoId: repoA })
    expect(scoped.routing).toBe('new_work')

    const work = (await app.inject({ method: 'GET', url: `/api/work?repoId=${repoA}` })).json() as {
      id: string
      repoId?: string
    }[]
    expect(work.map((row) => [row.id, row.repoId])).toEqual([[scoped.workItemId, repoA]])
    const all = (await app.inject({ method: 'GET', url: '/api/work' })).json() as { id: string }[]
    expect(all.map((row) => row.id)).toEqual(['wi_legacy', scoped.workItemId])
    const messages = (
      await app.inject({ method: 'GET', url: `/api/chat/messages?repoId=${repoA}` })
    ).json() as { id: string }[]
    expect(messages.map((row) => row.id)).toEqual([scoped.messageId])
    for (const url of ['/api/work?repoId=repo_nope', '/api/chat/messages?repoId=repo_nope']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400)
    }
  })

  it('a repoId that is not one string is a 400 on both reads, never every repository’s rows', async () => {
    const { app } = makeServer()
    track(app)
    const repoA = await registerRepo(app, 'a')
    const repoB = await registerRepo(app, 'b')
    await postMessage(app, { text: 'in a', repoId: repoA })
    await postMessage(app, { text: 'in b', repoId: repoB })
    const queries = [
      `repoId=${repoA}&repoId=${repoB}`,
      `repoId=${repoA}&repoId=repo_nope`,
      `repoId[]=${repoA}`,
      `repoId%5B%5D=${repoA}`,
      `repoId[0]=${repoA}`,
      `repoId[a]=${repoA}`,
    ]
    for (const route of ['/api/work', '/api/chat/messages']) {
      for (const query of queries) {
        const res = await app.inject({ method: 'GET', url: `${route}?${query}` })
        expect(res.statusCode, `${route}?${query}`).toBe(400)
        expect(res.json(), `${route}?${query}`).toMatchObject({ error: 'unknown_repo' })
      }
    }
  })

  it('the composed path passes the repo to the meta agent and refuses before calling it', async () => {
    const seen: (string | undefined)[] = []
    const store: Store = new MemoryRepositories()
    const app = track(
      buildServer({
        store,
        effects: store.effects,
        health: new FakeHealthBoard(),
        policyText: '{"preAuthorised":{}}',
        now: () => new Date(AT),
        metaAgent: {
          onUserMessage: async (input) => {
            seen.push(input.repoId)
            return { acknowledged: 'On it', tasksCreated: 0, launchesEnqueued: [], escalated: false }
          },
        },
      }),
    )
    const repoA = await registerRepo(app, 'a')
    await postMessage(app, { text: 'x', repoId: repoA })
    expect(seen).toEqual([repoA])
    expect((await inject(app, { text: 'x', repoId: 'repo_nope' })).statusCode).toBe(400)
    expect(seen).toEqual([repoA])
  })

  it('the admission error handler leaves every other error as Fastify answers it', async () => {
    const { store, app } = makeServer()
    track(app)
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_JSON_BODY', statusCode: 400 })

    vi.spyOn(store.workItems, 'list').mockImplementation(() => {
      throw new Error('disk gone')
    })
    const thrown = await app.inject({ method: 'GET', url: '/api/work' })
    expect(thrown.statusCode).toBe(500)
    expect(thrown.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'disk gone',
    })
  })
})

describe('repoId is required on the chat route', () => {
  const inject = (app: ReturnType<typeof buildServer>, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/chat/messages', payload })

  it('absent repoId is 400 and writes nothing', async () => {
    const { store, app } = makeServer()
    const res = await inject(track(app), { text: 'ship it' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'repo_required' })
    expect(store.messages.list()).toHaveLength(0)
    expect(store.workItems.list()).toHaveLength(0)
  })

  it('absent repoId is 400 on the composed path, before the meta agent runs', async () => {
    let called = 0
    const store: Store = new MemoryRepositories()
    const app = track(
      buildServer({
        store,
        effects: store.effects,
        health: new FakeHealthBoard(),
        policyText: '{"preAuthorised":{}}',
        now: () => new Date(AT),
        metaAgent: {
          onUserMessage: async () => {
            called += 1
            return { acknowledged: 'On it', tasksCreated: 0, launchesEnqueued: [], escalated: false }
          },
        },
      }),
    )
    const res = await inject(app, { text: 'ship it' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'repo_required' })
    expect(called).toBe(0)
  })

  it('setup mode needs no repoId', async () => {
    const { store, app } = makeServer()
    const res = await inject(track(app), { text: 'help me set up', setup: true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ mode: 'setup' })
    expect(store.messages.list()).toHaveLength(1)
  })

  it('a secret paste with no repoId is still redacted and answered', async () => {
    const { store, app } = makeServer()
    const key = `sk-ant-${'a'.repeat(40)}`
    const res = await inject(track(app), { text: `here it is ${key}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ routing: 'conversation', secretGuard: true })
    expect(JSON.stringify(store.messages.list())).not.toContain(key)
  })
})

describe('submission intent at the chat route', () => {
  const post = (
    app: ReturnType<typeof buildServer>,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => app.inject({ method: 'POST', url: '/api/chat/messages', payload, headers })
  const key = { 'x-idempotency-key': 'key-1' }

  it('same key different repo stays 400 repo_mismatch', async () => {
    const { app } = makeServer()
    track(app)
    const repoA = await registerRepo(app, 'a')
    const repoB = await registerRepo(app, 'b')
    await postMessage(app, { text: 'x', repoId: repoA }, key)
    const res = await post(app, { text: 'x', repoId: repoB }, key)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'repo_mismatch' })
  })

  it('same key different text is 409', async () => {
    const { store, app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    await postMessage(app, { text: 'x', repoId: repo }, key)
    const res = await post(app, { text: 'y', repoId: repo }, key)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'idempotency_mismatch' })
    expect(store.messages.list()).toHaveLength(1)
  })

  it('same key different intent or reference is 409', async () => {
    const { app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    const first = await postMessage(app, { text: 'x', repoId: repo, intent: 'new' }, key)
    const absent = await post(app, { text: 'x', repoId: repo }, key)
    expect(absent.statusCode).toBe(409)

    const followKey = { 'x-idempotency-key': 'key-2' }
    const reference = { referencesWorkItem: first.workItemId, intent: 'follow_up' }
    await postMessage(app, { text: 'z', repoId: repo, ...reference }, followKey)
    const other = await postMessage(app, { text: 'w', repoId: repo, intent: 'new' })
    const moved = await post(
      app,
      { text: 'z', repoId: repo, intent: 'follow_up', referencesWorkItem: other.workItemId },
      followKey,
    )
    expect(moved.statusCode).toBe(409)
    expect(moved.json()).toMatchObject({ error: 'idempotency_mismatch' })
  })

  it('same key same payload replays', async () => {
    const { store, app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    const first = await postMessage(app, { text: ' x ', repoId: repo, intent: 'new' }, key)
    const again = await postMessage(app, { text: 'x', repoId: repo, intent: 'new' }, key)
    expect(again).toMatchObject({ messageId: first.messageId, routing: 'duplicate' })
    expect(store.messages.list()).toHaveLength(1)
  })

  it('the mismatch check holds on the composed path', async () => {
    const store: Store = new MemoryRepositories()
    const app = track(
      buildServer({
        store,
        effects: store.effects,
        health: new FakeHealthBoard(),
        policyText: '{"preAuthorised":{}}',
        now: () => new Date(AT),
        metaAgent: {
          onUserMessage: async (input) => {
            store.atomic(() =>
              store.messages.save({ id: input.messageId, text: input.text, repoId: input.repoId as string }),
            )
            return { acknowledged: 'On it', tasksCreated: 0, launchesEnqueued: [], escalated: false }
          },
        },
      }),
    )
    const repo = await registerRepo(app, 'a')
    await postMessage(app, { text: 'x', repoId: repo, intent: 'new' }, key)
    expect((await post(app, { text: 'x', repoId: repo }, key)).statusCode).toBe(409)
  })

  it('new intent starts work beside live work in the same repo', async () => {
    const { store, app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    const first = await postMessage(app, { text: 'one', repoId: repo })
    expect((await postMessage(app, { text: 'context', repoId: repo })).routing).toBe('conversation')
    const second = await postMessage(app, { text: 'two', repoId: repo, intent: 'new' })
    expect(second.routing).toBe('new_work')
    expect(second.workItemId).not.toBe(first.workItemId)
    expect(store.workItems.list()).toHaveLength(2)
  })

  it('the composed path passes an explicit new request to the meta agent', async () => {
    const seen: (boolean | undefined)[] = []
    const store: Store = new MemoryRepositories()
    const app = track(
      buildServer({
        store,
        effects: store.effects,
        health: new FakeHealthBoard(),
        policyText: '{"preAuthorised":{}}',
        now: () => new Date(AT),
        metaAgent: {
          onUserMessage: async (input) => {
            seen.push(input.explicitNew)
            return { acknowledged: 'On it', tasksCreated: 0, launchesEnqueued: [], escalated: false }
          },
        },
      }),
    )
    const repo = await registerRepo(app, 'a')
    await postMessage(app, { text: 'a', repoId: repo, intent: 'new' })
    await postMessage(app, { text: 'b', repoId: repo })
    expect(seen).toEqual([true, false])
  })

  it('follow_up without a reference is 400', async () => {
    const { store, app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    const res = await post(app, { text: 'x', repoId: repo, intent: 'follow_up' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'follow_up_needs_reference' })
    expect(store.messages.list()).toHaveLength(0)
  })

  it('new with a reference is 400, and an unknown intent is 400', async () => {
    const { store, app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    const first = await postMessage(app, { text: 'one', repoId: repo })
    const refused = await post(app, {
      text: 'x',
      repoId: repo,
      intent: 'new',
      referencesWorkItem: first.workItemId,
    })
    expect(refused.statusCode).toBe(400)
    expect(refused.json()).toMatchObject({ error: 'new_refuses_reference' })
    expect((await post(app, { text: 'x', repoId: repo, intent: 'later' })).statusCode).toBe(400)
    expect(store.messages.list()).toHaveLength(1)
  })
})

describe('repo reads', () => {
  it('GET work and chat filter by repo', async () => {
    const { app } = makeServer()
    track(app)
    const repoA = await registerRepo(app, 'a')
    const repoB = await registerRepo(app, 'b')
    const a = await postMessage(app, { text: 'in a', repoId: repoA })
    const b = await postMessage(app, { text: 'in b', repoId: repoB })
    const get = async (url: string) => (await app.inject({ method: 'GET', url })).json() as { id: string }[]
    expect((await get(`/api/work?repoId=${repoB}`)).map((row) => row.id)).toEqual([b.workItemId])
    expect((await get(`/api/chat/messages?repoId=${repoA}`)).map((row) => row.id)).toEqual([a.messageId])
  })

  it('unknown repoId on GET is 400', async () => {
    const { app } = makeServer()
    track(app)
    for (const url of ['/api/work?repoId=repo_nope', '/api/chat/messages?repoId=repo_nope']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'unknown_repo' })
    }
  })

  it('repoId=unassigned returns only rows with no repo', async () => {
    const { store, app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    await postMessage(app, { text: 'in a', repoId: repo })
    store.atomic(() => {
      store.messages.save({ id: 'msg_legacy', text: 'old', createdAt: AT })
      store.workItems.save({ id: 'wi_legacy', state: 'stopped', originMessageId: 'msg_legacy' })
    })
    const get = async (url: string) => (await app.inject({ method: 'GET', url })).json() as { id: string }[]
    expect((await get('/api/work?repoId=unassigned')).map((row) => row.id)).toEqual(['wi_legacy'])
    expect((await get('/api/chat/messages?repoId=unassigned')).map((row) => row.id)).toEqual(['msg_legacy'])
  })

  it('repoId=unassigned beside another repoId is the same 400, not the Unassigned rows', async () => {
    const { app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    const queries = [
      `repoId=unassigned&repoId=${repo}`,
      `repoId=unassigned&repoId[]=${repo}`,
      `repoId=unassigned&repoId%5B%5D=${repo}`,
      `repoId=unassigned&repoId[0]=${repo}`,
      'repoId[]=unassigned',
    ]
    for (const route of ['/api/work', '/api/chat/messages']) {
      for (const query of queries) {
        const res = await app.inject({ method: 'GET', url: `${route}?${query}` })
        expect(res.statusCode, `${route}?${query}`).toBe(400)
        expect(res.json(), `${route}?${query}`).toMatchObject({ error: 'unknown_repo' })
      }
    }
  })

  it('a work row is titled from the first line of its origin message', async () => {
    const { app } = makeServer()
    track(app)
    const repo = await registerRepo(app, 'a')
    await postMessage(app, { text: `  ${'y'.repeat(100)}\nsecond line`, repoId: repo, intent: 'new' })
    await postMessage(app, { text: 'Fix the login\n\nIt fails on Safari', repoId: repo, intent: 'new' })
    const rows = (await app.inject({ method: 'GET', url: `/api/work?repoId=${repo}` })).json() as {
      title?: string
    }[]
    expect(rows.map((row) => row.title)).toEqual(['y'.repeat(80), 'Fix the login'])
  })

  it('a work row with no origin message has no title rather than an id', async () => {
    const { store, app } = makeServer()
    track(app)
    store.atomic(() => store.workItems.save({ id: 'wi_bare', state: 'admitted' }))
    const [row] = (await app.inject({ method: 'GET', url: '/api/work' })).json() as { title?: string }[]
    expect(row).toBeDefined()
    expect(row?.title).toBeUndefined()
  })
})

describe('buildServer', () => {
  it('GET /healthz answers ok', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('admits a message with nothing live as new work', async () => {
    const { store, app } = makeServer()
    const repoId = await registerRepo(track(app), 'a')
    const body = await postMessage(app, { text: 'ship the smoke test', repoId })
    expect(body.messageId).toMatch(/^msg_/)
    expect(body.workItemId).toMatch(/^wi_/)
    expect(body.routing).toBe('new_work')

    const item = store.workItems.get(body.workItemId!) as StoreDoc
    expect(item.state).toBe('admitted')
    expect((item.mandate as { originMessageId?: string }).originMessageId).toBe(body.messageId)
    expect(store.events.read(`work:${body.workItemId}`).map((event) => event.type)).toEqual(['work_admitted'])
    expect(store.messages.get(body.messageId)?.text).toBe('ship the smoke test')
  })

  it('attaches a referencing message without creating a second work item', async () => {
    const { store, app } = makeServer()
    const repoId = await registerRepo(track(app), 'a')
    const first = await postMessage(app, { text: 'ship the smoke test', repoId })
    const second = await postMessage(app, {
      text: 'and the fixtures',
      repoId,
      referencesWorkItem: first.workItemId,
    })

    expect(second.routing).toBe('attach')
    expect(second.workItemId).toBe(first.workItemId)
    expect(store.workItems.list()).toHaveLength(1)
    expect(store.events.read(`work:${first.workItemId}`).map((event) => event.type)).toEqual([
      'work_admitted',
      'message_attached',
    ])
  })

  it('replays the same answer for a repeated idempotency key', async () => {
    const { store, app } = makeServer()
    const repoId = await registerRepo(track(app), 'a')
    const first = await postMessage(app, { text: 'ship it', repoId }, { 'x-idempotency-key': 'k1' })
    const replay = await postMessage(app, { text: 'ship it', repoId }, { 'x-idempotency-key': 'k1' })

    expect(replay.messageId).toBe(first.messageId)
    expect(replay.workItemId).toBe(first.workItemId)
    expect(replay.routing).toBe('duplicate')
    expect(store.messages.list()).toHaveLength(1)
  })

  it('a message with no live work and no reference starts work even after one item is done', async () => {
    const { store, app } = makeServer()
    const repoId = await registerRepo(track(app), 'a')
    const first = await postMessage(app, { text: 'first', repoId })
    const item = store.workItems.get(first.workItemId!) as StoreDoc
    item.state = 'done'
    store.workItems.save(item)

    const second = await postMessage(app, { text: 'second', repoId })
    expect(second.routing).toBe('new_work')
    expect(second.workItemId).not.toBe(first.workItemId)
  })

  it('lists pending confirmations as inbox cards and resolves an approve exactly once', async () => {
    const { store, app } = makeServer()
    const server = track(app)
    store.confirmations.save(pendingConfirmation('conf_install_1') as unknown as StoreDoc)
    store.confirmations.save(pendingConfirmation('conf_install_2') as unknown as StoreDoc)

    const inbox = await server.inject({ method: 'GET', url: '/api/inbox' })
    expect(inbox.statusCode).toBe(200)
    const cards = inbox.json() as Array<{ id: string; cls: string; operationHash: string; expiresAt: string }>
    expect(cards.map((card) => card.id)).toEqual(['conf_install_1', 'conf_install_2'])
    expect(cards[0]).toMatchObject({ cls: 'install', operationHash: 'f'.repeat(64) })

    const resolved = await server.inject({
      method: 'POST',
      url: '/api/inbox/conf_install_1/resolve',
      payload: { answer: 'approve' },
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json()).toEqual({ id: 'conf_install_1', status: 'approved' })
    expect(store.confirmations.get('conf_install_1')?.status).toBe('approved')

    const again = await server.inject({
      method: 'POST',
      url: '/api/inbox/conf_install_1/resolve',
      payload: { answer: 'deny' },
    })
    expect(again.statusCode).toBe(409)
    expect(store.confirmations.get('conf_install_1')?.status).toBe('approved')
  })

  it('rejects a resolve with a bad answer or an unknown id', async () => {
    const { app } = makeServer()
    const server = track(app)
    const bad = await server.inject({
      method: 'POST',
      url: '/api/inbox/conf_x/resolve',
      payload: { answer: 'maybe' },
    })
    expect(bad.statusCode).toBe(400)
    const missing = await server.inject({
      method: 'POST',
      url: '/api/inbox/conf_missing/resolve',
      payload: { answer: 'approve' },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('GET /api/status answers the exact snapshot shape mec status parses', async () => {
    const { store, app } = makeServer()
    const server = track(app)

    const before = parseHealthSnapshot(
      JSON.stringify((await server.inject({ method: 'GET', url: '/api/status' })).json()),
    )
    expect(before).not.toBeNull()
    expect(before?.runtime).toEqual({ state: 'ready', instances: 1, answering: true })
    expect(before?.setup).toEqual({ has_slot: false, has_repository: false })
    expect(before?.parts['effects:launch']).toEqual({ state: 'ok' })

    store.slots.save({ id: 'slot_alpha', state: 'healthy' })
    store.engines.save({ id: 'settings/repositories', repositories: [] })
    const after = parseHealthSnapshot(
      JSON.stringify((await server.inject({ method: 'GET', url: '/api/status' })).json()),
    )
    expect(after?.setup).toEqual({ has_slot: true, has_repository: true })
  })

  it('GET /api/work lists work items with task counts and stages', async () => {
    const { store, app } = makeServer()
    const server = track(app)
    const repoId = await registerRepo(app, 'a')
    const { workItemId } = await postMessage(app, { text: 'ship the smoke test', repoId })
    store.tasks.save({ id: 'task_a', workItemId: workItemId!, status: 'ready' })
    store.tasks.save({ id: 'task_b', workItemId: workItemId!, status: 'active' })

    const res = await server.inject({ method: 'GET', url: '/api/work' })
    expect(res.statusCode).toBe(200)
    const items = res.json() as Array<{
      id: string
      state: string
      stage: string
      taskCounts: { total: number; byStatus: Record<string, number> }
    }>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: workItemId,
      state: 'admitted',
      stage: 'admitted',
      taskCounts: { total: 2, byStatus: { ready: 1, active: 1 } },
    })
  })

  it('GET /api/chat/messages lists newest-last', async () => {
    const { app } = makeServer()
    const server = track(app)
    const repoId = await registerRepo(app, 'a')
    const first = await postMessage(app, { text: 'first', repoId })
    const second = await postMessage(app, { text: 'second', repoId, referencesWorkItem: first.workItemId })

    const res = await server.inject({ method: 'GET', url: '/api/chat/messages' })
    expect(res.statusCode).toBe(200)
    const messages = res.json() as Array<{ id: string; text: string }>
    expect(messages.map((message) => message.id)).toEqual([first.messageId, second.messageId])
  })

  it('GET /api/events streams the backlog as SSE with an id line', async () => {
    const { store, app } = makeServer()
    store.events.append('work:wi_fixture', {
      stream: 'work:wi_fixture',
      seq: 1,
      at: AT,
      type: 'work_admitted',
      body: { workItemId: 'wi_fixture' },
    })
    const res = await track(app).inject({ method: 'GET', url: '/api/events?stream=work:wi_fixture' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.body).toContain('id: work:wi_fixture:1\n')
    expect(res.body).toContain('"type":"work_admitted"')
  })

  it('GET /api/events without a stream is a 400', async () => {
    const res = await track(makeServer().app).inject({ method: 'GET', url: '/api/events' })
    expect(res.statusCode).toBe(400)
  })
})

describe('inbox resolve binds to the card input (audit #5)', () => {
  it('approves a repo-bound confirmation carrying an inputSha', async () => {
    const { app, store } = makeServer()
    store.atomic(() => {
      store.confirmations.save({
        id: 'conf_bound_1',
        cls: 'install',
        operationHash: 'op-hash',
        inputSha: '0123456789abcdef0123456789abcdef01234567',
        status: 'pending',
        createdAt: '2026-11-03T10:00:00.000Z',
        expiresAt: '2999-01-01T00:00:00.000Z',
      })
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/inbox/conf_bound_1/resolve',
      payload: { answer: 'approve' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'conf_bound_1', status: 'approved' })
  })
})

describe('owner commands (M1.4a, §12.5, decision #20)', () => {
  const executing = (store: Store, id = 'wi_1', extra: StoreDoc = {}): void => {
    store.atomic(() => {
      store.engines.save({ id: 'repo_a', url: 'https://example.test/a' })
      store.workItems.save({
        id,
        state: 'executing',
        repoId: 'repo_a',
        mandate: { originMessageId: 'msg_1' },
        ...extra,
      })
    })
  }

  const post = (app: ReturnType<typeof buildServer>, url: string, body?: unknown) =>
    app.inject({ method: 'POST', url, ...(body !== undefined && { payload: body as object }) })

  const pauseControl = () => {
    let paused = false
    return {
      pause: () => {
        paused = true
      },
      resume: () => {
        paused = false
      },
      isPaused: () => paused,
    }
  }

  const fixture = (extra: Partial<ServerDeps> = {}) => {
    const store: Store = new MemoryRepositories()
    const app = buildServer({
      store,
      effects: store.effects,
      health: new FakeHealthBoard(),
      policyText: '{"preAuthorised":{}}',
      now: () => new Date(AT),
      ...extra,
    })
    return { store, app }
  }

  it('stop works with no meta agent', async () => {
    const { store, app } = fixture()
    executing(store)

    const res = await post(app, '/api/work/wi_1/stop')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'wi_1', status: 'stopped' })
    expect(store.workItems.get('wi_1')?.state).toBe('stopped')
  })

  it('stop withdraws the mandate', async () => {
    const { store, app } = fixture()
    executing(store)

    await post(app, '/api/work/wi_1/stop')
    const again = await post(app, '/api/work/wi_1/stop')

    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ id: 'wi_1', status: 'stopped' })
    expect(store.workItems.get('wi_1')?.mandate).toMatchObject({ status: 'withdrawn' })
  })

  it('stop on done work is 409', async () => {
    const { store, app } = fixture()
    executing(store, 'wi_1', { state: 'done' })

    const res = await post(app, '/api/work/wi_1/stop')

    expect(res.statusCode).toBe(409)
    expect(store.workItems.get('wi_1')?.state).toBe('done')
  })

  it('stop, hold and lift on an unknown id are 404', async () => {
    const { app } = fixture()
    for (const verb of ['stop', 'hold', 'lift']) {
      expect((await post(app, `/api/work/wi_none/${verb}`)).statusCode).toBe(404)
    }
  })

  it('hold then lift over HTTP', async () => {
    const { store, app } = fixture()
    const stopWork = vi.fn(() => 'stopped' as const)
    const liftHold = vi.fn(() => {
      const doc = store.workItems.get('wi_1')!
      store.atomic(() => store.workItems.save({ ...doc, hold: { ...(doc.hold as object), liftedAt: AT } }))
      return { status: 'lifted' as const, launches: ['att_1', 'att_2'] }
    })
    const composed = fixture({
      store,
      metaAgent: {
        onUserMessage: vi.fn(),
        stopWork,
        liftHold,
      } as unknown as ServerDeps['metaAgent'],
    })
    executing(store)

    const held = await post(composed.app, '/api/work/wi_1/hold', { reason: 'wait' })
    expect(held.statusCode).toBe(200)
    expect(held.json()).toEqual({ id: 'wi_1', status: 'held' })
    const rows = (await app.inject({ method: 'GET', url: '/api/work' })).json() as { held: boolean }[]
    expect(rows[0]?.held).toBe(true)

    const lifted = await post(composed.app, '/api/work/wi_1/lift')
    expect(lifted.statusCode).toBe(200)
    expect(lifted.json()).toEqual({ id: 'wi_1', status: 'lifted', launches: 2 })
    const after = (await app.inject({ method: 'GET', url: '/api/work' })).json() as { held: boolean }[]
    expect(after[0]?.held).toBe(false)
  })

  it('a hold reason is redacted before it is stored', async () => {
    const { store, app } = fixture()
    executing(store)
    const key = `sk-ant-api03-${'a'.repeat(40)}`

    await post(app, '/api/work/wi_1/hold', { reason: `wait ${key}` })

    expect(JSON.stringify(store.workItems.get('wi_1'))).not.toContain(key)
    expect(JSON.stringify(store.events.read('work:wi_1'))).not.toContain(key)
  })

  it('hold on stopped work is 409 terminal', async () => {
    const { store, app } = fixture()
    executing(store, 'wi_1', { state: 'stopped' })

    const res = await post(app, '/api/work/wi_1/hold')

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'terminal' })
  })

  it('a refused lift is 409 with the reason and keeps the hold', async () => {
    const { store } = fixture()
    const { app } = fixture({
      store,
      metaAgent: {
        onUserMessage: vi.fn(),
        liftHold: () => ({ status: 'refused', error: 'mandate_withdrawn' }),
      } as unknown as ServerDeps['metaAgent'],
    })
    executing(store, 'wi_1', { hold: { reason: 'wait', at: AT } })

    const res = await post(app, '/api/work/wi_1/lift')

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'mandate_withdrawn' })
  })

  it('lift with no meta agent: a free item is free, a held one stays held', async () => {
    const { store, app } = fixture()
    executing(store)
    executing(store, 'wi_2', { hold: { reason: 'wait', at: AT } })

    const free = await post(app, '/api/work/wi_1/lift')
    expect(free.json()).toEqual({ id: 'wi_1', status: 'free', launches: 0 })

    const held = await post(app, '/api/work/wi_2/lift')
    expect(held.statusCode).toBe(409)
    expect(held.json()).toEqual({ error: 'no_meta_agent' })
    expect(store.workItems.get('wi_2')?.hold).toEqual({ reason: 'wait', at: AT })
  })

  it('pause and resume are idempotent and read back', async () => {
    const control = pauseControl()
    const { app } = fixture({ pauseControl: control })

    for (let i = 0; i < 2; i += 1) {
      const res = await post(app, '/api/processing/pause')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'paused' })
    }
    expect(control.isPaused()).toBe(true)
    for (let i = 0; i < 2; i += 1) {
      expect((await post(app, '/api/processing/resume')).json()).toEqual({ status: 'running' })
    }
    expect(control.isPaused()).toBe(false)
  })

  it('pause and resume are 404 with no pause control', async () => {
    const { app } = fixture()
    expect((await post(app, '/api/processing/pause')).statusCode).toBe(404)
    expect((await post(app, '/api/processing/resume')).statusCode).toBe(404)
  })

  it('GET /api/processing reads the stored doc', async () => {
    const { store, app } = fixture()
    expect((await app.inject({ method: 'GET', url: '/api/processing' })).json()).toEqual({ paused: false })

    store.atomic(() => {
      store.engines.save({ id: 'settings/processing', paused: true, pausedAt: AT, updatedAt: AT })
    })

    expect((await app.inject({ method: 'GET', url: '/api/processing' })).json()).toEqual({
      paused: true,
      pausedAt: AT,
    })
  })

  it('/api/status reports paused', async () => {
    const { store, app } = fixture()
    store.atomic(() => {
      store.engines.save({ id: 'settings/processing', paused: true, pausedAt: AT, updatedAt: AT })
    })

    const status = (await app.inject({ method: 'GET', url: '/api/status' })).json() as {
      runtime: { state: string }
    }

    expect(status.runtime.state).toBe('paused')
    expect(parseHealthSnapshot(JSON.stringify(status))?.runtime.state).toBe('paused')
  })
})

describe('durable commands at the routes (M1.4b, §12.1, §17, §20)', () => {
  const planned: MetaDecision = {
    ack: 'On it',
    plan: { tasks: [{ taskId: 'a', objective: 'Do a', dependsOn: [], role: 'implementer' }] },
  }

  /** A real service over a brain that stays on its await until the test answers. */
  const realService = () => {
    const answers: ((decision: MetaDecision) => void)[] = []
    let calls = 0
    const brain: MetaBrain = () => {
      calls += 1
      return new Promise((resolve) => answers.push(resolve))
    }
    let service: MetaAgentService | undefined
    const server = makeServer((store) => {
      service = new MetaAgentService({ store, effects: store.effects, brain })
      return service
    })
    track(server.app)
    return {
      ...server,
      service: service!,
      calls: () => calls,
      answer: (decision: MetaDecision) => answers.shift()!(decision),
    }
  }

  const untilBrainCalled = async (calls: () => number, count: number): Promise<void> => {
    await vi.waitFor(() => expect(calls()).toBe(count))
  }

  const relayRows = (store: Store): { key: string; payload: Json }[] =>
    (store.effects as unknown as { snapshot(): [string, { kind: string; key: string; payload: Json }][] })
      .snapshot()
      .map(([, row]) => row)
      .filter((row) => row.kind === 'relay')

  it('retry during planning admits once', async () => {
    const { app, store, calls, answer } = realService()
    const repoId = await registerRepo(app, 'one')
    const headers = { 'x-idempotency-key': 'k1' }
    const payload = { text: 'ship it', repoId }

    const first = app.inject({ method: 'POST', url: '/api/chat/messages', payload, headers })
    await untilBrainCalled(calls, 1)
    const retry = await postMessage(app, payload, headers)

    // The retry answers at once from the stored doc: a request never waits on another's turn.
    expect(retry.routing).toBe('duplicate')
    expect(calls()).toBe(1)
    answer(planned)
    const body = (await first).json() as { messageId: string; workItemId: string; routing: string }

    expect(body.messageId).toBe(stableMessageId('k1'))
    expect(retry.messageId).toBe(body.messageId)
    expect(retry.workItemId).toBe(body.workItemId)
    expect(body.routing).toBe('new_work')
    expect(store.messages.list()).toHaveLength(1)
    expect(store.workItems.list()).toHaveLength(1)
  })

  it('the idempotency key is stored before the brain returns', async () => {
    const { app, store, calls, answer } = realService()
    const repoId = await registerRepo(app, 'one')

    const first = app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'ship it', repoId },
      headers: { 'x-idempotency-key': 'k1' },
    })
    await untilBrainCalled(calls, 1)

    expect(store.messages.list({ idempotencyKey: 'k1' })).toHaveLength(1)
    answer(planned)
    await first
    expect(store.messages.list({ idempotencyKey: 'k1' })).toHaveLength(1)
  })

  const planningWithQuestion = async (server: ReturnType<typeof realService>) => {
    const { app, calls, answer } = server
    const repoId = await registerRepo(app, 'one')
    const first = app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'ship it', repoId },
    })
    await untilBrainCalled(calls, 1)
    answer({
      ack: 'Which one?',
      questions: [{ id: 'q_1', question: 'Which one?', options: ['a', 'b'], at: AT }],
    })
    await first
  }

  it('POST answer wakes the real service once', async () => {
    const server = realService()
    const { app, store, service, calls, answer } = server
    await planningWithQuestion(server)

    const res = await app.inject({
      method: 'POST',
      url: '/api/questions/q_1/answer',
      payload: { answer: 'a' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'q_1', status: 'answered', answer: 'a' })
    const rows = relayRows(store)
    expect(rows.map((row) => row.key)).toEqual(['wake:question/q_1'])
    const turn = service.runRelay(rows[0]!.payload)
    await untilBrainCalled(calls, 2)
    answer({ ack: 'Understood' })
    await turn
    await service.runRelay(rows[0]!.payload)
    expect(calls()).toBe(2)
  })

  it('POST answer returns before the planner turn finishes', async () => {
    const server = realService()
    const { app, calls } = server
    await planningWithQuestion(server)

    const res = await app.inject({
      method: 'POST',
      url: '/api/questions/q_1/answer',
      payload: { answer: 'a' },
    })

    expect(res.statusCode).toBe(200)
    expect(calls()).toBe(1)
  })

  it('a second POST answer is a 409 and queues nothing more', async () => {
    const server = realService()
    const { app, store } = server
    await planningWithQuestion(server)
    const post = (answer: string) =>
      app.inject({ method: 'POST', url: '/api/questions/q_1/answer', payload: { answer } })

    await post('a')
    const second = await post('b')

    expect(second.statusCode).toBe(409)
    expect(store.engines.get('question/q_1')?.answer).toBe('a')
    expect(relayRows(store)).toHaveLength(1)
  })

  it('a key-shaped answer is stored redacted with no meta agent too', async () => {
    const server = makeServer()
    const secret = `sk-ant-api03-${'a'.repeat(40)}`
    server.store.atomic(() => {
      server.store.engines.save({ id: 'question/q_1', questionId: 'q_1', question: 'Q?', status: 'open' })
    })

    const res = await track(server.app).inject({
      method: 'POST',
      url: '/api/questions/q_1/answer',
      payload: { answer: secret },
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(secret)
    expect(JSON.stringify(server.store.engines.get('question/q_1'))).not.toContain(secret)
    expect(JSON.stringify(server.store.events.read('question/q_1'))).not.toContain(secret)
  })

  it('a message during a pause is recorded and spends no planner turn (decision #27)', async () => {
    const { app, store, calls } = realService()
    const repoId = await registerRepo(app, 'one')
    store.atomic(() => saveProcessing(store, { paused: true, pausedAt: AT }, AT))

    const body = await postMessage(app, { text: 'ship it', repoId })

    expect(calls()).toBe(0)
    expect(store.messages.get(body.messageId)).toMatchObject({ text: 'ship it', routing: 'new_work' })
  })
})
