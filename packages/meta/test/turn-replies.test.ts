// Core coordination, from real Claude runs A and C2: what a turn that plans nothing says, and
// where it says it. A message's receipt is the chat's line (§12.2), the report is what is spoken
// (§6), and a wake with nothing new says nothing (§12.7). The same decision is asked once (§12.6).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { StoreDoc } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MetaAgentService, type MetaBrain, type MetaDecision, repoFields } from '../src'
import { DEFAULT_PLANNER_PROTOCOL } from '../src/brain'

const NOW = () => '2026-11-06T12:00:00.000Z'
const REPO = 'repo_a'
const OTHER_REPO = 'repo_b'
const POLICY = '{"preAuthorised":{}}'
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const BLOCK = 'repairs used up (2 of 2). What remains: release-stamp'

function rig(decisions: MetaDecision[]) {
  const store = new MemoryRepositories()
  store.atomic(() => {
    for (const id of [REPO, OTHER_REPO]) {
      store.engines.save({ id, url: `https://example.test/${id}`, bootstrap: [], checks: [], trust: true })
    }
  })
  const brain: MetaBrain = async () => decisions.shift() as MetaDecision
  const service = new MetaAgentService({ store, effects: store.effects, brain, now: NOW })
  return { store, service }
}

const report = (workItemId: string, summary: string) => ({ workItemId, summary, artifacts: [] })
const question = (id: string, text: string, workItemId?: string) => ({
  id,
  question: text,
  options: [],
  at: NOW(),
  ...(workItemId !== undefined && { workItemId }),
})

/** The turn context hands the brain its own work item, so a scripted decision reads it there. */
function answering(summary: string, target?: string): MetaBrain {
  return async ({ workItemId }) => ({
    ack: 'You are asking a question, so I will answer it.',
    reports: [report(target ?? (workItemId as string), summary)],
  })
}

function withBrain(store: MemoryRepositories, brain: MetaBrain): MetaAgentService {
  return new MetaAgentService({ store, effects: store.effects, brain, now: NOW })
}

function seedWork(store: MemoryRepositories, id: string, extra: StoreDoc = {}, repoId = REPO): void {
  store.atomic(() => {
    store.workItems.save({
      id,
      state: 'executing',
      originMessageId: 'msg_origin',
      mandate: { originMessageId: 'msg_origin', status: 'active' },
      ...repoFields(store, repoId, POLICY),
      ...extra,
    })
  })
}

function blockedWork(store: MemoryRepositories, id = 'wi_1'): void {
  seedWork(store, id, { state: 'blocked', blockedReason: BLOCK, planRevision: 1 })
  store.atomic(() => {
    store.tasks.save({ id: 'task_a', workItemId: id, repoId: REPO, status: 'blocked', blockedReason: BLOCK })
  })
}

const eventTypes = (store: MemoryRepositories, stream: string): string[] =>
  store.events.read(stream).map((event) => event.type)

const wakeRows = (store: MemoryRepositories): StoreDoc[] =>
  store.messages.list({}).filter((doc) => String(doc.id).startsWith('msg_wake_'))

const wakeRow = (store: MemoryRepositories): StoreDoc => wakeRows(store)[0] as StoreDoc

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
})
afterEach(() => {
  delete process.env.MEC_FAKE_ENGINE
})

describe('a turn that plans nothing answers on the message that asked (§6, §12.2)', () => {
  it('speaks the report, not the acknowledgement, and ends the question’s work item', async () => {
    const { store } = rig([])
    const service = withBrain(store, answering('It returns hello-world.md.'))
    const outcome = await service.onUserMessage({ messageId: 'msg_q', text: 'What?', repoId: REPO })

    expect(outcome.acknowledged).toBe('It returns hello-world.md.')
    expect(store.messages.get('msg_q')?.ackText).toBe('It returns hello-world.md.')
    expect(store.workItems.get(outcome.workItemId as string)?.state).toBe('done')
    expect(eventTypes(store, `work:${String(outcome.workItemId)}`)).toContain('work_answered')
  })

  it('the answer lands on the message when the report names the work it is about', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_built', { state: 'integrating' })
    const service = withBrain(store, answering('It returns hello-world.md.', 'wi_built'))
    const outcome = await service.onUserMessage({
      messageId: 'msg_q',
      text: 'What did wi_built return?',
      repoId: REPO,
      explicitNew: true,
    })

    expect(store.messages.get('msg_q')?.ackText).toBe('It returns hello-world.md.')
    expect(store.workItems.get(outcome.workItemId as string)?.state).toBe('done')
    expect(eventTypes(store, 'work:wi_built')).toContain('result_reported')
    expect(eventTypes(store, `work:${String(outcome.workItemId)}`)).not.toContain('result_reported')
  })

  it('a turn that stopped at its acknowledgement keeps its words, and finished nothing', async () => {
    const { store, service } = rig([{ ack: 'It returns hello-world.md.' }])
    const outcome = await service.onUserMessage({ messageId: 'msg_q', text: 'What?', repoId: REPO })

    expect(store.messages.get('msg_q')?.ackText).toBe('It returns hello-world.md.')
    expect(store.workItems.get(outcome.workItemId as string)?.state).toBe('planning')
  })

  it('a report fenced out of this repository is not spoken here', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_other', {}, OTHER_REPO)
    const service = withBrain(store, answering('Another repository’s words.', 'wi_other'))
    await service.onUserMessage({ messageId: 'msg_q', text: 'What?', repoId: REPO })

    expect(store.messages.get('msg_q')?.ackText).toBe('You are asking a question, so I will answer it.')
  })

  it('a reply carrying a key is stored redacted', async () => {
    const { store } = rig([])
    const service = withBrain(store, answering(`The key was ${KEY}.`))
    await service.onUserMessage({ messageId: 'msg_q', text: 'What?', repoId: REPO })

    expect(String(store.messages.get('msg_q')?.ackText)).not.toContain(KEY)
  })

  it('a turn that asks the person stays planning, and its acknowledgement stands', async () => {
    const { store } = rig([])
    const service = withBrain(store, async ({ workItemId }) => ({
      ack: 'I need one thing from you.',
      questions: [question('q_1', 'Which file?', workItemId)],
      reports: [report(workItemId as string, 'Asked which file.')],
    }))
    const outcome = await service.onUserMessage({ messageId: 'msg_q', text: 'Fix it', repoId: REPO })

    expect(store.messages.get('msg_q')?.ackText).toBe('I need one thing from you.')
    expect(store.workItems.get(outcome.workItemId as string)?.state).toBe('planning')
  })

  it('a turn that opens a card stays planning', async () => {
    const { store } = rig([])
    const service = withBrain(store, async ({ workItemId }) => ({
      ack: 'This needs your approval.',
      reports: [report(workItemId as string, 'Asked for approval.')],
      confirmations: [
        {
          id: 'conf_1',
          cls: 'frontier_model',
          operationHash: 'hash',
          expiresAt: '2026-11-07T12:00:00.000Z',
          operation: { class: 'frontier_model' },
          evidence: {},
          ...(workItemId !== undefined && { workItemId }),
        },
      ],
    }))
    const outcome = await service.onUserMessage({ messageId: 'msg_q', text: 'Use opus', repoId: REPO })

    expect(store.workItems.get(outcome.workItemId as string)?.state).toBe('planning')
  })

  it('a turn that holds its work leaves it for the owner to lift', async () => {
    const { store } = rig([])
    const service = withBrain(store, async ({ workItemId }) => ({
      ack: 'Holding.',
      reports: [report(workItemId as string, 'Held.')],
      routes: [{ messageId: 'msg_q', decision: 'hold', target: workItemId as string }],
    }))
    const outcome = await service.onUserMessage({ messageId: 'msg_q', text: 'Wait', repoId: REPO })

    expect(store.workItems.get(outcome.workItemId as string)?.state).toBe('planning')
  })

  it('a later report does not end work still waiting on an earlier question', async () => {
    const { store } = rig([])
    const asking = withBrain(store, async ({ workItemId }) => ({
      ack: 'Which file?',
      questions: [question('q_1', 'Which file?', workItemId)],
    }))
    const outcome = await asking.onUserMessage({ messageId: 'msg_q', text: 'Fix it', repoId: REPO })
    await withBrain(store, answering('Still waiting for you.')).onWake({
      causationId: 'c',
      reason: 'message released',
      workItemId: outcome.workItemId as string,
    })

    expect(store.workItems.get(outcome.workItemId as string)?.state).toBe('planning')
  })

  it('a later report does not end work still waiting on a card', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_1', { state: 'planning' })
    store.atomic(() => {
      store.confirmations.save({ id: 'conf_1', cls: 'push', status: 'pending', workItemId: 'wi_1' })
    })
    await withBrain(store, answering('Still waiting for you.')).onWake({
      causationId: 'c',
      reason: 'message released',
      workItemId: 'wi_1',
    })

    expect(store.workItems.get('wi_1')?.state).toBe('planning')
  })

  it('a report on work that holds tasks ends nothing', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_1', { state: 'planning' })
    store.atomic(() => {
      store.tasks.save({ id: 'task_a', workItemId: 'wi_1', repoId: REPO, status: 'ready' })
    })
    await withBrain(store, answering('Planned already.')).onWake({
      causationId: 'c',
      reason: 'message released',
      workItemId: 'wi_1',
    })

    expect(store.workItems.get('wi_1')?.state).toBe('planning')
  })

  it('a follow-up’s wake speaks the report too', async () => {
    const { store } = rig([])
    blockedWork(store)
    const service = withBrain(store, answering('The release-stamp check is what stops it.'))
    await service.onWake({
      causationId: 'message:msg_f',
      reason: 'follow-up with no running work',
      detail: 'Which check?',
      workItemId: 'wi_1',
    })

    expect(wakeRow(store).ackText).toBe('The release-stamp check is what stops it.')
    expect(wakeRow(store).quiet).toBeUndefined()
  })

  it('an answered question that needs no plan ends its work item', async () => {
    const { store } = rig([])
    const asking = withBrain(store, async ({ workItemId }) => ({
      ack: 'Which file?',
      questions: [question('q_1', 'Which file?', workItemId)],
    }))
    const outcome = await asking.onUserMessage({ messageId: 'msg_q', text: 'Fix it', repoId: REPO })
    asking.onQuestionAnswered('q_1', 'The readme.')
    const service = withBrain(store, answering('Then nothing needs changing.'))
    await service.onWake({
      causationId: 'question/q_1',
      reason: 'question answered',
      workItemId: outcome.workItemId as string,
    })

    expect(store.workItems.get(outcome.workItemId as string)?.state).toBe('done')
  })
})

describe('a wake with nothing new says nothing (§12.7)', () => {
  const noted: MetaBrain = async ({ workItemId }) => ({
    ack: 'Noted the report; no new planning is needed.',
    reports: [report(workItemId as string, 'No new plan.')],
  })

  it.each([['report ready'], ['report dropped'], ['specialist question']])(
    '%s with no plan and nothing asked is kept off the chat',
    async (reason) => {
      const { store } = rig([])
      seedWork(store, 'wi_1')
      await withBrain(store, noted).onWake({ causationId: 'c', reason, workItemId: 'wi_1' })

      expect(wakeRow(store).quiet).toBe(true)
      // The receipt still lands, so a replayed row runs nothing.
      expect(typeof wakeRow(store).ackText).toBe('string')
    },
  )

  it.each([
    ['report blocked'],
    ['report failed'],
    ['work parked'],
    ['question answered'],
    ['message released'],
    ['follow-up handed back'],
    ['answer not delivered'],
  ])('%s is spoken', async (reason) => {
    const { store } = rig([])
    seedWork(store, 'wi_1')
    await withBrain(store, noted).onWake({ causationId: 'c', reason, workItemId: 'wi_1' })

    expect(wakeRow(store).quiet).toBeUndefined()
    expect(wakeRow(store).ackText).toBe('No new plan.')
  })

  it('a wake that replans is spoken', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_1')
    const replanning: MetaBrain = async () => ({
      ack: 'Replanning.',
      plan: { tasks: [{ taskId: 'task_1', objective: 'Do', dependsOn: [], role: 'implementer' }] },
    })
    await withBrain(store, replanning).onWake({
      causationId: 'c',
      reason: 'report ready',
      workItemId: 'wi_1',
    })

    expect(wakeRow(store).quiet).toBeUndefined()
  })

  it('a wake that asks something new is spoken', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_1')
    const asking: MetaBrain = async ({ workItemId }) => ({
      ack: 'One question.',
      questions: [question('q_1', 'Which file?', workItemId)],
    })
    await withBrain(store, asking).onWake({ causationId: 'c', reason: 'report ready', workItemId: 'wi_1' })

    expect(wakeRow(store).quiet).toBeUndefined()
  })

  it('the second word on the same block stays quiet, and a new block is spoken', async () => {
    const { store } = rig([])
    blockedWork(store)
    const service = withBrain(store, noted)
    await service.onWake({ causationId: 'c1', reason: 'report blocked', workItemId: 'wi_1' })
    await service.onWake({ causationId: 'c2', reason: 'report blocked', workItemId: 'wi_1' })
    expect(wakeRows(store).filter((doc) => doc.quiet === true)).toHaveLength(1)

    store.atomic(() => {
      const work = store.workItems.get('wi_1') as StoreDoc
      store.workItems.save({ ...work, blockedReason: 'another reason' })
    })
    await service.onWake({ causationId: 'c3', reason: 'report blocked', workItemId: 'wi_1' })
    expect(wakeRows(store).filter((doc) => doc.quiet === true)).toHaveLength(1)
  })

  it('a person’s follow-up on a block already told still gets its reply', async () => {
    const { store } = rig([])
    blockedWork(store)
    const service = withBrain(store, noted)
    await service.onWake({ causationId: 'c1', reason: 'report blocked', workItemId: 'wi_1' })
    await service.onWake({
      causationId: 'c2',
      reason: 'follow-up with no running work',
      workItemId: 'wi_1',
    })

    expect(wakeRows(store).filter((doc) => doc.quiet === true)).toEqual([])
  })

  it('a replayed quiet wake runs no second turn', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_1')
    let turns = 0
    const counting: MetaBrain = async (context) => {
      turns += 1
      return noted(context)
    }
    const service = withBrain(store, counting)
    await service.onWake({ causationId: 'c', reason: 'report ready', workItemId: 'wi_1' })
    await service.onWake({ causationId: 'c', reason: 'report ready', workItemId: 'wi_1' })

    expect(turns).toBe(1)
  })
})

describe('the same decision is asked once (§12.6)', () => {
  const asks =
    (id: string, text: string): MetaBrain =>
    async ({ workItemId }) => ({
      ack: 'Asking.',
      questions: [question(id, text, workItemId)],
      reports: [report(workItemId as string, 'No new plan: still blocked.')],
    })
  const questions = (store: MemoryRepositories): StoreDoc[] =>
    store.engines.list({}).filter((doc) => String(doc.id).startsWith('question/'))

  it('work stuck on a block, with nothing moved, asks one question however it is worded', async () => {
    const { store } = rig([])
    blockedWork(store)
    await withBrain(store, asks('q_1', 'Can the release owner issue the stamp?')).onWake({
      causationId: 'c1',
      reason: 'report blocked',
      workItemId: 'wi_1',
    })
    withBrain(store, asks('q_x', 'unused')).onQuestionAnswered('q_1', 'Your call: go ahead.')
    await withBrain(store, asks('q_2', 'Please get RELEASE_STAMP issued for that commit.')).onWake({
      causationId: 'question/q_1',
      reason: 'question answered',
      workItemId: 'wi_1',
    })

    expect(questions(store).map((doc) => doc.questionId)).toEqual(['q_1'])
    expect(eventTypes(store, 'work:wi_1')).toContain('question_repeat_refused')
    // Nothing new was asked, so the report is what a person reads.
    expect(wakeRows(store).at(-1)?.ackText).toBe('No new plan: still blocked.')
  })

  it('an open question is not repeated while it waits', async () => {
    const { store } = rig([])
    blockedWork(store)
    const first = asks('q_1', 'Can the release owner issue the stamp?')
    await withBrain(store, first).onWake({ causationId: 'c1', reason: 'report blocked', workItemId: 'wi_1' })
    await withBrain(store, asks('q_2', 'Who issues the stamp?')).onWake({
      causationId: 'c2',
      reason: 'work parked',
      workItemId: 'wi_1',
    })

    expect(questions(store)).toHaveLength(1)
  })

  it('the same words are the same decision, whatever the case and spacing', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_1')
    await withBrain(store, asks('q_1', 'Which file?')).onWake({
      causationId: 'c1',
      reason: 'report ready',
      workItemId: 'wi_1',
    })
    await withBrain(store, asks('q_2', '  which   FILE? ')).onWake({
      causationId: 'c2',
      reason: 'report ready',
      workItemId: 'wi_1',
    })

    expect(questions(store)).toHaveLength(1)
  })

  it('a different question on work that is not stuck still reaches the person', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_1')
    await withBrain(store, asks('q_1', 'Which file?')).onWake({
      causationId: 'c1',
      reason: 'report ready',
      workItemId: 'wi_1',
    })
    await withBrain(store, asks('q_2', 'Which port?')).onWake({
      causationId: 'c2',
      reason: 'report ready',
      workItemId: 'wi_1',
    })

    expect(questions(store)).toHaveLength(2)
  })

  it('work that moved may ask again', async () => {
    const { store } = rig([])
    blockedWork(store)
    await withBrain(store, asks('q_1', 'Can the release owner issue the stamp?')).onWake({
      causationId: 'c1',
      reason: 'report blocked',
      workItemId: 'wi_1',
    })
    store.atomic(() => {
      store.attempts.save({ id: 'att_9', taskId: 'task_a', workItemId: 'wi_1', state: 'checks_failed' })
    })
    await withBrain(store, asks('q_2', 'It failed again: reissue the stamp?')).onWake({
      causationId: 'c2',
      reason: 'report blocked',
      workItemId: 'wi_1',
    })

    expect(questions(store)).toHaveLength(2)
  })

  it('a replan’s repeat of a question is refused too', async () => {
    const { store } = rig([])
    seedWork(store, 'wi_1')
    await withBrain(store, asks('q_1', 'Which file?')).onWake({
      causationId: 'c1',
      reason: 'report ready',
      workItemId: 'wi_1',
    })
    const planning: MetaBrain = async ({ workItemId }) => ({
      ack: 'Replanning.',
      plan: { tasks: [{ taskId: 'task_1', objective: 'Do', dependsOn: [], role: 'implementer' }] },
      questions: [question('q_2', 'Which file?', workItemId)],
    })
    await withBrain(store, planning).onWake({ causationId: 'c2', reason: 'report ready', workItemId: 'wi_1' })

    expect(questions(store)).toHaveLength(1)
  })
})

describe('what the shipped protocol tells the meta agent', () => {
  const protocol = readFileSync(
    fileURLToPath(new URL('../../prompts/defaults/roles/meta_agent/protocol.md', import.meta.url)),
    'utf8',
  )

  it('a question is answered directly, not acknowledged (§12.2)', () => {
    expect(protocol).toContain('If the message is a question, do not acknowledge it')
    expect(protocol).toContain('the summary IS your answer')
  })

  it('it never names a remedy the product does not have', () => {
    expect(protocol).toContain('Never name a remedy, setting or panel unless the turn context shows it')
  })

  it('it never repeats a decision or an unchanged status (§12.6, §12.7)', () => {
    expect(protocol).toContain('Never ask the owner the same decision twice')
    expect(protocol).toContain('If nothing changed for the person, say nothing new')
  })

  it('the fallback says the same as the shipped text', () => {
    for (const rule of [
      'If the message is a question, do not acknowledge it',
      'the summary IS your answer',
      'Never name a remedy, setting or panel unless the turn context shows it',
      'Never ask the owner the same decision twice',
      'If nothing changed for the person, say nothing new',
    ]) {
      expect(DEFAULT_PLANNER_PROTOCOL).toContain(rule)
    }
  })
})
