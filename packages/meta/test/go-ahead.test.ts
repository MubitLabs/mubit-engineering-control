// Owner ruling 2026-11-07 (D4): the owner's go-ahead on blocked work, leading to a new plan
// revision, lifts the block for that new work. A planner never lifts a block on its own.
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blockWork, MetaAgentService, type MetaBrain, type MetaDecision } from '../src'

const NOW = () => '2026-11-05T12:00:00.000Z'
const LATER = '2026-11-05T12:05:00.000Z'
const REPO = 'repo_a'

type PlanTask = { taskId: string; objective: string; dependsOn: string[]; role: string }
const plan = (...tasks: PlanTask[]): MetaDecision => ({ ack: 'On it', plan: { tasks } })
const t = (taskId: string): PlanTask => ({
  taskId,
  objective: `do ${taskId}`,
  dependsOn: [],
  role: 'implementer',
})

function rig(decisions: MetaDecision[]) {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({
      id: REPO,
      url: 'https://example.test/a',
      bootstrap: [],
      checks: [],
      trust: true,
      hostRunAgreedAt: '2026-11-05T08:00:00.000Z',
    })
  })
  const brain: MetaBrain = async () => decisions.shift() as MetaDecision
  const service = new MetaAgentService({ store, effects: store.effects, brain, now: NOW })
  return { store, service }
}

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
})
afterEach(() => {
  delete process.env.MEC_FAKE_ENGINE
})

/** Work with one task, blocked with the reason a used-up repair leaves. */
async function blocked(next: MetaDecision) {
  const r = rig([plan(t('task_1')), next])
  const first = await r.service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
  const workItemId = first.workItemId as string
  r.store.atomic(() => {
    const [task] = r.store.tasks.list({ workItemId })
    r.store.tasks.save({ ...task!, status: 'blocked', blockedReason: 'repairs used up (2 of 2)' })
    blockWork(r.store, workItemId, 'repairs used up (2 of 2)', NOW())
  })
  return { ...r, workItemId }
}

const newTask = (store: MemoryRepositories, workItemId: string) =>
  store.tasks.list({ workItemId, localKey: 'task_2' })[0]

describe("the owner's go-ahead on blocked work", () => {
  it('an answered question that leads to a new plan revision lifts the block for the new task', async () => {
    const { store, service, workItemId } = await blocked(plan(t('task_1'), t('task_2')))
    store.atomic(() =>
      store.engines.save({
        id: 'question/q_1',
        questionId: 'q_1',
        question: 'Plan one new task?',
        workItemId,
        status: 'answered',
        answer: 'Your call: go ahead.',
        answeredAt: LATER,
      }),
    )
    await service.onWake({ causationId: 'question/q_1', reason: 'question answered', workItemId })

    const work = store.workItems.get(workItemId)
    expect(work?.state).not.toBe('blocked')
    expect(work?.blockedReason).toBeUndefined()
    expect(newTask(store, workItemId)?.status).toBe('ready')
    expect(store.attempts.list({ taskId: newTask(store, workItemId)?.id })).toHaveLength(1)
    expect(store.events.read(`work:${workItemId}`).map((event) => event.type)).toContain('block_lifted')
  })

  it("the owner's follow-up message does the same", async () => {
    const { store, service, workItemId } = await blocked(plan(t('task_1'), t('task_2')))
    store.atomic(() =>
      store.messages.save({ id: 'msg_2', text: 'go ahead', workItemId, repoId: REPO, createdAt: LATER }),
    )
    await service.onWake({
      causationId: 'message:msg_2',
      reason: 'follow-up with no running work',
      workItemId,
    })
    expect(store.workItems.get(workItemId)?.state).not.toBe('blocked')
  })

  it('a planner turn no owner caused plans, and the work stays blocked', async () => {
    const { store, service, workItemId } = await blocked(plan(t('task_1'), t('task_2')))
    await service.onWake({ causationId: 'used-up:task_x', reason: 'work parked', workItemId })

    const work = store.workItems.get(workItemId)
    expect(work?.state).toBe('blocked')
    expect(work?.blockedReason).toBe('repairs used up (2 of 2)')
    expect(store.attempts.list({ taskId: newTask(store, workItemId)?.id })).toEqual([])
  })

  it('a question answered before the block lifts nothing', async () => {
    const { store, service, workItemId } = await blocked(plan(t('task_1'), t('task_2')))
    store.atomic(() =>
      store.engines.save({
        id: 'question/q_old',
        questionId: 'q_old',
        workItemId,
        status: 'answered',
        answer: 'yes',
        answeredAt: '2026-11-05T11:00:00.000Z',
      }),
    )
    await service.onWake({ causationId: 'question/q_old', reason: 'question answered', workItemId })
    expect(store.workItems.get(workItemId)?.state).toBe('blocked')
  })
})
