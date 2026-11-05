// M2.2 follow-ups (§12.3, §12.4): ownership, receipts, handback and release, over the memory
// store. The runtime is a double because what is under test is what the meta side does with what
// a runtime says; the real path is apps/desktop/test/coordination.test.ts.
import type { AttemptRef, Input, Json, Report, StoreDoc } from '@mec/contracts'
import { Later } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import { type DeliveryRuntime, FollowUps, fakeBrain, MetaAgentService, type MetaDecision } from '../src'
import { holdWorkItem, stopWorkItem } from '../src/authority'

const AT = '2026-11-05T12:00:00.000Z'
const REPO = 'repo_a'

const report = (fields: Partial<Report> & { kind: Report['kind'] }): Report => ({
  summary: 'a summary',
  ...fields,
})

type Rig = {
  store: MemoryRepositories
  followups: FollowUps
  service: MetaAgentService
  delivered: { attempt: AttemptRef; input: Input }[]
  deliverRows: () => { key: string; payload: Json }[]
  relayRows: () => { key: string; payload: Json }[]
  drainDeliver: () => Promise<void>
}

function rig(decision: MetaDecision = { ack: 'ok' }, runtime?: DeliveryRuntime): Rig {
  const store = new MemoryRepositories()
  const delivered: Rig['delivered'] = []
  const engine: DeliveryRuntime = runtime ?? {
    deliver: async (attempt, input) => {
      delivered.push({ attempt, input })
    },
  }
  store.atomic(() => {
    store.engines.save({ id: REPO, url: 'https://example.test/a', bootstrap: [], checks: [], trust: true })
    store.workItems.save({
      id: 'wi_1',
      state: 'executing',
      repoId: REPO,
      mandate: { originMessageId: 'msg_0', status: 'active' },
    })
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_1',
      workItemId: 'wi_1',
      slotId: 's',
      state: 'running',
      generation: 1,
      createdAt: AT,
    })
  })
  const followups = new FollowUps({
    store,
    effects: store.effects,
    now: () => AT,
    runtime: () => engine,
  })
  const service = new MetaAgentService({
    store,
    effects: store.effects,
    brain: fakeBrain(decision),
    now: () => AT,
    followups,
  })
  const rows = (kind: string) => () =>
    store.snapshot().effects.filter((row) => row.kind === kind) as { key: string; payload: Json }[]
  const deliverRows = rows('deliver')
  return {
    store,
    followups,
    service,
    delivered,
    deliverRows,
    relayRows: rows('relay'),
    drainDeliver: async () => {
      for (const row of deliverRows()) await followups.runDeliver(row.payload)
    },
  }
}

const send = (h: Rig, text = 'Also cover the export button', messageId = 'msg_1') =>
  h.service.onUserMessage({ messageId, text, repoId: REPO, referencesWorkItem: 'wi_1' })

const stage = (h: Rig, id = 'msg_1'): string | undefined =>
  (h.store.messages.get(id)?.receipt as { stage: string } | undefined)?.stage

const attempt = (h: Rig, id = 'att_1'): StoreDoc => h.store.attempts.get(id) as StoreDoc

const onReport = (h: Rig, fields: Partial<Report> & { kind: Report['kind'] }, n = 1) =>
  h.store.atomic(() => h.followups.onReport(attempt(h), report(fields), n, AT))

const inputIdOf = (h: Rig, id = 'msg_1'): string => String(h.store.messages.get(id)?.inputId)

describe('ownership (§12.3)', () => {
  it('owned follow-up delivers unchanged', async () => {
    const h = rig()
    const text = 'Keep   the  spacing\nand the "quotes" exact'
    await send(h, text)

    expect(h.deliverRows()).toHaveLength(1)
    expect(h.deliverRows()[0]?.key).toBe(`deliver:att_1:${inputIdOf(h)}`)
    await h.drainDeliver()
    expect(h.delivered).toEqual([
      {
        attempt: { attempt_id: 'att_1', generation: 1 },
        input: { id: inputIdOf(h), kind: 'message', text, message_id: 'msg_1' },
      },
    ])
    expect(h.store.messages.get('msg_1')).toMatchObject({ ownerAttemptId: 'att_1', owned: true })
    expect(h.relayRows()).toHaveLength(0)
  })

  it('a follow-up with nothing running gets a meta turn, with the text', async () => {
    const h = rig()
    h.store.atomic(() => {
      h.store.attempts.save({ ...attempt(h), state: 'succeeded' })
    })
    const outcome = await send(h)
    expect(outcome.acknowledged).toContain('nothing is running')
    expect(h.deliverRows()).toHaveLength(0)
    expect(h.relayRows()[0]?.payload).toMatchObject({ detail: 'Also cover the export button' })
  })

  it('meta can only stop while owned', async () => {
    const stop = { messageId: 'msg_1', decision: 'stop' as const, target: 'wi_1', at: AT }
    const attach = { messageId: 'msg_1', decision: 'attach' as const, target: 'wi_1', at: AT }
    const h = rig()
    await send(h)
    const guarded = h.store.atomic(() =>
      h.followups.guardTurn(
        {
          ack: 'ok',
          routes: [stop, attach],
          plan: { tasks: [] },
          spawns: [{ taskId: 't', workItemId: 'wi_1', objective: 'o', role: 'implementer' }],
        },
        'wi_1',
        AT,
      ),
    )
    expect(guarded.routes).toEqual([stop])
    expect(guarded.plan).toBeUndefined()
    expect(guarded.spawns).toBeUndefined()
    expect(h.store.events.read('work:wi_1').map((event) => event.type)).toContain('route_refused')
  })

  it('a planner wake on owned work runs no replan', async () => {
    const plan = {
      tasks: [{ taskId: 'x', objective: 'o', dependsOn: [] as string[], role: 'implementer' }],
    }
    const h = rig({ ack: 'ok', plan })
    await send(h)
    const outcome = await h.service.onWake({ causationId: 'c', reason: 'report ready', workItemId: 'wi_1' })
    expect(outcome.tasksCreated).toBe(0)
    expect(h.store.tasks.list({ workItemId: 'wi_1' })).toHaveLength(0)
  })

  it('work with no owned message replans as usual', () => {
    const h = rig()
    const decision = { ack: 'ok', plan: { tasks: [] } }
    expect(h.store.atomic(() => h.followups.guardTurn(decision, 'wi_1', AT))).toBe(decision)
  })

  it('handback routes elsewhere with its reason, once', async () => {
    const h = rig()
    h.store.atomic(() => {
      h.store.attempts.save({
        ...attempt(h),
        id: 'att_2',
        state: 'running',
        createdAt: '2026-11-05T11:00:00.000Z',
      })
    })
    await send(h)
    await h.drainDeliver()

    const given = h.store.atomic(() =>
      h.followups.handback(attempt(h), 'msg_1', 'belongs to the API task', AT),
    )
    expect(given).toEqual({ ok: true })
    expect(stage(h)).toBe('handled')
    expect(h.relayRows()[0]).toMatchObject({
      key: 'wake:handback:msg_1',
      payload: { detail: 'belongs to the API task: Also cover the export button', settles: 'msg_1' },
    })

    const again = h.store.atomic(() => h.followups.handback(attempt(h), 'msg_1', 'again', AT))
    expect(again).toEqual({ ok: false, reason: 'already handed back' })

    expect(h.store.atomic(() => h.followups.reroute('msg_1', 'wi_1', AT))).toBe(true)
    expect(h.store.messages.get('msg_1')?.ownerAttemptId).toBe('att_2')
    expect(h.deliverRows().some((row) => row.key.startsWith('deliver:att_2:'))).toBe(true)
  })

  it('a handback is never routed back to the attempt that gave it', async () => {
    const h = rig()
    await send(h)
    await h.drainDeliver()
    h.store.atomic(() => h.followups.handback(attempt(h), 'msg_1', 'no', AT))
    expect(h.store.atomic(() => h.followups.reroute('msg_1', 'wi_1', AT))).toBe(false)
    expect(h.store.messages.get('msg_1')?.ownerAttemptId).toBe('att_1')
  })

  it('a report carrying a handback hands it back', async () => {
    const h = rig()
    await send(h)
    await h.drainDeliver()
    onReport(h, { kind: 'progress', handback: { message_id: 'msg_1', reason: 'not mine' } })
    expect(h.store.messages.get('msg_1')?.handback).toMatchObject({ attemptId: 'att_1', reason: 'not mine' })
  })

  it('the wake that routed a handback settles the message', async () => {
    const h = rig()
    await send(h)
    await h.drainDeliver()
    h.store.atomic(() => h.followups.handback(attempt(h), 'msg_1', 'no', AT))
    await h.service.runRelay(h.relayRows()[0]?.payload as Json)
    expect(stage(h)).toBe('settled')
  })

  it('unhandled message is released at work end', async () => {
    const h = rig()
    await send(h)
    await h.drainDeliver()
    h.store.atomic(() => {
      h.store.attempts.save({ ...attempt(h), state: 'succeeded' })
      h.followups.sweep(AT)
    })

    expect(h.store.messages.get('msg_1')).toMatchObject({
      owned: false,
      released: { reason: 'its attempt ended before it handled the message' },
    })
    expect(stage(h)).toBe('delivered')
    expect(h.relayRows()[0]).toMatchObject({ key: 'wake:released:msg_1' })
  })

  it('a stopped item releases into a note: nothing wakes ended work', async () => {
    const h = rig()
    await send(h)
    h.store.atomic(() => {
      stopWorkItem(h.store, 'wi_1', { reason: 'stop', at: AT })
      h.followups.sweep(AT)
    })
    expect(h.store.messages.get('msg_1')?.owned).toBe(false)
    expect(h.relayRows()).toHaveLength(0)
    const notes = h.store.engines.list({ workItemId: 'wi_1' })
    expect(notes.some((doc) => String(doc.text).includes('Also cover the export button'))).toBe(true)
  })

  it('live openQuestions reach the routing view', async () => {
    const h = rig()
    h.store.atomic(() => {
      h.followups.openQuestion(attempt(h), { text: 'Which table?' }, AT)
    })
    expect(h.store.engines.list({ workItemId: 'wi_1', status: 'open' })).toHaveLength(1)
  })
})

describe('receipts (§12.4)', () => {
  it('no receipt past the evidence', async () => {
    const h = rig()
    await send(h)
    expect(stage(h)).toBe('received')

    await h.drainDeliver()
    expect(stage(h)).toBe('delivered')

    // A plain report on the way says nothing about this input.
    onReport(h, { kind: 'progress' })
    expect(stage(h)).toBe('delivered')

    h.store.atomic(() => h.followups.inputsRead('att_1', [inputIdOf(h)]))
    expect(stage(h)).toBe('read')

    onReport(h, { kind: 'progress', handled_inputs: [inputIdOf(h)] }, 2)
    expect(stage(h)).toBe('handled')

    h.store.atomic(() => {
      h.store.attempts.save({ ...attempt(h), state: 'succeeded' })
      h.followups.sweep(AT)
    })
    expect(stage(h)).toBe('settled')
    expect(h.relayRows()).toHaveLength(0)
  })

  it('delivered waits for the runtime to say the engine took it', async () => {
    let take: () => void = () => {}
    const h = rig(
      { ack: 'ok' },
      {
        deliver: () =>
          new Promise<void>((resolve) => {
            take = resolve
          }),
      },
    )
    await send(h)
    const running = h.drainDeliver()
    await Promise.resolve()
    expect(stage(h)).toBe('received')
    take()
    await running
    expect(stage(h)).toBe('delivered')
  })

  it('an input a report names as handled reads first: the ladder never skips', async () => {
    const h = rig()
    await send(h)
    await h.drainDeliver()
    onReport(h, { kind: 'progress', handled_inputs: [inputIdOf(h)] })
    expect(stage(h)).toBe('handled')
  })

  it('crash between delivered and read keeps the true stage', async () => {
    const h = rig()
    await send(h)
    await h.drainDeliver()

    const restarted = new FollowUps({ store: h.store, effects: h.store.effects, now: () => AT })
    h.store.atomic(() => restarted.sweep(AT))
    expect(stage(h)).toBe('delivered')
    h.store.atomic(() => restarted.inputsRead('att_1', [inputIdOf(h)]))
    expect(stage(h)).toBe('read')
  })

  it('a row replayed after a crash does not deliver a second copy', async () => {
    const h = rig()
    await send(h)
    await h.drainDeliver()
    await h.drainDeliver()
    expect(h.delivered).toHaveLength(1)
  })

  it('an engine with no proven send gets no receipt and the message is released with the reason', async () => {
    const h = rig(
      { ack: 'ok' },
      {
        deliver: async () => {
          throw new Error('engine codex has no proven input')
        },
      },
    )
    await send(h)
    await h.drainDeliver()

    expect(stage(h)).toBe('received')
    expect(h.store.messages.get('msg_1')?.released).toMatchObject({
      reason: 'delivery failed: engine codex has no proven input',
    })
    const types = h.store.events.read('attempt:att_1').map((event) => event.type)
    expect(types).toContain('attempt.delivery_failed')
    expect(types).not.toContain('attempt.inputs_delivered')
    expect(h.relayRows()[0]?.payload).toMatchObject({ reason: 'message released' })
  })

  it('no runner at all is a failed delivery, not a success', async () => {
    const h = rig()
    const noRunner = new FollowUps({ store: h.store, effects: h.store.effects, now: () => AT })
    await send(h)
    await noRunner.runDeliver(h.deliverRows()[0]?.payload as Json)
    expect(stage(h)).toBe('received')
    expect(h.store.messages.get('msg_1')?.released).toBeDefined()
  })

  it('a queued owner keeps the row, and so does a held item (#28)', async () => {
    const h = rig()
    await send(h)
    const payload = h.deliverRows()[0]?.payload as Json

    h.store.atomic(() => {
      h.store.attempts.save({ ...attempt(h), state: 'queued' })
    })
    await expect(h.followups.runDeliver(payload)).rejects.toBeInstanceOf(Later)

    h.store.atomic(() => {
      h.store.attempts.save({ ...attempt(h), state: 'running' })
      holdWorkItem(h.store, 'wi_1', { reason: 'wait', at: AT })
    })
    await expect(h.followups.runDeliver(payload)).rejects.toBeInstanceOf(Later)
    expect(h.delivered).toHaveLength(0)
  })

  it('a delivery waiting holds the reserved unit, unless its item is held', async () => {
    const h = rig()
    await send(h)
    expect(h.followups.deliveryWaiting()).toBe(true)
    h.store.atomic(() => holdWorkItem(h.store, 'wi_1', { reason: 'wait', at: AT }))
    expect(h.followups.deliveryWaiting()).toBe(false)
  })
})

describe('questions (§10, §12.6)', () => {
  const open = (h: Rig) => h.store.engines.list({ attemptId: 'att_1' }).filter((doc) => doc.status === 'open')

  it('the same text reuses, different text replaces, ready closes', () => {
    const h = rig()
    onReport(h, { kind: 'progress', question: { text: 'Which table?' } }, 1)
    onReport(h, { kind: 'progress', question: { text: 'Which table?' } }, 2)
    expect(open(h)).toHaveLength(1)

    onReport(h, { kind: 'progress', question: { text: 'Which index?' } }, 3)
    expect(open(h).map((doc) => doc.question)).toEqual(['Which index?'])

    onReport(h, { kind: 'ready' }, 4)
    expect(open(h)).toHaveLength(0)
  })

  it('an explicit null clears, and absent keeps', () => {
    const h = rig()
    onReport(h, { kind: 'progress', question: { text: 'Which table?' } }, 1)
    onReport(h, { kind: 'progress' }, 2)
    expect(open(h)).toHaveLength(1)
    onReport(h, { kind: 'progress', question: null }, 3)
    expect(open(h)).toHaveLength(0)
  })

  it('keeps the question text and evidence as the specialist gave them', () => {
    const h = rig()
    const question = { text: 'Keep  "the" text?', options: ['yes', 'no'], evidence_ref: 'src/a.ts:12' }
    onReport(h, { kind: 'progress', question })
    expect(open(h)[0]).toMatchObject({
      question: question.text,
      options: question.options,
      evidenceRef: 'src/a.ts:12',
      attemptId: 'att_1',
      workItemId: 'wi_1',
      status: 'open',
    })
  })

  it('the answer goes to the attempt that asked, and the planner gets a note, not a turn', async () => {
    const h = rig()
    const { questionId } = h.store.atomic(() =>
      h.followups.openQuestion(attempt(h), { text: 'Which table?' }, AT),
    )
    const wakes = h.relayRows().length

    h.service.onQuestionAnswered(questionId, 'the audit table')

    expect(h.relayRows()).toHaveLength(wakes)
    await h.drainDeliver()
    expect(h.delivered[0]?.attempt.attempt_id).toBe('att_1')
    expect(h.delivered[0]?.input.text).toContain('the audit table')
    expect(
      h.store.engines.list({ workItemId: 'wi_1' }).some((doc) => String(doc.id).startsWith('note/')),
    ).toBe(true)
  })

  it('an answer to an attempt that ended wakes the planner, naming the plan revision', () => {
    const h = rig()
    h.store.atomic(() => {
      const doc = h.store.workItems.get('wi_1') as StoreDoc
      h.store.workItems.save({ ...doc, planRevision: 3 })
    })
    const { questionId } = h.store.atomic(() =>
      h.followups.openQuestion(attempt(h), { text: 'Which table?' }, AT),
    )
    h.store.atomic(() => {
      h.store.attempts.save({ ...attempt(h), state: 'failed' })
    })
    h.service.onQuestionAnswered(questionId, 'audit')
    const wake = h.relayRows().find((row) => row.key === `wake:question/${questionId}`)
    expect(wake?.payload).toMatchObject({ reason: 'question answered' })
    expect(JSON.stringify(wake?.payload)).toContain('plan revision 3')
  })

  it('an answer the attempt can no longer take goes to the planner, not nowhere', async () => {
    const h = rig(
      { ack: 'ok' },
      {
        deliver: async () => {
          throw new Error('att_1 has no running engine')
        },
      },
    )
    const { questionId } = h.store.atomic(() =>
      h.followups.openQuestion(attempt(h), { text: 'Which table?' }, AT),
    )
    h.service.onQuestionAnswered(questionId, 'audit')
    await h.drainDeliver()
    const wake = h.relayRows().find((row) => row.key.startsWith('wake:undelivered:'))
    expect(wake?.payload).toMatchObject({ reason: 'answer not delivered' })
    expect(JSON.stringify(wake?.payload)).toContain('audit')
  })

  it('a planner’s question still wakes the planner', () => {
    const h = rig()
    h.store.atomic(() => {
      h.store.engines.save({
        id: 'question/q_p',
        questionId: 'q_p',
        question: 'Q',
        status: 'open',
        workItemId: 'wi_1',
      })
    })
    h.service.onQuestionAnswered('q_p', 'yes')
    expect(h.relayRows().map((row) => row.key)).toEqual(['wake:question/q_p'])
    expect(h.deliverRows()).toHaveLength(0)
  })

  it('a question already answered is not asked again', () => {
    const h = rig()
    const { questionId } = h.store.atomic(() =>
      h.followups.openQuestion(attempt(h), { text: 'Which table?' }, AT),
    )
    h.service.onQuestionAnswered(questionId, 'audit')
    const again = h.store.atomic(() => h.followups.openQuestion(attempt(h), { text: 'Which table?' }, AT))
    expect(again).toMatchObject({ reused: true, answer: 'audit' })
  })
})
