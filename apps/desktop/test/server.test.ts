import type { HealthBoard, HealthClaim, HealthName, Store, StoreDoc } from '@mec/contracts'
import { type ConfirmationRecord, openConfirmation } from '@mec/policy'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
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

function makeServer(): { store: Store; app: ReturnType<typeof buildServer> } {
  const store: Store = new MemoryRepositories()
  const health = new FakeHealthBoard()
  health.claim('effects:launch').ready()
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
  }
  return { store, app: buildServer(deps) }
}

function pendingConfirmation(id: string): ConfirmationRecord {
  return openConfirmation({
    id,
    cls: 'push',
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

describe('buildServer', () => {
  it('GET /healthz answers ok', async () => {
    const { app } = makeServer()
    const res = await track(app).inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('admits a message with nothing live as new work', async () => {
    const { store, app } = makeServer()
    const body = await postMessage(track(app), { text: 'ship the smoke test' })
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
    const first = await postMessage(track(app), { text: 'ship the smoke test' })
    const second = await postMessage(app, { text: 'and the fixtures', referencesWorkItem: first.workItemId })

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
    const first = await postMessage(track(app), { text: 'ship it' }, { 'x-idempotency-key': 'k1' })
    const replay = await postMessage(app, { text: 'ship it' }, { 'x-idempotency-key': 'k1' })

    expect(replay.messageId).toBe(first.messageId)
    expect(replay.workItemId).toBe(first.workItemId)
    expect(replay.routing).toBe('duplicate')
    expect(store.messages.list()).toHaveLength(1)
  })

  it('a message with no live work and no reference starts work even after one item is done', async () => {
    const { store, app } = makeServer()
    const first = await postMessage(track(app), { text: 'first' })
    const item = store.workItems.get(first.workItemId!) as StoreDoc
    item.state = 'done'
    store.workItems.save(item)

    const second = await postMessage(app, { text: 'second' })
    expect(second.routing).toBe('new_work')
    expect(second.workItemId).not.toBe(first.workItemId)
  })

  it('lists pending confirmations as inbox cards and resolves an approve exactly once', async () => {
    const { store, app } = makeServer()
    const server = track(app)
    store.confirmations.save(pendingConfirmation('conf_push_1') as unknown as StoreDoc)
    store.confirmations.save(pendingConfirmation('conf_push_2') as unknown as StoreDoc)

    const inbox = await server.inject({ method: 'GET', url: '/api/inbox' })
    expect(inbox.statusCode).toBe(200)
    const cards = inbox.json() as Array<{ id: string; cls: string; operationHash: string; expiresAt: string }>
    expect(cards.map((card) => card.id)).toEqual(['conf_push_1', 'conf_push_2'])
    expect(cards[0]).toMatchObject({ cls: 'push', operationHash: 'f'.repeat(64) })

    const resolved = await server.inject({
      method: 'POST',
      url: '/api/inbox/conf_push_1/resolve',
      payload: { answer: 'approve' },
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json()).toEqual({ id: 'conf_push_1', status: 'approved' })
    expect(store.confirmations.get('conf_push_1')?.status).toBe('approved')

    const again = await server.inject({
      method: 'POST',
      url: '/api/inbox/conf_push_1/resolve',
      payload: { answer: 'deny' },
    })
    expect(again.statusCode).toBe(409)
    expect(store.confirmations.get('conf_push_1')?.status).toBe('approved')
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
    const { workItemId } = await postMessage(app, { text: 'ship the smoke test' })
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
    const first = await postMessage(app, { text: 'first' })
    const second = await postMessage(app, { text: 'second', referencesWorkItem: first.workItemId })

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
    expect(res.body).toContain('id: 1\n')
    expect(res.body).toContain('"type":"work_admitted"')
  })

  it('GET /api/events without a stream is a 400', async () => {
    const res = await track(makeServer().app).inject({ method: 'GET', url: '/api/events' })
    expect(res.statusCode).toBe(400)
  })
})
