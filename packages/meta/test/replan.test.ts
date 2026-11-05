// M2.2 plan revisions (decision #19, §10): a reused key is the same task, and every revision stays.
import type { StoreDoc } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MetaAgentService, type MetaBrain, type MetaDecision } from '../src'
import { planSnapshotId } from '../src/admission'

const NOW = () => '2026-11-05T12:00:00.000Z'
const REPO = 'repo_a'

type PlanTask = { taskId: string; objective: string; dependsOn: string[]; role: string }
const plan = (...tasks: PlanTask[]): MetaDecision => ({ ack: 'On it', plan: { tasks } })
const t = (taskId: string, objective = `do ${taskId}`, dependsOn: string[] = []): PlanTask => ({
  taskId,
  objective,
  dependsOn,
  role: 'implementer',
})

function rig(decisions: MetaDecision[]) {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({ id: REPO, url: 'https://example.test/a', bootstrap: [], checks: [], trust: true })
  })
  const brain: MetaBrain = async () => decisions.shift() as MetaDecision
  const service = new MetaAgentService({ store, effects: store.effects, brain, now: NOW })
  return { store, service }
}

const byKey = (store: MemoryRepositories, workItemId: string, localKey: string): StoreDoc =>
  store.tasks.list({ workItemId, localKey })[0] as StoreDoc

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
})
afterEach(() => {
  delete process.env.MEC_FAKE_ENGINE
})

async function twoRevisions(second: MetaDecision) {
  const { store, service } = rig([plan(t('a'), t('b', 'do b', ['a'])), second])
  const first = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
  const workItemId = first.workItemId as string
  const a = byKey(store, workItemId, 'a')
  store.atomic(() => {
    store.tasks.save({ ...a, status: 'active' })
  })
  await service.onWake({ causationId: 'report/x', reason: 'report ready', workItemId })
  return { store, service, workItemId, a }
}

describe('plan revisions (#19, §10)', () => {
  it('same key keeps id, attempts and status', async () => {
    const { store, workItemId, a } = await twoRevisions(plan(t('a', 'do a, differently')))
    const kept = byKey(store, workItemId, 'a')
    expect(kept.id).toBe(a.id)
    expect(kept.status).toBe('active')
    expect(kept.objective).toBe('do a, differently')
    expect(kept.planRevision).toBe(2)
    expect(store.attempts.list({ taskId: a.id })).toHaveLength(1)
  })

  it('new key is a new task', async () => {
    const { store, workItemId } = await twoRevisions(plan(t('a'), t('c')))
    expect(byKey(store, workItemId, 'c').status).not.toBe('cancelled')
    expect(store.tasks.list({ workItemId })).toHaveLength(3)
  })

  it('old revision stays readable', async () => {
    const { store, workItemId } = await twoRevisions(plan(t('a', 'changed')))
    const first = store.engines.get(planSnapshotId(workItemId, 1))
    const second = store.engines.get(planSnapshotId(workItemId, 2))
    expect(first).toMatchObject({ tasks: [{ objective: 'do a' }, { objective: 'do b' }] })
    expect(second?.tasks).toMatchObject([{ objective: 'changed' }])
  })

  it('the revision stores an impact summary against the one before', async () => {
    const { store, workItemId, a } = await twoRevisions(plan(t('a', 'changed'), t('c')))
    const b = byKey(store, workItemId, 'b')
    const c = byKey(store, workItemId, 'c')
    expect(store.engines.get(planSnapshotId(workItemId, 2))?.impact).toMatchObject({
      added: [c.id],
      changed: [a.id],
      removed: [b.id],
      unchanged: [],
    })
  })

  it('a dropped key nothing started is cancelled, with the revision as its reason', async () => {
    const { store, workItemId } = await twoRevisions(plan(t('a')))
    expect(byKey(store, workItemId, 'b')).toMatchObject({
      status: 'cancelled',
      cancelledReason: 'dropped by plan revision 2',
    })
  })

  it('a dropped key already started stays, flagged in the impact summary', async () => {
    const { store, workItemId, a } = await twoRevisions(plan(t('b')))
    expect(byKey(store, workItemId, 'a').status).toBe('active')
    expect(store.engines.get(planSnapshotId(workItemId, 2))?.impact).toMatchObject({ keptRunning: [a.id] })
  })

  it('persists base_policy on the task, and a replan that omits it keeps it', async () => {
    const contract = (key: string) => ({ ...t(key), basePolicy: 'contract' as const })
    const { store, service } = rig([{ ack: 'On it', plan: { tasks: [contract('a')] } }, plan(t('a'), t('b'))])
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    expect(byKey(store, workItemId as string, 'a').basePolicy).toBe('contract')
    await service.onWake({ causationId: 'c', reason: 'report ready', workItemId: workItemId as string })
    expect(byKey(store, workItemId as string, 'a').basePolicy).toBe('contract')
    expect(byKey(store, workItemId as string, 'b').basePolicy).toBe('integration')
  })
})
