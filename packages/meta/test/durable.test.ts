import type { EffectKind, Json } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPolicy } from '../../policy/src/policy'
import type { MetaBrain, MetaDecision } from '../src'
import { launchAuthority, MetaAgentService, saveProcessing, stableMessageId } from '../src'

/**
 * Durable commands (M1.4b, spec §6, §12.1, §17, §20, §26): a message keeps one identity across
 * retries and crashes, and a wake is a queue row deduped by what caused it, so neither a retry
 * nor a replayed row runs a second planner turn.
 */

const NOW = '2026-11-05T12:00:00.000Z'
const POLICY = '{"preAuthorised":{}}'

const plan: MetaDecision = {
  ack: 'On it',
  plan: { tasks: [{ taskId: 'a', objective: 'Do a', dependsOn: [], role: 'implementer' }] },
}

type Row = { kind: EffectKind; key: string; payload: Json }

type MemoryQueue = { snapshot(): [string, Row][]; restore(rows: [string, Row][]): void }

const queueOf = (store: MemoryRepositories): MemoryQueue => store.effects as unknown as MemoryQueue

const rowsOf = (store: MemoryRepositories, kind: EffectKind): Row[] =>
  queueOf(store)
    .snapshot()
    .map(([, row]) => row)
    .filter((row) => row.kind === kind)

/** What a drained queue looks like: success deletes the row. */
const drain = (store: MemoryRepositories): void => queueOf(store).restore([])

/** A brain counting its calls, staying on its await until the test answers. */
const heldBrain = () => {
  const answers: ((decision: MetaDecision) => void)[] = []
  let calls = 0
  const brain: MetaBrain = () => {
    calls += 1
    return new Promise((resolve) => answers.push(resolve))
  }
  return { brain, calls: () => calls, answer: (decision: MetaDecision) => answers.shift()!(decision) }
}

const countingBrain = (decision: MetaDecision) => {
  let calls = 0
  const brain: MetaBrain = async () => {
    calls += 1
    return decision
  }
  return { brain, calls: () => calls }
}

const rig = (brain: MetaBrain, store = new MemoryRepositories()) => {
  if (store.engines.get('repo_a') === undefined) {
    store.atomic(() => {
      store.engines.save({
        id: 'repo_a',
        url: 'https://example.test/a',
        bootstrap: [],
        checks: [],
        trust: true,
      })
    })
  }
  const service = new MetaAgentService({
    store,
    effects: store.effects,
    brain,
    now: () => NOW,
    policyText: POLICY,
  })
  return { service, store }
}

/** Leaves what a crash leaves: the admission committed, the brain never answered. */
const crashedAdmission = async (messageId = 'msg_1') => {
  const held = heldBrain()
  const { service, store } = rig(held.brain)
  void service.onUserMessage({ messageId, text: 'do the thing', repoId: 'repo_a' })
  await Promise.resolve()
  const workItemId = String(store.workItems.list()[0]?.id)
  return { store, workItemId }
}

const openQuestion = (store: MemoryRepositories, workItemId: string): void => {
  store.atomic(() => {
    store.engines.save({
      id: 'question/q_1',
      questionId: 'q_1',
      question: 'Which one?',
      options: ['a', 'b'],
      workItemId,
      status: 'open',
    })
  })
}

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
})

afterEach(() => {
  delete process.env.MEC_FAKE_ENGINE
})

describe('stable message identity (§12.1, §20 Duplicate dispatch)', () => {
  it('derives one id from one key, and different ids from different keys', () => {
    expect(stableMessageId('k1')).toBe(stableMessageId('k1'))
    expect(stableMessageId('k1')).not.toBe(stableMessageId('k2'))
    expect(stableMessageId('k1')).toMatch(/^msg_[0-9a-f]{24}$/)
  })

  it('keeps the idempotency key and repo on every later save of the message', async () => {
    const { service, store } = rig(async () => plan)
    await service.onUserMessage({
      messageId: 'msg_1',
      text: 'go',
      repoId: 'repo_a',
      idempotencyKey: 'k1',
    })

    expect(store.messages.get('msg_1')).toMatchObject({
      idempotencyKey: 'k1',
      repoId: 'repo_a',
      ackText: 'On it',
    })
  })

  it('crash after work created resumes the same message', async () => {
    const { store, workItemId } = await crashedAdmission()
    const next = countingBrain(plan)
    const { service } = rig(next.brain, store)

    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'do the thing',
      repoId: 'repo_a',
    })

    expect(outcome.workItemId).toBe(workItemId)
    expect(outcome.tasksCreated).toBe(1)
    expect(next.calls()).toBe(1)
    expect(store.workItems.list()).toHaveLength(1)
    expect(store.messages.list()).toHaveLength(1)
  })

  it('a receipt-less message resumes before routing even with its own work live', async () => {
    const { store } = await crashedAdmission()
    const next = countingBrain({ ack: 'Planned' })
    const { service } = rig(next.brain, store)

    await service.onUserMessage({ messageId: 'msg_1', text: 'do the thing', repoId: 'repo_a' })

    expect(next.calls()).toBe(1)
    expect(store.messages.get('msg_1')).toMatchObject({ routing: 'new_work', ackText: 'Planned' })
  })

  it('receipt-less message on stopped work writes a receipt and calls no brain', async () => {
    const { store, workItemId } = await crashedAdmission()
    const next = countingBrain(plan)
    const { service } = rig(next.brain, store)
    service.stopWork(workItemId)

    const outcome = await service.onUserMessage({
      messageId: 'msg_1',
      text: 'do the thing',
      repoId: 'repo_a',
    })

    expect(next.calls()).toBe(0)
    expect(outcome.tasksCreated).toBe(0)
    expect(store.messages.get('msg_1')).toMatchObject({ workItemId, routing: 'new_work' })
    expect(typeof store.messages.get('msg_1')?.ackText).toBe('string')
  })

  it('a receipt-less message on work past planning is noted on it, with no brain call', async () => {
    const { store, workItemId } = await crashedAdmission()
    store.atomic(() => {
      const work = store.workItems.get(workItemId)!
      store.workItems.save({ ...work, state: 'executing' })
    })
    const next = countingBrain(plan)
    const { service } = rig(next.brain, store)

    await service.onUserMessage({ messageId: 'msg_1', text: 'do the thing', repoId: 'repo_a' })

    expect(next.calls()).toBe(0)
    expect(store.messages.get('msg_1')).toMatchObject({ workItemId, routing: 'attach' })
  })

  it('concurrent retry shares one turn', async () => {
    const held = heldBrain()
    const { service, store } = rig(held.brain)
    const input = { messageId: 'msg_1', text: 'go', repoId: 'repo_a' }

    const first = service.onUserMessage(input)
    const second = service.onUserMessage(input)
    await Promise.resolve()
    held.answer(plan)

    const [a, b] = await Promise.all([first, second])
    expect(held.calls()).toBe(1)
    expect(b).toEqual(a)
    expect(store.tasks.list()).toHaveLength(1)
  })

  it('a turn that ended leaves nothing in flight, so a later retry replays its receipt', async () => {
    const next = countingBrain(plan)
    const { service } = rig(next.brain)
    const input = { messageId: 'msg_1', text: 'go', repoId: 'repo_a' }

    const first = await service.onUserMessage(input)
    const again = await service.onUserMessage(input)

    expect(next.calls()).toBe(1)
    expect(again.acknowledged).toBe(first.acknowledged)
  })

  it('a replay queues no launch for work that is not executing', async () => {
    const next = countingBrain(plan)
    const { service, store } = rig(next.brain)
    const input = { messageId: 'msg_1', text: 'go', repoId: 'repo_a' }
    const outcome = await service.onUserMessage(input)
    drain(store)
    service.stopWork(outcome.workItemId!)

    await service.onUserMessage(input)

    expect(rowsOf(store, 'launch')).toEqual([])
  })

  it('a replayed launch row on executing work is dropped by the gate once its attempt moved on', async () => {
    const next = countingBrain(plan)
    const { service, store } = rig(next.brain)
    const input = { messageId: 'msg_1', text: 'go', repoId: 'repo_a' }
    await service.onUserMessage(input)
    drain(store)
    store.atomic(() => {
      store.attempts.save({ ...store.attempts.get('att_1')!, state: 'running' })
    })

    await service.onUserMessage(input)

    const row = rowsOf(store, 'launch')[0]!
    expect(launchAuthority(store, row.payload, NOW, loadPolicy(POLICY).versionHash)).toEqual({
      verdict: 'drop',
      reason: 'attempt_not_queued',
    })
  })
})

describe('durable wakes (§6, §17, §26)', () => {
  const planning = async () => {
    const next = countingBrain({ ack: 'Tell me which' })
    const { service, store } = rig(next.brain)
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: 'repo_a' })
    return { next, service, store, workItemId: outcome.workItemId! }
  }

  it('wake deduped by causation', async () => {
    const { service, store, workItemId } = await planning()
    const wake = { causationId: 'question/q_1', reason: 'question answered', workItemId }

    store.atomic(() => {
      service.enqueueWake(wake)
      service.enqueueWake({ ...wake, detail: 'again' })
    })

    expect(rowsOf(store, 'relay').map((row) => row.key)).toEqual(['wake:question/q_1'])
  })

  it('wake replay after a drained row does not run a second turn', async () => {
    const { next, service, store, workItemId } = await planning()
    store.atomic(() =>
      service.enqueueWake({ causationId: 'question/q_1', reason: 'question answered', workItemId }),
    )
    const payload = rowsOf(store, 'relay')[0]!.payload

    await service.runRelay(payload)
    const turns = next.calls()
    await service.runRelay(payload)

    expect(turns).toBe(2)
    expect(next.calls()).toBe(2)
  })

  it('a wake without a causation runs each time', async () => {
    const { next, service, workItemId } = await planning()

    await service.onWake({ reason: 'timer', workItemId })
    await service.onWake({ reason: 'timer', workItemId })

    expect(next.calls()).toBe(3)
  })

  it('answering a question enqueues exactly one relay in the same transaction', async () => {
    const { service, store, workItemId } = await planning()
    openQuestion(store, workItemId)
    const commits = store.commits

    const result = await service.onQuestionAnswered('q_1', 'a')

    expect(result.status).toBe('answered')
    expect(store.commits).toBe(commits + 1)
    expect(store.engines.get('question/q_1')).toMatchObject({ status: 'answered', answer: 'a' })
    expect(rowsOf(store, 'relay')).toHaveLength(1)
    expect(rowsOf(store, 'relay')[0]).toMatchObject({
      key: 'wake:question/q_1',
      payload: {
        causationId: 'question/q_1',
        reason: 'question answered',
        detail: 'question "Which one?" answered: a',
        workItemId,
      },
    })
  })

  it('an answer does not run the planner itself: the queue does', async () => {
    const { next, service, store, workItemId } = await planning()
    openQuestion(store, workItemId)

    await service.onQuestionAnswered('q_1', 'a')

    expect(next.calls()).toBe(1)
  })

  it('an answer is redacted before it is stored', async () => {
    const { service, store, workItemId } = await planning()
    openQuestion(store, workItemId)
    const secret = `sk-ant-api03-${'a'.repeat(40)}`

    const result = await service.onQuestionAnswered('q_1', `use ${secret}`)

    const stored = JSON.stringify([
      store.engines.get('question/q_1'),
      store.events.read('question/q_1'),
      rowsOf(store, 'relay'),
      result,
    ])
    expect(stored).not.toContain(secret)
    expect(store.engines.get('question/q_1')?.answer).toContain('use ')
  })

  it('an answer to a question that is not open is refused and wakes nothing', async () => {
    const { service, store, workItemId } = await planning()
    openQuestion(store, workItemId)
    await service.onQuestionAnswered('q_1', 'a')
    drain(store)

    const again = await service.onQuestionAnswered('q_1', 'b')
    const missing = await service.onQuestionAnswered('q_gone', 'b')

    expect(again.status).toBe('not_open')
    expect(missing.status).toBe('missing')
    expect(store.engines.get('question/q_1')?.answer).toBe('a')
    expect(rowsOf(store, 'relay')).toEqual([])
  })

  it('an answer on ended work is recorded and queues no wake', async () => {
    const { service, store, workItemId } = await planning()
    openQuestion(store, workItemId)
    service.stopWork(workItemId)

    const result = await service.onQuestionAnswered('q_1', 'a')

    expect(result.status).toBe('answered')
    expect(rowsOf(store, 'relay')).toEqual([])
    expect(store.events.read(`work:${workItemId}`).at(-1)?.type).toBe('wake_refused')
  })
})

describe('boot resume (§20 App crash, §26 Acknowledgement)', () => {
  it('queues one relay per receipt-less planning message and runs no brain', async () => {
    const { store } = await crashedAdmission()
    const next = countingBrain(plan)
    const { service } = rig(next.brain, store)

    service.enqueueResumes()
    service.enqueueResumes()

    expect(next.calls()).toBe(0)
    expect(rowsOf(store, 'relay').map((row) => row.key)).toEqual(['resume:msg_1'])
  })

  it('leaves answered messages and ended work alone', async () => {
    const { store, workItemId } = await crashedAdmission()
    const { service } = rig(countingBrain(plan).brain, store)
    service.stopWork(workItemId)
    await service.onUserMessage({ messageId: 'msg_2', text: 'other', repoId: 'repo_a' })

    service.enqueueResumes()

    expect(rowsOf(store, 'relay')).toEqual([])
  })

  it('a resume relay answers with the stored text and repo, once', async () => {
    const { store, workItemId } = await crashedAdmission()
    const seen: string[] = []
    const { service } = rig(async (context) => {
      seen.push(context.messageText)
      return plan
    }, store)
    service.enqueueResumes()
    const payload = rowsOf(store, 'relay')[0]!.payload

    await service.runRelay(payload)
    await service.runRelay(payload)

    expect(seen).toEqual(['do the thing'])
    expect(store.messages.get('msg_1')).toMatchObject({ workItemId, repoId: 'repo_a', ackText: 'On it' })
  })

  it('a resume relay for a message that is gone does nothing', async () => {
    const next = countingBrain(plan)
    const { service } = rig(next.brain)

    await service.runRelay({ messageId: 'msg_gone' })

    expect(next.calls()).toBe(0)
  })
})

describe('chat during Pause (decision #27, §20)', () => {
  const paused = (brain: MetaBrain) => {
    const { service, store } = rig(brain)
    store.atomic(() => saveProcessing(store, { paused: true, pausedAt: NOW }, NOW))
    return { service, store }
  }

  it('a new-work message is stored with no planner turn and no receipt', async () => {
    const next = countingBrain(plan)
    const { service, store } = paused(next.brain)

    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: 'repo_a' })

    expect(next.calls()).toBe(0)
    expect(outcome.tasksCreated).toBe(0)
    expect(store.messages.get('msg_1')).toMatchObject({ text: 'go', routing: 'new_work' })
    expect(store.messages.get('msg_1')?.ackText).toBeUndefined()
    expect(String(store.workItems.list()[0]?.state)).toBe('planning')
  })

  it('a retry during the pause runs no planner turn either', async () => {
    const next = countingBrain(plan)
    const { service, store } = paused(next.brain)
    const input = { messageId: 'msg_1', text: 'go', repoId: 'repo_a' }

    const first = await service.onUserMessage(input)
    const again = await service.onUserMessage(input)

    expect(next.calls()).toBe(0)
    expect(again).toEqual(first)
    expect(store.workItems.list()).toHaveLength(1)
  })

  it('its turn runs from the relay after resume, on the same work item', async () => {
    const next = countingBrain(plan)
    const { service, store } = paused(next.brain)
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: 'repo_a' })
    store.atomic(() => saveProcessing(store, { paused: false }, NOW))

    service.enqueueResumes()
    await service.runRelay(rowsOf(store, 'relay')[0]!.payload)

    expect(next.calls()).toBe(1)
    expect(store.workItems.list()).toHaveLength(1)
    expect(store.messages.get('msg_1')).toMatchObject({ workItemId, ackText: 'On it' })
  })

  it('a relay caught mid-flight by a pause still finishes its turn', async () => {
    const { store } = await crashedAdmission()
    const next = countingBrain(plan)
    const { service } = rig(next.brain, store)
    service.enqueueResumes()
    const payload = rowsOf(store, 'relay')[0]!.payload
    store.atomic(() => saveProcessing(store, { paused: true, pausedAt: NOW }, NOW))

    await service.runRelay(payload)

    expect(next.calls()).toBe(1)
  })

  it('a message that needs no planner is still answered during the pause', async () => {
    const next = countingBrain(plan)
    const { service, store } = rig(next.brain)
    await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: 'repo_a' })
    store.atomic(() => saveProcessing(store, { paused: true, pausedAt: NOW }, NOW))

    const outcome = await service.onUserMessage({ messageId: 'msg_2', text: 'fyi', repoId: 'repo_a' })

    expect(next.calls()).toBe(1)
    expect(outcome.acknowledged).toContain('Noted')
  })
})
