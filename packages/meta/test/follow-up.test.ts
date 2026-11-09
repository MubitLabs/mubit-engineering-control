// The 9 November walkthrough (wi_mw9kvv16): following up on work whose push was declined. A blocked
// task the owner's replan changed runs again, fresh; the planner reads a declined push for what it
// is; and a task the planner cancelled leaves the result complete.
import type { Store, StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compilePlannerContext,
  integrationDocId,
  MetaAgentService,
  type MetaBrain,
  type MetaDecision,
  plannerContextFromStore,
  workResultOf,
} from '../src'

const NOW = () => '2026-11-09T18:24:24.613Z'
const REPO = 'repo_a'
const HEAD = '196b59c40e213f56c605c8f86624cf3fba74341e'
const ACCEPTED = '21ca549c4c6f0d6d86beb08d4f98b2ee5dcf089d'
const BLOCKED = 'attempt att_1 reported blocked: the site files are not in this base'

type PlanTask = {
  taskId: string
  objective: string
  dependsOn: string[]
  role: string
  basePolicy?: 'contract'
}
const t = (taskId: string, dependsOn: string[] = [], objective = `do ${taskId}`): PlanTask => ({
  taskId,
  objective,
  dependsOn,
  role: 'implementer',
})
const plan = (...tasks: PlanTask[]): MetaDecision => ({
  ack: 'On it',
  plan: { tasks },
  reports: [],
})

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
})
afterEach(() => {
  delete process.env.MEC_FAKE_ENGINE
})

/**
 * Revision 1 planned `built` and `fix`. `built` integrated; `fix` ran once from the pin, reported
 * blocked, and blocked the work. The next decision is the owner's replan, or the planner's own.
 */
async function blockedFix(next: MetaDecision) {
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
  const decisions = [plan(t('built'), t('fix')), next]
  const brain: MetaBrain = async () => decisions.shift() as MetaDecision
  const service = new MetaAgentService({ store, effects: store.effects, brain, now: NOW })
  const first = await service.onUserMessage({ messageId: 'msg_1', text: 'build it', repoId: REPO })
  const workItemId = first.workItemId as string
  const key = (localKey: string) => store.tasks.list({ workItemId, localKey })[0] as StoreDoc
  store.atomic(() => {
    // Revision 1 queued both. `built` finished; `fix` ran from the pin and reported blocked.
    for (const attempt of store.attempts.list()) {
      const mine = attempt.taskId === key('fix').id
      store.attempts.save({
        ...attempt,
        state: 'succeeded',
        ...(mine && { worktree: '/work/att_fix', branch: 'mec/x/fix/a1' }),
      })
    }
    store.tasks.save({ ...key('built'), status: 'integrated' })
    store.tasks.save({ ...key('fix'), status: 'blocked', blockedReason: BLOCKED })
    store.engines.save({
      id: integrationDocId(workItemId),
      head: HEAD,
      integrated: { [String(key('built').id)]: HEAD },
    })
    const work = store.workItems.get(workItemId) as StoreDoc
    store.workItems.save({ ...work, state: 'blocked', blockedReason: BLOCKED })
    store.events.append(`work:${workItemId}`, {
      stream: `work:${workItemId}`,
      seq: store.events.read(`work:${workItemId}`).length + 1,
      at: NOW(),
      type: 'work_blocked',
      body: { workItemId, reason: BLOCKED, at: NOW() },
    })
    store.messages.save({
      id: 'msg_2',
      text: 'make it depend on built',
      repoId: REPO,
      workItemId,
      createdAt: NOW(),
    })
  })
  return { store, service, workItemId, key }
}

const ownerReplan = (service: MetaAgentService, workItemId: string) =>
  service.onWake({ causationId: 'message:msg_2', reason: 'user message', workItemId })

describe('a replan of a blocked task (owner, 9 November 2026)', () => {
  it('a changed dependency runs the task again in a fresh worktree, and the work leaves blocked', async () => {
    const { store, service, workItemId, key } = await blockedFix(plan(t('built'), t('fix', ['built'])))
    await ownerReplan(service, workItemId)

    expect(store.workItems.get(workItemId)?.state).not.toBe('blocked')
    const fix = key('fix')
    expect(fix.blockedReason).toBeUndefined()
    const attempts = store.attempts.list({ taskId: fix.id })
    expect(attempts).toHaveLength(2)
    const fresh = attempts.find((attempt) => attempt.state === 'queued') as StoreDoc
    // Not a repair in att_1's worktree (§15): a new start, on the base the new plan gives it.
    expect(fresh.continuation).toMatchObject({ kind: 'restart', role: 'implementer' })
    expect((fresh.continuation as { worktree?: string }).worktree).toBeUndefined()
    expect(fresh.role).toBe('implementer')
    expect(store.events.read(`work:${workItemId}`).filter((e) => e.type === 'task_restarted')).toHaveLength(1)
  })

  it('a changed objective or base policy is a change too', async () => {
    for (const changed of [
      t('fix', [], 'do fix, from the built site'),
      { ...t('fix'), basePolicy: 'contract' as const },
    ]) {
      const { store, service, workItemId, key } = await blockedFix(plan(t('built'), changed))
      await ownerReplan(service, workItemId)
      expect(key('fix').status).not.toBe('blocked')
      expect(store.workItems.get(workItemId)?.state).not.toBe('blocked')
    }
  })

  it('a replan that changes nothing the task runs on leaves it blocked', async () => {
    const { store, service, workItemId, key } = await blockedFix(plan(t('built'), t('fix')))
    await ownerReplan(service, workItemId)

    expect(key('fix').status).toBe('blocked')
    expect(store.workItems.get(workItemId)?.state).toBe('blocked')
    expect(store.attempts.list({ taskId: key('fix').id })).toHaveLength(1)
  })

  it('a planner turn the owner did not cause changes nothing, whatever it replans (ruling 2026-11-07)', async () => {
    const { store, service, workItemId, key } = await blockedFix(plan(t('built'), t('fix', ['built'])))
    await service.onWake({ causationId: 'report/att_1/1', reason: 'report blocked', workItemId })
    expect(key('fix').status).toBe('blocked')
    expect(store.workItems.get(workItemId)?.state).toBe('blocked')
  })
})

describe('a report from a replan that left a task blocked', () => {
  it('says the task is still blocked, beside what the planner wrote', async () => {
    const next: MetaDecision = plan(t('built'), t('fix'))
    const { store, service, workItemId, key } = await blockedFix(next)
    next.reports = [
      { workItemId, summary: 'Replanned: fix starts from the integration head.', artifacts: [] },
    ]
    await ownerReplan(service, workItemId)
    const reported = store.events
      .read(`work:${workItemId}`)
      .filter((e) => e.type === 'result_reported')
      .at(-1)
    const summary = String((reported?.body as { summary?: string } | undefined)?.summary)
    expect(summary.startsWith('Replanned: fix starts from the integration head.')).toBe(true)
    expect(summary).toContain(
      'fix is still blocked: this plan changed nothing it runs on, so it did not start.',
    )
    expect(key('fix').status).toBe('blocked')
  })
})

describe('the planner reads a declined push for what it is', () => {
  const contextOf = (store: Store) =>
    compilePlannerContext(
      plannerContextFromStore(store, {
        turn: { wake: 'user message' } as never,
        policyText: '{"preAuthorised":{}}',
        caps: DEFAULT_CAPS,
        now: NOW,
      }),
    )

  const declined = () => {
    const store = new MemoryRepositories() as unknown as Store
    store.workItems.save({ id: 'wi_1', state: 'integrating', repoId: REPO, updatedAt: NOW() })
    store.tasks.save({ id: 'task_a', workItemId: 'wi_1', localKey: 'task_1', status: 'integrated' })
    store.attempts.save({
      id: 'att_10',
      taskId: 'task_a',
      workItemId: 'wi_1',
      head_sha: ACCEPTED,
      createdAt: NOW(),
    })
    store.engines.save({
      id: integrationDocId('wi_1'),
      branch: 'mec/wi1/integration',
      head: HEAD,
      integrated: { task_a: HEAD },
    })
    store.engines.save({
      id: 'delivery/wi_1',
      stage: 'declined',
      pushCardId: 'conf_1',
      answer: 'denied',
      head: HEAD,
    })
    return store
  }

  it('integrated tasks are on the local integration branch, and the declined push is a separate fact', () => {
    const text = contextOf(declined())
    expect(text).toContain(`integrated locally: task_1 on mec/wi1/integration at ${HEAD}`)
    expect(text).toContain('push to GitHub: declined')
    expect(text).toMatch(/nothing has left this machine; the integrated commits are still here/)
    // The task's own head is its attempt's commit, which the integration merged.
    expect(text).toContain(`head:${ACCEPTED}`)
  })

  it('says nothing of a push or an integration where there is neither', () => {
    const plain = new MemoryRepositories() as unknown as Store
    plain.workItems.save({ id: 'wi_1', state: 'executing', updatedAt: NOW() })
    expect(contextOf(plain)).not.toContain('push to GitHub')
    expect(contextOf(plain)).not.toContain('integrated locally')
  })
})

describe('a task the planner cancelled', () => {
  it('is cancelled with a reason, so the result can complete without it', async () => {
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
    const decisions: MetaDecision[] = [plan(t('built'), t('spare'))]
    const brain: MetaBrain = async () => decisions.shift() ?? { ack: 'ok' }
    const service = new MetaAgentService({ store, effects: store.effects, brain, now: NOW })
    const first = await service.onUserMessage({ messageId: 'msg_1', text: 'build it', repoId: REPO })
    const workItemId = first.workItemId as string
    const spare = store.tasks.list({ workItemId, localKey: 'spare' })[0] as StoreDoc
    decisions.push({ ack: 'Dropped', cancels: [{ taskId: String(spare.id) }] })
    await service.onWake({ causationId: 'report/x', reason: 'report ready', workItemId })
    expect(store.tasks.get(String(spare.id))).toMatchObject({
      status: 'cancelled',
      cancelledReason: 'cancelled by the planner',
    })
  })

  it('a cancel stored before 0.3.7, with no reason but its event, is an exclusion too', () => {
    const store = new MemoryRepositories() as unknown as Store
    store.workItems.save({ id: 'wi_1', state: 'integrating' })
    store.tasks.save({ id: 'task_a', workItemId: 'wi_1', status: 'integrated' })
    store.tasks.save({ id: 'task_b', workItemId: 'wi_1', status: 'cancelled' })
    store.engines.save({
      id: integrationDocId('wi_1'),
      head: HEAD,
      integrated: { task_a: HEAD },
      combined: { sha: HEAD, passed: true, checks: [] },
    })
    expect(workResultOf(store, 'wi_1').remaining).toEqual(['task_b was cancelled with no reason'])
    store.events.append('task:task_b', {
      stream: 'task:task_b',
      seq: 1,
      at: NOW(),
      type: 'task_cancelled',
      body: { taskId: 'task_b', at: NOW() },
    })
    expect(workResultOf(store, 'wi_1')).toMatchObject({
      complete: true,
      excluded: [{ id: 'task_b', reason: 'cancelled by the planner' }],
    })
  })
})
