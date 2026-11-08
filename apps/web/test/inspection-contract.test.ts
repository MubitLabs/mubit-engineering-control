import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HealthBoard, HealthClaim, HealthName } from '@mec/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Relative on purpose, as web-contract.test.ts: the web package has no dependency on @mec/*. A real
// SqliteStore, because InspectionReads needs SQL and MemoryRepositories has none.
import { fakeBrain, MetaAgentService, type MetaBrain } from '../../../packages/meta/src/index'
import { InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '../../../packages/store/src/index'
import { APPROVAL_HEADER, ApprovalKey } from '../../desktop/src/approval'
import { buildServer } from '../../desktop/src/server'

import { AlreadyHandledError, HttpError } from '../src/api'
import { inspectApi } from '../src/api-inspect'
import { decodeChatLines } from '../src/inspection-decode'
import type { WorkRow } from '../src/next/inspection-wire'
import { approvalProps, conversationView, stageGroup, taskScope } from '../src/next/work-model'
import { needs as fixtureNeeds, workPage } from './fixtures/inspection-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))
const Database = createRequire(resolve(HERE, '../../../packages/store/package.json'))('better-sqlite3')

const AT = new Date('2026-11-05T12:00:00.000Z')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const quietHealth = {
  claim(_name: HealthName): HealthClaim {
    return { starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }
  },
} as unknown as HealthBoard

const originalFetch = globalThis.fetch
let root: string
let db: { close(): void }
let store: SqliteStore
const OWNER_KEY = 'an-owner-key-'.padEnd(64, '0')
let app: ReturnType<typeof buildServer>
let meta: MetaAgentService
/** Replaces the planner for a test; the model's the only fake part, every tool call is real. */
let turnBrain: MetaBrain | undefined

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
  root = mkdtempSync(join(tmpdir(), 'mec-inspection-contract-'))
  const webDist = join(root, 'web')
  mkdirSync(webDist)
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>shell</title>')
  db = new Database(':memory:')
  migrate(db as never, MIGRATIONS_v1)
  store = new SqliteStore(db as never, { now: () => AT })
  store.atomic(() => {
    store.engines.save({
      id: 'repo_a',
      url: 'https://github.com/acme/alpha.git',
      bootstrap: [],
      checks: [],
      trust: true,
    })
    store.engines.save({ id: 'repo_b', url: '/tmp/beta', bootstrap: [], checks: [], trust: true })
  })
  const policyText = '{"preAuthorised":{}}'
  turnBrain = undefined
  const scripted = fakeBrain({
    ack: 'On it',
    plan: {
      tasks: [
        { taskId: 'first', objective: 'Do the first thing', dependsOn: [], role: 'implementer' },
        { taskId: 'second', objective: 'Do the second thing', dependsOn: ['first'], role: 'implementer' },
      ],
    },
  })
  meta = new MetaAgentService({
    store,
    effects: store.effects,
    brain: (context) => (turnBrain ?? scripted)(context),
    now: () => AT.toISOString(),
    policyText,
  })
  app = buildServer({
    store,
    effects: store.effects,
    health: quietHealth,
    policyText,
    now: () => AT,
    keystoreRoot: root,
    webDist,
    inspection: new InspectionReads(db as never),
    metaAgent: meta,
    approval: { key: new ApprovalKey(OWNER_KEY), link: () => {} },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>), [APPROVAL_HEADER]: OWNER_KEY },
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
    })
    return new Response(res.body, { status: res.statusCode, headers: res.headers as HeadersInit })
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await app.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
  delete process.env.MEC_FAKE_ENGINE
})

const say = async (repoId: string, text: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/chat/messages',
    headers: { 'x-mec-client': '1', [APPROVAL_HEADER]: OWNER_KEY },
    payload: { text, repoId, intent: 'new' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { workItemId: string }).workItemId
}

const seedQuestion = (id: string, workItemId: string) =>
  store.atomic(() => {
    store.engines.save({
      id: `question/${id}`,
      questionId: id,
      workItemId,
      question: 'Include archived rows?',
      options: ['Yes', 'No'],
      status: 'open',
      askedAt: AT.toISOString(),
    })
  })

const seedCard = (id: string, extra: Record<string, unknown> = {}) =>
  store.atomic(() => {
    store.confirmations.save({
      id,
      cls: 'push',
      status: 'pending',
      operationHash: 'op',
      expiresAt: new Date(AT.getTime() + 3_600_000).toISOString(),
      ...extra,
    })
  })

async function waitForTasks(workItemId: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (store.tasks.list({ workItemId }).length > 0) return
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error('the planner made no tasks')
}

describe('the fixtures’ shape against the real server', () => {
  it('real work page decodes', async () => {
    const a = await say('repo_a', 'add alpha')
    const b = await say('repo_b', 'add beta')
    const page = await inspectApi.work(null)
    expect(page.items.map((row) => row.id).sort()).toEqual([a, b].sort())
    const row = page.items.find((entry) => entry.id === a) as WorkRow
    expect(row.repoLabel).toBe('acme/alpha')
    expect(row.title).toBe('add alpha')
    // The fixtures' row shape is the served one, key for key.
    expect(Object.keys(row).sort()).toEqual(Object.keys(workPage.items[0] as object).sort())
  })

  it('real stage keys land in the groups the fixtures assume', async () => {
    const id = await say('repo_a', 'add alpha')
    await waitForTasks(id)
    expect((await inspectApi.hold(id)).status).toBe('held')
    const [row] = (await inspectApi.work(null)).items
    expect(stageGroup(row as WorkRow)).toBe('held')
    await inspectApi.stop(id)
    const [ended] = (await inspectApi.work(null)).items
    expect(stageGroup(ended as WorkRow)).toBe('ended')
  })

  it('real work detail decodes, truncation counts included', async () => {
    const id = await say('repo_a', 'add alpha')
    await waitForTasks(id)
    const detail = await inspectApi.workDetail(id)
    expect(detail.tasks.map((task) => task.dependsOnTruncated)).toEqual([0, 0])
    expect(detail.tasksTruncated).toBe(0)
    expect(detail.cursorsTruncated).toBe(0)
    expect(detail.cursors[`work:${id}`]).toBeGreaterThan(0)
  })

  it('real task detail decodes', async () => {
    const id = await say('repo_a', 'add alpha')
    await waitForTasks(id)
    const detail = await inspectApi.workDetail(id)
    const task = await inspectApi.taskDetail(detail.tasks[0]?.id as string)
    expect(task.workItemId).toBe(id)
    expect(task.repoId).toBe('repo_a')
    expect(taskScope(task, 'Parent').title).toBe(task.title)
  })

  it('real needs decodes', async () => {
    const id = await say('repo_a', 'add alpha')
    seedQuestion('q1', id)
    seedCard('card_1', { repoId: 'repo_a' })
    const page = await inspectApi.needs(null)
    expect(page.items.map((item) => item.kind).sort()).toEqual(['agreement', 'card', 'question'])
    const card = page.items.find((item) => item.kind === 'card')
    const question = page.items.find((item) => item.kind === 'question')
    expect(Object.keys(card as object).sort()).toEqual(Object.keys(fixtureNeeds.pending).sort())
    expect(Object.keys(question as object).sort()).toEqual(Object.keys(fixtureNeeds.question).sort())
    expect(question?.id).toBe('q1')
  })

  it('real search decodes', async () => {
    await say('repo_a', 'add alpha thing')
    const page = await inspectApi.search('alpha')
    expect(page.items.length).toBeGreaterThan(0)
    expect(new Set(page.items.map((hit) => hit.repoLabel))).toEqual(new Set(['acme/alpha']))
  })

  it('real snapshot decodes', async () => {
    const id = await say('repo_a', 'add alpha')
    const snapshot = await inspectApi.snapshot()
    expect(snapshot.repositories.map((repo) => repo.id).sort()).toEqual(['repo_a', 'repo_b'])
    expect(snapshot.cursors[`work:${id}`]).toBeGreaterThan(0)
    expect(snapshot.repositoriesTruncated).toBe(0)
  })

  it('a real stored message reaches the conversation as the person’s', async () => {
    await say('repo_a', 'add alpha')
    const raw = await (await fetch('/api/chat/messages?repoId=repo_a')).json()
    const view = conversationView({ row: null, detail: null, messages: decodeChatLines(raw) })
    expect(view.entries[0]).toMatchObject({ kind: 'user', text: 'add alpha' })
  })

  it('a key in chat stays redacted through the read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'x-mec-client': '1', [APPROVAL_HEADER]: OWNER_KEY },
      payload: { text: KEY, repoId: 'repo_a', intent: 'new' },
    })
    expect(res.statusCode).toBe(200)
    const raw = await (await fetch('/api/chat/messages?repoId=repo_a')).json()
    const view = conversationView({ row: null, detail: null, messages: decodeChatLines(raw) })
    expect(JSON.stringify(view)).not.toContain(KEY)
    expect(view.entries.at(-1)?.kind).toBe('note')
  })
})

describe('a wake on the real path (§6, §18.1)', () => {
  const thread = async () => {
    const raw = await (await fetch('/api/chat/messages?repoId=repo_a')).json()
    return conversationView({ row: null, detail: null, messages: decodeChatLines(raw) }).entries
  }

  /** The planner raises its question through the real ask_user tool, and answers the wake with `onWake`. */
  const askedThenWoken = async (onWake: MetaBrain): Promise<{ workItemId: string; questionId: string }> => {
    let questionId = ''
    turnBrain = async (context) => {
      if (context.wake?.reason !== 'user message') return onWake(context)
      context.tools.execute('ask_user', { question: 'Include archived rows?', options: ['Yes', 'No'] })
      const questions = context.tools.journal().questions
      questionId = questions[0]?.id ?? ''
      return { ack: 'One question first', questions }
    }
    const workItemId = await say('repo_a', 'add alpha')
    await vi.waitFor(() => expect(store.engines.get(`question/${questionId}`)).toBeDefined())
    return { workItemId, questionId }
  }

  const answer = async (id: string, text: string) => {
    store.effects.handle('relay', (payload) => meta.runRelay(payload))
    const res = await app.inject({
      method: 'POST',
      url: `/api/questions/${id}/answer`,
      headers: { 'x-mec-client': '1', [APPROVAL_HEADER]: OWNER_KEY },
      payload: { answer: text },
    })
    expect(res.statusCode).toBe(200)
    await store.effects.drain()
  }

  it('a real ask_user reaches Needs you, and answering it writes nothing for the owner', async () => {
    const { questionId } = await askedThenWoken(async () => ({ ack: 'Thanks, carrying on' }))
    const [item] = (await inspectApi.needs(null)).items
    expect(item).toMatchObject({ kind: 'question', id: questionId, repoId: 'repo_a' })

    await answer(questionId, 'Yes')

    expect(store.messages.list().map((doc) => String(doc.text))).toContain('question answered')
    expect((await thread()).map(({ kind, text }) => [kind, text])).toEqual([
      ['user', 'add alpha'],
      ['agent', 'One question first'],
      ['agent', 'Thanks, carrying on'],
    ])
  })

  it('a wake the planner failed keeps the answer out of the thread and says it failed', async () => {
    const { questionId } = await askedThenWoken(async () => {
      throw new Error('the planner fell over')
    })
    await answer(questionId, 'Yes')
    const entries = await thread()
    expect(entries.filter((entry) => entry.kind === 'user').map((entry) => entry.text)).toEqual(['add alpha'])
    expect(entries.at(-1)).toMatchObject({ kind: 'agent', text: 'I could not start that' })
  })

  it('a wake with another cause and no causation shows the same way', async () => {
    const workItemId = await say('repo_a', 'add alpha')
    turnBrain = async () => ({ ack: 'The specialist reported' })
    await meta.onWake({ reason: 'specialist report', workItemId })
    expect((await thread()).map((entry) => entry.text)).not.toContain('specialist report')
    expect((await thread()).at(-1)).toMatchObject({ kind: 'agent', text: 'The specialist reported' })
  })
})

describe('activity and artifacts on the real routes', () => {
  const seedAttempt = (worktree: string) =>
    store.atomic(() => {
      store.attempts.save({
        id: 'att_seen',
        taskId: 'task_seen',
        workItemId: 'wi_seen',
        state: 'running',
        generation: 1,
        worktree,
      } as never)
      for (const [seq, type, body] of [
        [1, 'tool_call', { tool: 'Bash', ok: true }],
        [2, 'message', { role: 'assistant', text: `key ${KEY}` }],
        [3, 'attempt.turn_ended', { generation: 1 }],
        [
          4,
          'report',
          { report: { kind: 'completion', summary: 'done', artifacts: [{ kind: 'log', ref: 'run.log' }] } },
        ],
      ] as const) {
        const stream = 'attempt:att_seen'
        store.events.append(stream, { stream, seq, at: AT.toISOString(), type, body } as never)
      }
    })

  it('real activity decodes, redacted, and only the contract’s types', async () => {
    seedAttempt(root)
    const page = await inspectApi.activity('att_seen', null)
    expect(page.items.map((item) => item.type)).toEqual(['tool_call', 'message', 'report'])
    expect(JSON.stringify(page)).not.toContain(KEY)
    expect(page.nextCursor).toBeNull()
  })

  it('an unknown attempt is a failed read', async () => {
    await expect(inspectApi.activity('att_none', null)).rejects.toBeInstanceOf(HttpError)
  })

  it('a real text artifact decodes as plain text, redacted', async () => {
    seedAttempt(root)
    writeFileSync(join(root, 'run.log'), `line\n${KEY}\n`)
    const page = await inspectApi.artifact('att_seen', 'run.log', null)
    expect(page).toMatchObject({ kind: 'text', ref: 'run.log', nextCursor: null })
    expect(JSON.stringify(page)).not.toContain(KEY)
  })

  it('real JSON text stays text', async () => {
    seedAttempt(root)
    writeFileSync(join(root, 'data.json'), '{"binary":true}')
    expect(await inspectApi.artifact('att_seen', 'data.json', null)).toMatchObject({
      kind: 'text',
      text: '{"binary":true}',
    })
  })

  it('a real binary artifact is metadata only', async () => {
    seedAttempt(root)
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x00]))
    expect(await inspectApi.artifact('att_seen', 'image.png', null)).toEqual({
      kind: 'binary',
      ref: 'image.png',
      size: 5,
    })
  })

  it('a refused path answers 403 and a missing one 404, read through the same path', async () => {
    seedAttempt(root)
    mkdirSync(join(root, '.mec'), { recursive: true })
    writeFileSync(join(root, '.mec', 'x'), 'token')
    await expect(inspectApi.artifact('att_seen', '.mec/x', null)).rejects.toMatchObject({ status: 403 })
    await expect(inspectApi.artifact('att_seen', 'gone.txt', null)).rejects.toMatchObject({ status: 404 })
  })
})

describe('actions on the real routes', () => {
  it('a card with no served evidence cannot be approved, and deny still works', async () => {
    seedCard('card_bare', { repoId: 'repo_a' })
    const [item] = (await inspectApi.needs(null)).items
    const evidence = await inspectApi.evidence('card_bare')
    expect(evidence.absent).toBe(true)
    expect(approvalProps(item as never, evidence, null).canApprove).toBe(false)
    expect((await inspectApi.resolve('card_bare', 'deny')).status).toBe('denied')
  })

  it('a second resolve is already handled', async () => {
    seedCard('card_twice', { repoId: 'repo_a' })
    await inspectApi.resolve('card_twice', 'deny')
    await expect(inspectApi.resolve('card_twice', 'deny')).rejects.toBeInstanceOf(AlreadyHandledError)
  })

  it('answers through the real route, and a second answer is a 409', async () => {
    const id = await say('repo_a', 'add alpha')
    seedQuestion('q1', id)
    await inspectApi.answer('q1', 'Yes')
    const error = await inspectApi.answer('q1', 'No').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(409)
  })

  it('hold, lift and stop answer in the shapes the feed reads', async () => {
    const id = await say('repo_a', 'add alpha')
    expect((await inspectApi.hold(id)).status).toBe('held')
    expect((await inspectApi.workDetail(id)).hold?.reason).toBe('held by the owner')
    expect(['lifted', 'free']).toContain((await inspectApi.lift(id)).status)
    expect((await inspectApi.stop(id)).status).toBe('stopped')
  })

  it('an over-large record answers 500 response_too_large, a failure with a reason', async () => {
    const id = await say('repo_a', 'add alpha')
    // A pathological repository id, served whole, pushes one row over the hard ceiling.
    store.atomic(() => {
      const doc = store.workItems.get(id)
      store.workItems.save({ ...doc, id, repoId: 'x'.repeat(1_100_000) })
    })
    const error = await inspectApi.work(null).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(500)
    expect((error as HttpError).reason).toBe('response_too_large')
  })
})
