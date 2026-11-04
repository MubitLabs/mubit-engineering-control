import type { HealthBoard, HealthClaim, HealthName, Store } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, type ServerDeps } from '../src/server'

/**
 * The T5/T7 planner routes (review 2026-11-04 §5.2/§7): the question surface ask_user
 * creates, the answer route that wakes the planner, and Chat's Setup mode — served
 * honestly from the store, with the decision-card evidence mapped from what exists.
 */

const AT = '2026-11-04T12:00:00.000Z'

/** A HealthBoard double shaped like HealthBoardImpl: one mutable entry per claim. */
class FakeHealthBoard implements HealthBoard {
  readonly entries = new Map<HealthName, { state: string; detail?: string }>()

  claim(name: HealthName): HealthClaim {
    const entry = { state: 'starting' }
    this.entries.set(name, entry)
    return {
      starting: () => {},
      ready: () => {
        entry.state = 'ready'
      },
      paused: () => {},
      error: () => {},
    }
  }
}

const apps: FastifyInstance[] = []

function makeServer(deps: Partial<ServerDeps> = {}): { store: Store; app: FastifyInstance } {
  const store: Store = new MemoryRepositories()
  const serverDeps: ServerDeps = {
    store,
    effects: store.effects,
    health: new FakeHealthBoard(),
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    ...deps,
  }
  const app = buildServer(serverDeps)
  apps.push(app)
  return { store, app }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const seedQuestion = (store: Store, over: Record<string, unknown> = {}) => {
  store.atomic(() => {
    store.engines.save({
      id: 'question/q_1',
      questionId: 'q_1',
      question: 'Which provider should the reviewer run on?',
      options: ['claude', 'opencode'],
      status: 'open',
      forMessageId: 'msg_1',
      workItemId: 'wi_1',
      askedAt: AT,
      createdAt: AT,
      updatedAt: AT,
      ...over,
    })
  })
}

describe('GET /api/questions', () => {
  it('serves open and answered questions with the evidence mapping, nothing invented', async () => {
    const { store, app } = makeServer()
    seedQuestion(store)
    seedAnswered(store)

    const response = await app.inject({ method: 'GET', url: '/api/questions' })
    expect(response.statusCode).toBe(200)
    const body = (await response.json()) as Array<Record<string, unknown>>
    expect(body).toHaveLength(2)
    const open = body.find((row) => row.status === 'open')
    expect(open).toMatchObject({
      id: 'q_1',
      question: 'Which provider should the reviewer run on?',
      options: ['claude', 'opencode'],
      status: 'open',
      workItemId: 'wi_1',
      forMessageId: 'msg_1',
    })
    // The decision-card evidence: mapped from what exists, honest about what does not.
    expect(open?.evidence).toEqual({
      what: 'Which provider should the reviewer run on?',
      why: 'asked for message msg_1',
      facts: ['claude', 'opencode'],
      consequences: 'unknown — not recorded in this build',
    })
    const answered = body.find((row) => row.status === 'answered')
    expect(answered?.answer).toBe('opencode, please')
  })

  it('an empty store serves an empty list, not an error', async () => {
    const { app } = makeServer()
    const response = await app.inject({ method: 'GET', url: '/api/questions' })
    expect(response.statusCode).toBe(200)
    expect(await response.json()).toEqual([])
  })
})

function seedAnswered(store: Store) {
  store.atomic(() => {
    store.engines.save({
      id: 'question/q_2',
      questionId: 'q_2',
      question: 'Stop or hold the audit work?',
      options: ['stop', 'hold'],
      status: 'answered',
      answer: 'opencode, please',
      answeredAt: AT,
      createdAt: AT,
      updatedAt: AT,
    })
  })
}

describe('POST /api/questions/:id/answer', () => {
  it('records the first answer, wakes the planner, and refuses a second', async () => {
    const woke: { questionId: string; answer: string }[] = []
    const { store, app } = makeServer({
      metaAgent: {
        onUserMessage: async () => ({
          acknowledged: 'On it',
          tasksCreated: 0,
          launchesEnqueued: [],
          escalated: false,
        }),
        onQuestionAnswered: async (questionId, answer) => {
          woke.push({ questionId, answer })
          return { status: 'answered' }
        },
      },
    })
    seedQuestion(store)

    const first = await app.inject({
      method: 'POST',
      url: '/api/questions/q_1/answer',
      payload: { answer: 'claude' },
    })
    expect(first.statusCode).toBe(200)
    const body = (await first.json()) as Record<string, unknown>
    expect(body).toMatchObject({ id: 'q_1', status: 'answered', answer: 'claude' })
    expect(woke).toEqual([{ questionId: 'q_1', answer: 'claude' }])
    expect(store.engines.get('question/q_1')?.status).toBe('answered')

    const second = await app.inject({
      method: 'POST',
      url: '/api/questions/q_1/answer',
      payload: { answer: 'opencode' },
    })
    expect(second.statusCode).toBe(409)
    expect((await second.json()) as Record<string, unknown>).toMatchObject({ error: 'already_answered' })
  })

  it('a question the wake-less meta agent cannot answer still records the answer honestly', async () => {
    const { store, app } = makeServer({
      metaAgent: {
        onUserMessage: async () => ({
          acknowledged: 'On it',
          tasksCreated: 0,
          launchesEnqueued: [],
          escalated: false,
        }),
      },
    })
    seedQuestion(store)
    const response = await app.inject({
      method: 'POST',
      url: '/api/questions/q_1/answer',
      payload: { answer: 'hold' },
    })
    expect(response.statusCode).toBe(200)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ status: 'answered' })
    expect(store.engines.get('question/q_1')?.status).toBe('answered')
  })

  it('validates: empty answer 400, unknown question 404', async () => {
    const { store, app } = makeServer()
    seedQuestion(store)
    const empty = await app.inject({
      method: 'POST',
      url: '/api/questions/q_1/answer',
      payload: { answer: '  ' },
    })
    expect(empty.statusCode).toBe(400)
    const missing = await app.inject({
      method: 'POST',
      url: '/api/questions/q_x/answer',
      payload: { answer: 'x' },
    })
    expect(missing.statusCode).toBe(404)
  })
})

describe('Chat Setup mode (T7)', () => {
  it('body.setup === true routes to the setup agent, not the work planner', async () => {
    let planned = 0
    const { app } = makeServer({
      metaAgent: {
        onUserMessage: async () => {
          planned += 1
          return { acknowledged: 'On it', tasksCreated: 1, launchesEnqueued: [], escalated: false }
        },
      },
      setupAgent: {
        handleMessage: async ({ text }) => ({
          reply: `Setup heard: ${text}`,
          calls: [],
          drafts: [],
          applied: [],
        }),
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'check my slots', setup: true },
      headers: { 'x-mec-client': '1', origin: 'http://127.0.0.1:5173' },
    })
    expect(response.statusCode).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ mode: 'setup', reply: 'Setup heard: check my slots' })
    expect(planned).toBe(0)
  })

  it('a plain message (no setup flag) still plans as before', async () => {
    const { app } = makeServer({
      metaAgent: {
        onUserMessage: async () => ({
          acknowledged: 'On it: planning',
          workItemId: 'wi_new',
          tasksCreated: 2,
          launchesEnqueued: [],
          escalated: false,
        }),
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { text: 'add the audit view' },
      headers: { 'x-mec-client': '1', origin: 'http://127.0.0.1:5173' },
    })
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ routing: 'new_work', acknowledged: 'On it: planning', tasksCreated: 2 })
  })
})
