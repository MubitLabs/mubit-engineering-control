import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MetaDecision } from '../src'
import { fakeBrain, MetaAgentService } from '../src'

/**
 * The meta-agent runtime over MemoryRepositories: its effects queue throws unless
 * enqueue runs inside `atomic` and coalesces re-enqueues to one row per kind + key, so a
 * green suite is itself the proof that every enqueue in the service is transactional.
 */

const NOW = () => '2026-11-03T12:00:00.000Z'

const ACK = 'On it: the audit-log work, in two tasks, tests green.'

const twoTaskPlan: MetaDecision = {
  ack: ACK,
  plan: {
    tasks: [
      { taskId: 'task_view', objective: 'Add the audit-log view', dependsOn: [], role: 'implementer' },
      {
        taskId: 'task_tests',
        objective: 'Cover the view with tests',
        dependsOn: ['task_view'],
        role: 'test_author',
      },
    ],
  },
}

const ghostDepPlan: MetaDecision = {
  ack: 'On it',
  plan: {
    tasks: [
      {
        taskId: 'task_ghost',
        objective: 'Depends on a ghost',
        dependsOn: ['task_missing'],
        role: 'implementer',
      },
    ],
  },
}

const REPO = 'repo_main'

const rig = (decision: MetaDecision, store = new MemoryRepositories()) => {
  store.atomic(() => {
    store.engines.save({
      id: REPO,
      url: 'https://example.test/main',
      bootstrap: [],
      checks: [],
      trust: true,
      hostRunAgreedAt: '2026-11-05T08:00:00.000Z',
    })
  })
  const service = new MetaAgentService({
    store,
    effects: store.effects,
    brain: fakeBrain(decision),
    now: NOW,
  })
  return { service, store }
}

/** Planner keys are local; the store's ids are canonical (spec §10, decision #19). */
const taskByKey = (store: MemoryRepositories, workItemId: string | undefined, localKey: string) =>
  store.tasks.list({ workItemId, localKey })[0]

const seedWork = (store: MemoryRepositories, id: string, state: string): void => {
  store.atomic(() => {
    store.workItems.save({
      id,
      state,
      createdAt: '2026-11-03T10:00:00.000Z',
      updatedAt: '2026-11-03T10:00:00.000Z',
    })
  })
}

describe('a turn writes nothing key-shaped (§13 invariant 3)', () => {
  const KEY = `sk-ant-${'a1B2c3D4'.repeat(6)}`

  it('redacts operation, evidence, class, questions, notes and reports before any write', async () => {
    const decision: MetaDecision = {
      ack: 'On it',
      confirmations: [
        {
          id: 'conf_1',
          cls: `frontier ${KEY}`,
          operationHash: 'f'.repeat(64),
          expiresAt: '2999-01-01T00:00:00.000Z',
          operation: { class: 'frontier_model', pasted: KEY, [`field ${KEY}`]: [{ deep: KEY }] },
          evidence: { reason: `because ${KEY}` },
        },
      ],
      questions: [{ id: 'q_1', question: `Use ${KEY}?`, options: [KEY], at: NOW() }],
      reports: [{ workItemId: 'wi_x', summary: `done ${KEY}`, artifacts: [{ kind: 'k', ref: KEY }] }],
    }
    const { service, store } = rig(decision)
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })

    expect(JSON.stringify(store.confirmations.get('conf_1'))).not.toContain(KEY)
    expect(JSON.stringify(store.engines.get('question/q_1'))).not.toContain(KEY)
    const streams = [`work:${outcome.workItemId}`, 'work:wi_x', 'question/q_1']
    for (const stream of streams) expect(JSON.stringify(store.events.read(stream))).not.toContain(KEY)
    expect(store.confirmations.get('conf_1')?.operationHash).toBe('f'.repeat(64))
  })
})

describe('MetaAgentService (plan §6/§12)', () => {
  beforeEach(() => {
    process.env.MEC_FAKE_ENGINE = '1'
  })
  afterEach(() => {
    delete process.env.MEC_FAKE_ENGINE
  })

  it('new work: creates the work item executing, acks once, tasks ready, one launch enqueued', async () => {
    const { service, store } = rig(twoTaskPlan)
    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'Add audit-log viewing',
      repoId: REPO,
    })
    const { workItemId } = outcome

    expect(workItemId).toMatch(/^wi_/)
    expect(outcome).toEqual({
      acknowledged: ACK,
      workItemId,
      tasksCreated: 2,
      launchesEnqueued: ['att_1'],
      escalated: false,
    })

    const work = store.workItems.get(workItemId!)
    expect(work?.state).toBe('executing')
    expect(work?.originMessageId).toBe('msg_1')
    // planning_started then execution_started, gap-free on the work stream.
    const workEvents = store.events.read(`work:${workItemId!}`)
    expect(workEvents.map((event) => event.type)).toEqual(['planning_started', 'execution_started'])

    const view = taskByKey(store, workItemId, 'task_view')
    expect(view).toMatchObject({ workItemId, status: 'ready' })
    expect(taskByKey(store, workItemId, 'task_tests')).toMatchObject({
      workItemId,
      status: 'ready',
      dependsOn: [view?.id],
      role: 'test_author',
    })

    // The ack is a receipt on the message doc, recorded exactly once.
    expect(store.messages.get('msg_1')?.ackText).toBe(ACK)

    // The launch is a queued attempt doc plus one launch effect keyed att_1:1.
    expect(store.attempts.get('att_1')).toMatchObject({
      taskId: view?.id,
      workItemId: outcome.workItemId,
      slotId: 'fake-slot',
      state: 'queued',
      generation: 1,
    })
    const effects = store.snapshot().effects
    expect(effects).toHaveLength(1)
    expect(effects[0]).toMatchObject({ kind: 'launch', key: 'att_1:1' })
    expect(effects[0]?.payload).toMatchObject({ attempt_id: 'att_1', task_id: view?.id })
    expect(store.events.read('attempt:att_1').map((event) => event.type)).toEqual(['attempt_queued'])
  })

  it('a dependency holds its task back: only the dependency-free task is launched', async () => {
    const { service, store } = rig(twoTaskPlan)
    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'Add audit-log viewing',
      repoId: REPO,
    })
    // task_tests depends on task_view, which is merely ready — never integrated — so the
    // dispatch plan launches one task and defers the other on its dependency.
    expect(outcome.launchesEnqueued).toEqual(['att_1'])
    expect(store.attempts.list()).toHaveLength(1)
    expect(store.attempts.list()[0]?.taskId).toBe(taskByKey(store, outcome.workItemId, 'task_view')?.id)
    expect(taskByKey(store, outcome.workItemId, 'task_tests')?.status).toBe('ready')
  })

  it('attach: a message referencing live work acks as a note — no new work item, no launches', async () => {
    const { service, store } = rig(twoTaskPlan)
    seedWork(store, 'wi_live', 'executing')
    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'Also cover the export button',
      referencesWorkItem: 'wi_live',
    })

    expect(outcome.workItemId).toBe('wi_live')
    expect(outcome.tasksCreated).toBe(0)
    expect(outcome.launchesEnqueued).toEqual([])
    expect(store.workItems.list()).toHaveLength(1)
    expect(store.tasks.list()).toHaveLength(0)
    // §6, §12.3: with no attempt to own it, the message gets a planner turn instead of nothing.
    expect(store.snapshot().effects.map((row) => row.kind)).toEqual(['relay'])
    expect(store.messages.get('msg_1')?.routing).toBe('attach')
    expect(store.events.read('work:wi_live').map((event) => event.type)).toEqual(['message_attached'])
  })

  it('the note names the work by a short title, never by the whole request', async () => {
    const { service, store } = rig(twoTaskPlan)
    const request =
      'Add two small JavaScript modules as two separate tasks, the second depending on the first, each with its own test.'
    store.atomic(() => {
      store.messages.save({ id: 'msg_0', text: request })
      store.workItems.save({ id: 'wi_live', state: 'executing', originMessageId: 'msg_0' })
    })
    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'Also cover the export button',
      referencesWorkItem: 'wi_live',
    })
    expect(outcome.acknowledged).toBe(
      "Noted on “Add two small JavaScript modules as two separate tasks,…”: nothing is running on it, so I'll pick this up.",
    )
  })

  it('an explicit New request starts a second work item beside live work', async () => {
    const { service, store } = rig({ ack: 'On it', plan: { tasks: [] } } as MetaDecision)
    seedWork(store, 'wi_live', 'executing')
    store.workItems.save({ ...store.workItems.get('wi_live'), id: 'wi_live', repoId: REPO })
    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'Another thing',
      repoId: REPO,
      explicitNew: true,
    })
    expect(outcome.workItemId).toBeDefined()
    expect(outcome.workItemId).not.toBe('wi_live')
    expect(store.messages.get('msg_1')?.routing).toBe('new_work')
  })

  it('conversation: a reference-less message with live work present acks as context only', async () => {
    const { service, store } = rig(twoTaskPlan)
    seedWork(store, 'wi_live', 'executing')
    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'By the way, the demo is Friday',
    })

    expect(outcome.workItemId).toBeUndefined()
    expect(outcome.tasksCreated).toBe(0)
    expect(store.workItems.list()).toHaveLength(1)
    expect(store.tasks.list()).toHaveLength(0)
    expect(store.snapshot().effects).toHaveLength(0)
    expect(store.messages.get('msg_1')?.routing).toBe('conversation')
    expect(outcome.acknowledged).toContain('wi_live')
  })

  describe('a question beside running work (§12.1, owner ruling)', () => {
    const live = (store: MemoryRepositories) => {
      seedWork(store, 'wi_live', 'executing')
      store.atomic(() => {
        store.tasks.save({ id: 'task_live', workItemId: 'wi_live', status: 'active' })
      })
    }
    const everything = (workItemId: string): MetaDecision => ({
      ...twoTaskPlan,
      routes: [{ messageId: 'msg_1', decision: 'stop', workItemId: 'wi_live', at: NOW() }] as never,
      spawns: [{ taskId: 'task_live' }] as never,
      stops: [{ attemptId: 'att_live' }],
      cancels: [{ taskId: 'task_live' }],
      confirmations: [{ operation: { class: 'frontier_model' } }] as never,
      reports: [{ workItemId, summary: 'It waits for its second check.', artifacts: [] }],
    })
    const asking = (store: MemoryRepositories, seen: unknown[] = []) =>
      new MetaAgentService({
        store,
        effects: store.effects,
        brain: async (input) => {
          seen.push(input.wake)
          return everything('wi_live')
        },
        now: NOW,
      })

    it('gets a real turn, and its answer in the chat', async () => {
      const store = new MemoryRepositories()
      live(store)
      const seen: unknown[] = []
      const outcome = await asking(store, seen).onUserMessage({ messageId: 'msg_1', text: 'Why is it slow?' })

      expect(seen).toHaveLength(1)
      expect(outcome.acknowledged).toBe('It waits for its second check.')
      expect(store.messages.get('msg_1')).toMatchObject({ ackText: 'It waits for its second check.' })
      expect(store.workItems.get(outcome.workItemId as string)).toMatchObject({ state: 'done' })
    })

    it('starts, stops and changes nothing, whatever the planner tried', async () => {
      const store = new MemoryRepositories()
      live(store)
      const before = structuredClone(store.workItems.get('wi_live'))
      const outcome = await asking(store).onUserMessage({ messageId: 'msg_1', text: 'Why is it slow?' })

      expect(outcome.tasksCreated).toBe(0)
      expect(outcome.launchesEnqueued).toEqual([])
      expect(store.tasks.list().map((task) => task.id)).toEqual(['task_live'])
      expect(store.tasks.get('task_live')).toMatchObject({ status: 'active' })
      expect(store.workItems.get('wi_live')).toEqual(before)
      expect(store.confirmations.list()).toEqual([])
      expect(store.snapshot().effects.filter((row) => row.kind !== 'reply')).toEqual([])
      expect(store.events.read('work:wi_live')).toEqual([])
    })

    it('tells the planner what the turn is for', async () => {
      const store = new MemoryRepositories()
      live(store)
      const seen: { reason: string }[] = []
      await asking(store, seen).onUserMessage({ messageId: 'msg_1', text: 'Why is it slow?' })
      expect(seen[0]?.reason).toContain('answer it with report_result')
    })

    it('a question whose item was stopped runs no turn when it resumes', async () => {
      const store = new MemoryRepositories()
      live(store)
      store.atomic(() => {
        store.workItems.save({ id: 'wi_q', state: 'stopped', questionOnly: true, createdAt: NOW() })
        store.messages.save({ id: 'msg_1', text: 'Why is it slow?', workItemId: 'wi_q', createdAt: NOW() })
      })
      const seen: unknown[] = []
      const outcome = await asking(store, seen).onUserMessage({ messageId: 'msg_1', text: 'Why is it slow?' })
      expect(seen).toEqual([])
      expect(outcome.acknowledged).toContain('stopped')
      expect(store.workItems.get('wi_q')).toMatchObject({ state: 'stopped' })
    })

    it('a question on held work is answered, and the hold keeps its item open', async () => {
      const store = new MemoryRepositories()
      live(store)
      store.atomic(() => {
        store.workItems.save({
          id: 'wi_q',
          state: 'planning',
          questionOnly: true,
          hold: { at: NOW(), reason: 'wait' },
          createdAt: NOW(),
        })
        store.messages.save({ id: 'msg_1', text: 'Why is it slow?', workItemId: 'wi_q', createdAt: NOW() })
      })
      const outcome = await asking(store).onUserMessage({ messageId: 'msg_1', text: 'Why is it slow?' })
      expect(outcome.acknowledged).toBe('It waits for its second check.')
      expect(store.workItems.get('wi_q')).toMatchObject({ state: 'planning' })
      expect(store.tasks.list().map((task) => task.id)).toEqual(['task_live'])
    })

    it('a turn resumed after a crash is still a question', async () => {
      const store = new MemoryRepositories()
      live(store)
      store.atomic(() => {
        store.workItems.save({ id: 'wi_q', state: 'planning', questionOnly: true, createdAt: NOW() })
        store.messages.save({ id: 'msg_1', text: 'Why is it slow?', workItemId: 'wi_q', createdAt: NOW() })
      })
      await asking(store).onUserMessage({ messageId: 'msg_1', text: 'Why is it slow?' })
      expect(store.tasks.list().map((task) => task.id)).toEqual(['task_live'])
      expect(store.workItems.get('wi_q')).toMatchObject({ state: 'done' })
    })
  })

  it('a reference to a stopped work item is refused, never attached or resumed', async () => {
    const { service, store } = rig(twoTaskPlan)
    seedWork(store, 'wi_old', 'stopped')
    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'Pick that back up',
      referencesWorkItem: 'wi_old',
    })

    expect(outcome.acknowledged).toContain('stopped')
    expect(outcome.workItemId).toBeUndefined()
    expect(store.workItems.list()).toHaveLength(1)
    expect(store.tasks.list()).toHaveLength(0)
    expect(store.snapshot().effects).toHaveLength(0)
    expect(store.messages.get('msg_1')?.routing).toBe('stopped_refused')
    expect(store.events.read('work:wi_old')).toHaveLength(0)
  })

  it('duplicate message: replays the same ack and adds no second work item, task or attempt', async () => {
    const { service, store } = rig(twoTaskPlan)
    const message = { messageId: 'msg_1', text: 'Add audit-log viewing', repoId: REPO }
    const first = await service.onUserMessage(message)
    const second = await service.onUserMessage(message)

    expect(second).toEqual(first)
    expect(store.workItems.list()).toHaveLength(1)
    expect(store.tasks.list()).toHaveLength(2)
    expect(store.attempts.list()).toHaveLength(1)
  })

  it('the replay re-enqueues launches under their original keys: one coalesced row, proving the atomic enqueue', async () => {
    const { service, store } = rig(twoTaskPlan)
    const message = { messageId: 'msg_1', text: 'Add audit-log viewing', repoId: REPO }
    await service.onUserMessage(message)
    await service.onUserMessage(message)

    // Same kind + key twice (first turn, then the replay) — the queue keeps one row, and
    // MemoryEffects only accepts enqueue inside Store.atomic, so a row at all means both
    // enqueues ran in a transaction.
    const effects = store.snapshot().effects
    expect(effects).toHaveLength(1)
    expect(effects[0]?.key).toBe('att_1:1')
    expect(effects[0]?.attempts).toBe(0)
  })

  it('brain failure: ack says it could not start, the work item is stopped with an error event, nothing throws', async () => {
    const store = new MemoryRepositories()
    const exploding = async (): Promise<MetaDecision> => {
      throw new Error('engine offline')
    }
    const service = new MetaAgentService({ store, effects: store.effects, brain: exploding, now: NOW })
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'Add audit-log viewing' })

    expect(outcome.acknowledged).toBe('I could not start that')
    expect(outcome.tasksCreated).toBe(0)
    expect(outcome.launchesEnqueued).toEqual([])
    const work = store.workItems.get(outcome.workItemId!)
    expect(work?.state).toBe('stopped')
    const events = store.events.read(`work:${outcome.workItemId!}`)
    expect(events.map((event) => event.type)).toEqual([
      'planning_started',
      'meta_agent_error',
      'work_stopped',
    ])
    expect(events[1]?.body).toMatchObject({ error: 'engine offline' })
    expect(store.tasks.list()).toHaveLength(0)
    expect(store.snapshot().effects).toHaveLength(0)
  })

  it('invalid plan: the ack carries the first issue, no tasks are created, the work item is stopped', async () => {
    const { service, store } = rig(ghostDepPlan)
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'Add audit-log viewing' })

    expect(outcome.acknowledged).toContain("depends on 'task_missing'")
    expect(outcome.escalated).toBe(false)
    expect(store.tasks.list()).toHaveLength(0)
    expect(store.snapshot().effects).toHaveLength(0)
    expect(store.workItems.get(outcome.workItemId!)?.state).toBe('stopped')
    expect(store.events.read(`work:${outcome.workItemId!}`).map((event) => event.type)).toEqual([
      'planning_started',
      'plan_rejected',
      'work_stopped',
    ])
  })

  it('four consecutive invalid plans escalate; a valid plan resets the streak', async () => {
    const store = new MemoryRepositories()
    const decisions = [
      ghostDepPlan,
      ghostDepPlan,
      ghostDepPlan,
      ghostDepPlan,
      twoTaskPlan,
      ghostDepPlan,
      ghostDepPlan,
      ghostDepPlan,
      ghostDepPlan,
    ]
    let calls = 0
    const brain = async (): Promise<MetaDecision> => decisions[Math.min(calls++, decisions.length - 1)]!
    const service = new MetaAgentService({ store, effects: store.effects, brain, now: NOW })

    // Each rejected turn stops its work item, so every retry routes as new work again.
    for (let turn = 1; turn <= 3; turn++) {
      const outcome = await service.onUserMessage({ messageId: `msg_bad_${turn}`, text: 'again' })
      expect(outcome.escalated).toBe(false)
    }
    const fourth = await service.onUserMessage({ messageId: 'msg_bad_4', text: 'again' })
    expect(fourth.escalated).toBe(true)
    expect(fourth.acknowledged).toContain('Four plans in a row were invalid')
    expect(store.workItems.list().every((doc) => doc.state === 'stopped')).toBe(true)

    // A valid plan both works and resets the streak…
    const accepted = await service.onUserMessage({ messageId: 'msg_good', text: 'proper work' })
    expect(accepted.escalated).toBe(false)
    expect(accepted.tasksCreated).toBe(2)
    expect(store.workItems.get(accepted.workItemId!)?.state).toBe('executing')

    // …while it runs, further reference-less messages are conversation, so stop it first
    // (§12: a stopped item never counts as live) and the streak must build from zero.
    const acceptedDoc = store.workItems.get(accepted.workItemId!)!
    acceptedDoc.state = 'stopped'
    store.atomic(() => {
      store.workItems.save(acceptedDoc)
    })

    // …so the next escalation needs four fresh invalids, not three.
    for (let turn = 1; turn <= 3; turn++) {
      const outcome = await service.onUserMessage({ messageId: `msg_worse_${turn}`, text: 'again' })
      expect(outcome.escalated).toBe(false)
    }
    const fourthAgain = await service.onUserMessage({ messageId: 'msg_worse_4', text: 'again' })
    expect(fourthAgain.escalated).toBe(true)
  })

  it('without MEC_FAKE_ENGINE there is no slot: tasks are created but nothing launches', async () => {
    delete process.env.MEC_FAKE_ENGINE
    const { service, store } = rig(twoTaskPlan)
    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'Add audit-log viewing',
      repoId: REPO,
    })

    expect(outcome.tasksCreated).toBe(2)
    expect(outcome.launchesEnqueued).toEqual([])
    expect(store.attempts.list()).toHaveLength(0)
    expect(store.snapshot().effects).toHaveLength(0)
    expect(store.tasks.list()).toHaveLength(2)
    expect(store.workItems.get(outcome.workItemId!)?.state).toBe('executing')
  })

  it('an ack-only decision (no plan) records the ack and leaves the work item planning', async () => {
    const { service, store } = rig({ ack: 'Which repository is this work for?' })
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'Add audit-log viewing' })

    expect(outcome.acknowledged).toBe('Which repository is this work for?')
    expect(outcome.tasksCreated).toBe(0)
    expect(outcome.launchesEnqueued).toEqual([])
    expect(store.workItems.get(outcome.workItemId!)?.state).toBe('planning')
    expect(store.tasks.list()).toHaveLength(0)
    expect(store.messages.get('msg_1')?.ackText).toBe('Which repository is this work for?')
  })

  it('an unknown role in the plan is rejected with the registry issue in the ack', async () => {
    const unknownRole: MetaDecision = {
      ack: 'On it',
      plan: {
        tasks: [{ taskId: 'task_x', objective: 'Do things', dependsOn: [], role: 'wizard' }],
      },
    }
    const { service, store } = rig(unknownRole)
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'Add audit-log viewing' })

    expect(outcome.acknowledged).toContain("names role 'wizard'")
    expect(store.tasks.list()).toHaveLength(0)
    expect(store.workItems.get(outcome.workItemId!)?.state).toBe('stopped')
  })
})

describe('an answer reaches chat (§12.2: quick questions are answered directly)', () => {
  const answered = async (decision: MetaDecision, summary: string) => {
    const store = new MemoryRepositories()
    store.atomic(() => {
      store.engines.save({
        id: REPO,
        url: 'https://example.test/main',
        bootstrap: [],
        checks: [],
        trust: true,
      })
    })
    const service = new MetaAgentService({
      store,
      effects: store.effects,
      brain: async (input) => ({
        ...decision,
        reports: summary === '' ? [] : [{ workItemId: input.workItemId as string, summary, artifacts: [] }],
      }),
      now: NOW,
    })
    await service.onUserMessage({ messageId: 'msg_q', text: 'What does it do?', repoId: REPO })
    return store.messages.get('msg_q')
  }

  it('stores the reported answer on the message it answers', async () => {
    const line = await answered({ ack: 'I will answer that here.' }, 'It lists the audit log.')
    expect(line).toMatchObject({ ackText: 'It lists the audit log.' })
    expect(line?.replyText).toBeUndefined()
  })

  it('redacts it before the write', async () => {
    const key = `sk-ant-${'a1B2c3D4'.repeat(6)}`
    const line = await answered({ ack: 'Here.' }, `The key is ${key}`)
    expect(JSON.stringify(line)).not.toContain(key)
    expect(line?.ackText).toContain('[redacted:')
  })

  it('a report that only repeats the acknowledgement says nothing new', async () => {
    const line = await answered({ ack: 'Same words.' }, 'Same words.')
    expect(line?.ackText).toBe('Same words.')
    expect(line?.replyText).toBeUndefined()
  })

  it('a turn that asks a question has its card: the report is not chat', async () => {
    const line = await answered(
      { ack: 'One thing first.', questions: [{ id: 'q1', question: 'Which?', options: [], at: NOW() }] },
      'I asked which one.',
    )
    expect(line?.ackText).toBe('One thing first.')
    expect(line?.replyText).toBeUndefined()
  })

  it('a plan is not narrated (§12.7)', async () => {
    const line = await answered(twoTaskPlan, 'Planned two tasks.')
    expect(line?.ackText).not.toContain('Planned two tasks.')
    expect(line?.replyText).toBeUndefined()
  })

  it('a wake speaks its report, because it had something new (§12.7)', async () => {
    const store = new MemoryRepositories()
    store.atomic(() => {
      store.engines.save({
        id: REPO,
        url: 'https://example.test/main',
        bootstrap: [],
        checks: [],
        trust: true,
      })
    })
    seedWork(store, 'wi_wake', 'executing')
    store.atomic(() => {
      store.workItems.save({ ...store.workItems.get('wi_wake'), repoId: REPO } as never)
    })
    const service = new MetaAgentService({
      store,
      effects: store.effects,
      brain: async () => ({
        ack: 'Noted.',
        reports: [{ workItemId: 'wi_wake', summary: 'A specialist finished.', artifacts: [] }],
      }),
      now: NOW,
    })
    await service.onWake({ reason: 'report', workItemId: 'wi_wake', causationId: 'cause_1' })
    const line = store.messages.list({ workItemId: 'wi_wake' })[0]
    expect(line?.ackText).toBe('A specialist finished.')
    expect(line?.replyText).toBeUndefined()
  })

  it('a turn with no report stores nothing', async () => {
    const line = await answered({ ack: 'Noted.' }, '')
    expect(line?.ackText).toBe('Noted.')
    expect(line?.replyText).toBeUndefined()
  })
})
