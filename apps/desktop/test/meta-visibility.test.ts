import type { HealthBoard } from '@mec/contracts'
import { MetaAgentService, type MetaDecision, saveProcessing } from '@mec/meta'
import { InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server'

/**
 * What the meta agent is doing and who holds the work: read from what is recorded, through the
 * real `buildServer` over a real `SqliteStore`. Nothing here mocks its own unit.
 */

const AT = '2026-11-06T12:00:00.000Z'
const LATER = '2026-11-06T12:05:00.000Z'
const WI = 'wi_1'

const quietHealth = {
  claim: () => ({ starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }),
  names: () => [],
  entry: () => undefined,
} as unknown as HealthBoard

let db: Database.Database
let store: SqliteStore
let app: ReturnType<typeof buildServer>
let release: (() => void) | undefined

function serverWith(metaAgent?: MetaAgentService, now = LATER): ReturnType<typeof buildServer> {
  return buildServer({
    store,
    effects: store.effects,
    health: quietHealth,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(now),
    inspection: new InspectionReads(db),
    ...(metaAgent !== undefined && { metaAgent }),
  })
}

const service = (brain: unknown) =>
  new MetaAgentService({
    store,
    effects: store.effects,
    brain: brain as never,
    now: () => AT,
    policyText: '{"preAuthorised":{}}',
  })

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
  db = new Database(':memory:')
  migrate(db, MIGRATIONS_v1)
  store = new SqliteStore(db, { now: () => new Date(AT) })
  store.atomic(() => {
    store.engines.save({ id: 'repo_a', url: '/code/alpha', bootstrap: [], checks: [], trust: true })
    store.slots.save({ id: 'slot_a', label: 'preflight-a', engine: 'claude', state: 'healthy' })
    store.engines.save({ id: 'settings/meta-slot', slotId: 'slot_a' })
  })
  app = serverWith()
})

afterEach(async () => {
  release?.()
  release = undefined
  await app.close()
  db.close()
  delete process.env.MEC_FAKE_ENGINE
})

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json() as any
const metaOf = async () => (await get('/api/inspect/meta')).repositories[0]

const event = (stream: string, seq: number, type: string, body: object, at = AT) =>
  store.atomic(() => store.events.append(stream, { stream, seq, at, type, body: body as never }))

/** A question the meta agent took: planning, no tasks, and the acknowledgement on its message. */
function seedQuestion(id: string, answer?: string): void {
  store.atomic(() => {
    store.workItems.save({
      id,
      repoId: 'repo_a',
      state: 'planning',
      originMessageId: `msg_${id}`,
      createdAt: AT,
      updatedAt: AT,
    })
    store.messages.save({
      id: `msg_${id}`,
      repoId: 'repo_a',
      workItemId: id,
      text: 'what does this do?',
      routing: 'new_work',
      ackText: 'I will check and answer.',
      tasksCreated: 0,
      createdAt: AT,
      updatedAt: AT,
    })
  })
  if (answer !== undefined) {
    event(`work:${id}`, 1, 'result_reported', { workItemId: id, summary: answer, at: AT })
  }
}

/** Its turn has not ended: the receipt is what a finished turn writes. */
function withoutAck(id: string): void {
  store.atomic(() => {
    const { ackText: _ack, ...doc } = store.messages.get(`msg_${id}`)!
    store.messages.save(doc)
  })
}

const openQuestion = (workItemId: string) =>
  store.atomic(() =>
    store.engines.save({
      id: 'question/q1',
      questionId: 'q1',
      workItemId,
      repoId: 'repo_a',
      question: 'Which file?',
      status: 'open',
      askedAt: AT,
    }),
  )

function seedTask(status: string, extra: Record<string, unknown> = {}): void {
  store.atomic(() => {
    store.workItems.save({ id: WI, repoId: 'repo_a', state: 'executing', createdAt: AT, updatedAt: AT })
    store.tasks.save({
      id: 'task_1',
      workItemId: WI,
      repoId: 'repo_a',
      localKey: 'task_1',
      objective: 'Add wave.js',
      role: 'implementer',
      status,
      dependsOn: [],
      modelRequest: { tier: 'fast', reason: 'small' },
      createdAt: AT,
      updatedAt: AT,
      ...extra,
    })
  })
}

function seedDelegated(attempt: Record<string, unknown> = {}): void {
  seedTask('active')
  store.atomic(() => {
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_1',
      workItemId: WI,
      slotId: 'slot_a',
      state: 'running',
      generation: 1,
      engine: 'claude',
      resolved_model: 'haiku',
      placement: 'pinned to slot_a by the plan',
      createdAt: AT,
      updatedAt: AT,
      ...attempt,
    })
  })
}

describe('delegation is read from the attempts', () => {
  it('names who each task went to, why, and the model that really ran', async () => {
    seedDelegated()
    event('attempt:att_1', 1, 'session_started', { type: 'session_started', model: 'claude-haiku-5-5' })
    event('attempt:att_1', 2, 'tool_call', { type: 'tool_call', tool: 'Bash', ok: true }, LATER)
    event('attempt:att_1', 3, 'usage', { type: 'usage', input_tokens: 1, output_tokens: 1 }, LATER)
    const { delegation } = await get(`/api/inspect/work/${WI}`)
    expect(delegation).toHaveLength(1)
    expect(delegation[0]).toMatchObject({
      taskId: 'task_1',
      title: 'Add wave.js',
      role: 'implementer',
      status: 'active',
      requested: { tier: 'fast', model: null },
      attempts: 1,
      waiting: null,
      activity: { summary: 'Bash', at: LATER },
    })
    expect(delegation[0].latest).toMatchObject({
      id: 'att_1',
      state: 'running',
      placement: 'pinned to slot_a by the plan',
      actual: { model: 'claude-haiku-5-5', engine: 'claude', slotLabel: 'preflight-a' },
    })
  })

  it('a task nothing has picked up says so, and why it waits', async () => {
    seedTask('ready', { deferred: { reason: 'no_capacity', releases: 'capacity' } })
    const [row] = (await get(`/api/inspect/work/${WI}`)).delegation
    expect(row).toMatchObject({
      latest: null,
      attempts: 0,
      activity: null,
      waiting: 'no_capacity',
      requested: { tier: 'fast', model: null },
    })
  })

  it('the task view carries the placement reason too', async () => {
    seedDelegated()
    const task = await get('/api/inspect/tasks/task_1')
    expect(task.attempts[0].placement).toBe('pinned to slot_a by the plan')
  })
})

describe('a turn that ended with no plan is not work in progress', () => {
  it('an answered question is ended, and its answer is in the chat', async () => {
    seedQuestion('wi_q', 'It exports wave(name).')
    const row = await get('/api/inspect/work/wi_q')
    expect(row.stage).toEqual({ key: 'ended/answered', label: 'Answered', waitingOn: 'none' })
    expect(row.turnOutcome).toBe('answered')
    const [line] = await get('/api/chat/messages?repoId=repo_a')
    expect(line.replyText).toBe('It exports wave(name).')
  })

  it('a turn that stopped at its acknowledgement says no answer came, never Working', async () => {
    seedQuestion('wi_lost')
    const row = await get('/api/inspect/work/wi_lost')
    expect(row.stage).toEqual({ key: 'ended/no-answer', label: 'No answer', waitingOn: 'none' })
    expect(row.turnOutcome).toBe('no-answer')
    expect(row.reason).toBe('The meta agent stopped without answering')
    const [line] = await get('/api/chat/messages?repoId=repo_a')
    expect(line.replyText).toBeUndefined()
  })

  it('a planning item with a question open stays waiting for the person', async () => {
    seedQuestion('wi_ask')
    openQuestion('wi_ask')
    const row = await get('/api/inspect/work/wi_ask')
    expect(row.stage.key).toBe('person/decision')
    expect(row.turnOutcome).toBeNull()
  })

  it('a message still in its turn is neither answered nor lost', async () => {
    seedQuestion('wi_new')
    withoutAck('wi_new')
    const row = await get('/api/inspect/work/wi_new')
    expect(row.turnOutcome).toBeNull()
    expect(row.stage.key).toBe('working')
  })

  it('a report from another turn is not this message’s answer', async () => {
    seedQuestion('wi_other')
    event('work:wi_other', 1, 'result_reported', { summary: 'older', at: LATER }, LATER)
    expect((await get('/api/chat/messages?repoId=repo_a'))[0].replyText).toBeUndefined()
  })

  it('a reply carrying a key leaves redacted', async () => {
    seedQuestion('wi_key', 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const [line] = await get('/api/chat/messages?repoId=repo_a')
    expect(line.replyText).not.toContain('sk-ant-api03')
  })
})

describe('GET /api/inspect/meta', () => {
  it('says the meta connection, and an unknown model stays unknown', async () => {
    expect((await get('/api/inspect/meta')).connection).toEqual({
      slotLabel: 'preflight-a',
      engine: 'claude',
      model: null,
      modelAt: null,
    })
  })

  it('shows the model the last meta turn really started with', async () => {
    store.atomic(() =>
      store.engines.save({ id: 'meta/session', engine: 'claude', model: 'claude-opus-5-5', at: AT }),
    )
    expect((await get('/api/inspect/meta')).connection).toMatchObject({
      model: 'claude-opus-5-5',
      modelAt: AT,
    })
  })

  it('no slot chosen is no connection', async () => {
    store.atomic(() => store.engines.save({ id: 'settings/meta-slot' }))
    expect((await get('/api/inspect/meta')).connection).toBeNull()
  })

  it('idle says nothing is running, with the last real event', async () => {
    seedQuestion('wi_q', 'done')
    expect(await metaOf()).toMatchObject({
      repoId: 'repo_a',
      state: 'idle',
      line: 'Nothing is running',
      running: false,
      at: AT,
    })
  })

  it('an empty repository has no time to show', async () => {
    expect(await metaOf()).toMatchObject({ state: 'idle', at: null })
  })

  it('names the specialist it is waiting for, from the attempt', async () => {
    seedDelegated()
    event('attempt:att_1', 1, 'tool_call', { type: 'tool_call', tool: 'Bash' }, LATER)
    expect(await metaOf()).toMatchObject({
      state: 'waiting_specialist',
      line: 'Waiting for implementer on preflight-a: Add wave.js',
      workItemId: WI,
      running: false,
      at: LATER,
    })
  })

  it('counts specialists instead of naming one when several run', async () => {
    seedDelegated()
    store.atomic(() => store.attempts.save({ ...store.attempts.get('att_1')!, id: 'att_2' }))
    expect((await metaOf()).line).toBe('Waiting for 2 specialists')
  })

  it('a question waits on the person, before anything else', async () => {
    seedDelegated()
    openQuestion(WI)
    expect(await metaOf()).toMatchObject({
      state: 'waiting_you',
      line: 'Waiting for your answer: Which file?',
    })
  })

  it('blocked work says why', async () => {
    store.atomic(() =>
      store.workItems.save({
        id: WI,
        repoId: 'repo_a',
        state: 'blocked',
        blockedReason: 'integration: merge failed',
        createdAt: AT,
        updatedAt: AT,
      }),
    )
    expect(await metaOf()).toMatchObject({
      state: 'blocked',
      line: 'Blocked: integration: merge failed',
      workItemId: WI,
    })
  })

  it('integrating work with nothing running says it is integrating', async () => {
    seedDelegated({ state: 'succeeded' })
    store.atomic(() => store.workItems.save({ ...store.workItems.get(WI)!, state: 'integrating' }))
    expect(await metaOf()).toMatchObject({ state: 'integrating', workItemId: WI })
  })

  it('a stored request with no turn running says it has not started', async () => {
    seedQuestion('wi_new')
    withoutAck('wi_new')
    expect(await metaOf()).toMatchObject({ state: 'queued', running: false, workItemId: 'wi_new' })
  })

  it('a turn in flight is shown by phase, from what the planner has really done', async () => {
    await app.close()
    let gate: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      gate = resolve
    })
    release = gate
    let act: (() => void) | undefined
    const brain = async (context: any): Promise<MetaDecision> => {
      act = () => context.tools.execute('acknowledge', { message_id: context.messageId, text: 'On it' })
      await held
      return { ack: 'On it' }
    }
    const agent = service(brain)
    app = serverWith(agent)
    const sent = agent.onUserMessage({ messageId: 'msg_t', text: 'add a thing', repoId: 'repo_a' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(await metaOf()).toMatchObject({
      state: 'reading',
      line: 'Reading your request',
      running: true,
      at: AT,
    })
    act?.()
    expect(await metaOf()).toMatchObject({ state: 'planning', running: true })
    gate()
    await sent
    expect((await metaOf()).running).toBe(false)
  })

  it('a turn past its limit says so instead of working forever', async () => {
    await app.close()
    let gate: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      gate = resolve
    })
    release = gate
    const agent = service(async () => {
      await held
      return { ack: 'On it' }
    })
    app = serverWith(agent, '2026-11-06T12:30:00.000Z')
    const sent = agent.onUserMessage({ messageId: 'msg_t', text: 'add a thing', repoId: 'repo_a' })
    await new Promise((resolve) => setImmediate(resolve))
    expect((await metaOf()).line).toContain('past its time limit')
    gate()
    await sent
  })

  it('a pause is said', async () => {
    store.atomic(() => saveProcessing(store, { paused: true }, AT))
    expect(await metaOf()).toMatchObject({ state: 'paused' })
  })
})
