// M2.2: the §11 pass, over the memory store. Its effects queue refuses an enqueue outside
// `atomic`, so a green run also proves a launch row commits with its attempt.
import type { Json, StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS, type SlotModelsView } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { FollowUps, type PlacementTable, repoFields, type SchedulerDeps, schedulePass } from '../src'
import { holdWorkItem, stopWorkItem } from '../src/authority'

const AT = '2026-11-05T12:00:00.000Z'
const POLICY = '{"preAuthorised":{}}'
const REPO = 'repo_a'

afterEach(() => {
  delete process.env.MEC_FAKE_ENGINE
})

const TABLE = {
  engines: {
    claude: {
      select: { flag: '--model' },
      effort_levels: ['low', 'high'],
      models: { sonnet: { tier: 'balanced', vendor_says: 'x' } },
    },
    codex: {
      select: { flag: '-m' },
      models: { 'gpt-big': { tier: 'strong', vendor_says: 'x' } },
    },
  },
} as unknown as PlacementTable

type Rig = {
  store: MemoryRepositories
  deps: SchedulerDeps
  pass: (workItemId?: string) => ReturnType<typeof schedulePass>
}

const slot = (slotId: string, extra: Partial<SlotModelsView> = {}): SlotModelsView => ({
  slotId,
  engine: 'claude',
  healthy: true,
  marks: {},
  concurrency: 2,
  ...extra,
})

function rig(slots: SlotModelsView[] = [slot('slot_a')], extra: Partial<SchedulerDeps> = {}): Rig {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({ id: REPO, url: 'https://example.test/a', bootstrap: [], checks: [], trust: true })
  })
  const followups = new FollowUps({ store, effects: store.effects, now: () => AT })
  const deps: SchedulerDeps = {
    store,
    effects: store.effects,
    caps: DEFAULT_CAPS,
    slots: () => slots,
    table: () => TABLE,
    followups,
    ...extra,
  }
  return {
    store,
    deps,
    pass: (workItemId) =>
      store.atomic(() => schedulePass(deps, { at: AT, ...(workItemId !== undefined && { workItemId }) })),
  }
}

function work(store: MemoryRepositories, id = 'wi_1', extra: StoreDoc = {}): void {
  store.atomic(() => {
    store.workItems.save({
      id,
      state: 'executing',
      mandate: { originMessageId: 'msg_1', status: 'active' },
      ...repoFields(store, REPO, POLICY),
      ...extra,
    })
  })
}

function task(store: MemoryRepositories, id: string, extra: StoreDoc = {}, workItemId = 'wi_1'): void {
  store.atomic(() => {
    store.tasks.save({
      id,
      localKey: id.replace('task_', ''),
      workItemId,
      repoId: REPO,
      role: 'implementer',
      status: 'ready',
      dependsOn: [],
      basePolicy: 'contract',
      createdAt: AT,
      ...extra,
    })
  })
}

const attemptsOf = (store: MemoryRepositories, taskId: string) => store.attempts.list({ taskId })
const launchRows = (store: MemoryRepositories) =>
  store.snapshot().effects.filter((row) => row.kind === 'launch')

describe('the scheduler pass (§11)', () => {
  it('dependent launches after prerequisite accepted', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'accepted' })
    task(store, 'task_b', { dependsOn: ['task_a'] })

    expect(pass().map((row) => row.taskId)).toEqual(['task_b'])
    expect(attemptsOf(store, 'task_b')).toHaveLength(1)
  })

  it('integration dependent waits for integrated', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'accepted' })
    task(store, 'task_b', { dependsOn: ['task_a'], basePolicy: 'integration' })

    expect(pass()).toEqual([])
    expect(store.tasks.get('task_b')?.deferred).toMatchObject({
      reason: 'dependency',
      releases: 'a is integrated',
    })

    store.atomic(() => {
      store.tasks.save({ ...store.tasks.get('task_a'), id: 'task_a', status: 'integrated' })
    })
    expect(pass().map((row) => row.taskId)).toEqual(['task_b'])
  })

  it('reads persisted task state: a prerequisite still ready satisfies nothing', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'active' })
    task(store, 'task_b', { dependsOn: ['task_a'] })
    expect(pass()).toEqual([])
  })

  it('two passes never double-place a queued task', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a')

    expect(pass()).toHaveLength(1)
    expect(pass()).toEqual([])
    expect(attemptsOf(store, 'task_a')).toHaveLength(1)
    expect(launchRows(store)).toHaveLength(1)
  })

  it('a queued attempt holds its slot unit against another task', () => {
    const { store, pass } = rig([slot('slot_a', { concurrency: 1 })])
    work(store)
    task(store, 'task_a')
    expect(pass().map((row) => row.taskId)).toEqual(['task_a'])
    work(store, 'wi_2')
    task(store, 'task_b', {}, 'wi_2')

    expect(pass()).toEqual([])
    expect(store.tasks.get('task_b')?.deferred).toMatchObject({ reason: 'capacity' })
  })

  it('a queued attempt whose launch row gave up holds no capacity', () => {
    const states: Record<string, string> = {}
    const { store, pass } = rig([slot('slot_a', { concurrency: 1 })], {
      launchRowState: (key) => states[key],
    })
    work(store)
    task(store, 'task_a')
    const [first] = pass()
    states[String(first?.key)] = 'failed'
    work(store, 'wi_2')
    task(store, 'task_b', {}, 'wi_2')

    expect(pass().map((row) => row.taskId)).toEqual(['task_b'])
    expect(store.tasks.get('task_a')).toMatchObject({ status: 'blocked' })
  })

  it('an attempt that gets no verdict stops holding its slot', () => {
    const { store, pass } = rig([slot('slot_a', { concurrency: 1 })])
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_a',
        workItemId: 'wi_1',
        slotId: 'slot_a',
        state: 'work_complete',
        checks_note: 'no checks are registered for this repository',
      })
    })
    task(store, 'task_b')
    expect(pass().map((row) => row.taskId)).toEqual(['task_b'])
  })

  it('failed prerequisite blocks dependents with a reason', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a')
    task(store, 'task_b', { dependsOn: ['task_a'] })
    task(store, 'task_c', { dependsOn: ['task_b'] })
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_a',
        workItemId: 'wi_1',
        slotId: 'slot_a',
        state: 'failed',
        terminal_reason: 'engine_crashed',
      })
    })

    expect(pass()).toEqual([])
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'blocked',
      blockedReason: 'attempt att_1 failed: engine_crashed',
    })
    expect(String(store.tasks.get('task_b')?.blockedReason)).toContain('prerequisite a cannot finish')
    expect(String(store.tasks.get('task_c')?.blockedReason)).toContain('prerequisite b cannot finish')
    expect(store.workItems.get('wi_1')).toMatchObject({
      state: 'blocked',
      blockedReason: 'attempt att_1 failed: engine_crashed',
    })
  })

  it('checks failing on the head leave no attempts, so the task blocks', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_a',
        workItemId: 'wi_1',
        slotId: 'slot_a',
        state: 'checks_failed',
        head_sha: 'abc',
      })
    })
    pass()
    expect(store.tasks.get('task_a')).toMatchObject({ status: 'blocked' })
    expect(String(store.tasks.get('task_a')?.blockedReason)).toContain('failed its checks on abc')
  })

  it('held work gets zero launches and lift dispatches', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a')
    store.atomic(() => holdWorkItem(store, 'wi_1', { reason: 'wait', at: AT }))

    expect(pass()).toEqual([])
    expect(pass()).toEqual([])
    expect(launchRows(store)).toHaveLength(0)
    expect(store.tasks.get('task_a')?.deferred).toMatchObject({ reason: 'held' })
    const withheld = store.events.read('work:wi_1').filter((event) => event.type === 'launch_withheld')
    expect(withheld).toHaveLength(1)

    store.atomic(() => {
      const doc = store.workItems.get('wi_1') as StoreDoc
      store.workItems.save({ ...doc, hold: { ...(doc.hold as object), liftedAt: AT } })
    })
    expect(pass().map((row) => row.taskId)).toEqual(['task_a'])
    expect(store.tasks.get('task_a')?.deferred).toBeUndefined()
  })

  it('stopped and withdrawn work get zero launches', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a')
    store.atomic(() => stopWorkItem(store, 'wi_1', { reason: 'stop', at: AT }))
    work(store, 'wi_2', { mandate: { originMessageId: 'msg_2', status: 'withdrawn' } })
    task(store, 'task_b', {}, 'wi_2')

    expect(pass()).toEqual([])
    expect(launchRows(store)).toHaveLength(0)
  })

  it('a pause runs no pass', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a')
    store.atomic(() => {
      store.engines.save({ id: 'settings/processing', paused: true, pausedAt: AT })
    })
    expect(pass()).toEqual([])
    expect(launchRows(store)).toHaveLength(0)
  })

  it('defer reason persists with its release condition', () => {
    const { store, pass } = rig([slot('slot_a', { healthy: false })])
    work(store)
    task(store, 'task_a')

    pass()
    const first = store.tasks.get('task_a')?.deferred as { reason: string; releases: string; at: string }
    expect(first).toMatchObject({ reason: 'slot_unhealthy', releases: 'a healthy slot matches this task' })

    // A later pass with the same answer writes nothing new.
    const { updatedAt } = store.tasks.get('task_a') as StoreDoc
    pass()
    expect(store.tasks.get('task_a')?.updatedAt).toBe(updatedAt)
  })

  it('pinned slot wins over the sort order', () => {
    const { store, pass } = rig([slot('slot_a'), slot('slot_b', { utilisation: 0.7 })])
    work(store)
    task(store, 'task_a', { slotHint: { slotId: 'slot_b' } })

    expect(pass()).toMatchObject([{ slotId: 'slot_b' }])
    expect(attemptsOf(store, 'task_a')[0]?.placement).toBe('pinned to slot_b by the plan')
  })

  it('a pin to a busy slot waits for that slot, never another', () => {
    const { store, pass } = rig([slot('slot_a'), slot('slot_b', { concurrency: 0 })])
    work(store)
    task(store, 'task_a', { slotHint: { slotId: 'slot_b' } })

    expect(pass()).toEqual([])
    expect(store.tasks.get('task_a')?.deferred).toMatchObject({ reason: 'capacity' })
  })

  it('real inUse: a slot at its concurrency takes no more', () => {
    const { store, pass } = rig([slot('slot_a', { concurrency: 1 }), slot('slot_b', { concurrency: 1 })])
    work(store)
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        taskId: 'x',
        workItemId: 'wi_1',
        slotId: 'slot_a',
        state: 'running',
      })
    })
    task(store, 'task_a')
    expect(pass()).toMatchObject([{ slotId: 'slot_b' }])
  })

  it('model unsupported on a slot never places there', () => {
    const { store, pass } = rig([
      slot('slot_codex', { engine: 'codex' }),
      slot('slot_claude', { engine: 'claude', utilisation: 0.5 }),
    ])
    work(store)
    task(store, 'task_a', { modelRequest: { model: 'sonnet', reason: 'r' } })

    expect(pass()).toMatchObject([{ slotId: 'slot_claude' }])
    expect(attemptsOf(store, 'task_a')[0]).toMatchObject({ resolved_model: 'sonnet' })
  })

  it('a model no slot serves defers with that reason and never falls back', () => {
    const { store, pass } = rig([slot('slot_claude')])
    work(store)
    task(store, 'task_a', { modelRequest: { model: 'gpt-big', reason: 'r' } })

    expect(pass()).toEqual([])
    expect(store.tasks.get('task_a')?.deferred).toMatchObject({ reason: 'model_unavailable' })
  })

  it('a slot that marks the model unavailable is passed over', () => {
    const { store, pass } = rig([
      slot('slot_a', { marks: { sonnet: 'unavailable' } }),
      slot('slot_b', { utilisation: 0.5 }),
    ])
    work(store)
    task(store, 'task_a', { modelRequest: { model: 'sonnet', reason: 'r' } })
    expect(pass()).toMatchObject([{ slotId: 'slot_b' }])
  })

  it('records a degraded tier on the attempt before launch', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { modelRequest: { tier: 'strong', reason: 'r' } })

    pass()
    expect(attemptsOf(store, 'task_a')[0]).toMatchObject({
      resolved_model: 'sonnet',
      tier_degraded: 'strong→balanced (provider has no strong)',
    })
  })

  it('an interim acceptance moves a succeeded attempt’s task through the machine', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'active' })
    task(store, 'task_b', { dependsOn: ['task_a'] })
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_a',
        workItemId: 'wi_1',
        slotId: 'slot_a',
        state: 'succeeded',
        head_sha: 'abc',
      })
    })

    expect(pass().map((row) => row.taskId)).toEqual(['task_b'])
    expect(store.tasks.get('task_a')).toMatchObject({ status: 'accepted', acceptedHead: 'abc' })
  })

  it('an unsatisfied work_complete attempt accepts nothing', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_a',
        workItemId: 'wi_1',
        slotId: 'slot_a',
        state: 'work_complete',
      })
    })
    pass()
    expect(store.tasks.get('task_a')?.status).toBe('awaiting_review')
  })

  it('a task with any attempt is not launched again', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a')
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_a',
        workItemId: 'wi_1',
        slotId: 's',
        state: 'succeeded',
      })
    })
    expect(pass()).toEqual([])
  })

  it('unassigned work says why on its own commit and is never written by a timer pass', () => {
    const { store, pass } = rig()
    store.atomic(() => {
      store.workItems.save({ id: 'wi_1', state: 'executing' })
      store.tasks.save({
        id: 'task_a',
        workItemId: 'wi_1',
        status: 'ready',
        dependsOn: [],
        role: 'implementer',
      })
    })
    expect(pass()).toEqual([])
    expect(store.events.read('work:wi_1')).toHaveLength(0)
    pass('wi_1')
    expect(store.events.read('work:wi_1').map((event) => event.type)).toEqual(['launch_withheld'])
    expect(store.tasks.get('task_a')?.deferred).toBeUndefined()
  })

  it('a pass leaves a launch payload the launch handler reads', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a')
    pass()
    expect(launchRows(store)[0]?.payload as Json).toEqual({
      attempt_id: 'att_1',
      task_id: 'task_a',
      work_item_id: 'wi_1',
      slot_id: 'slot_a',
      generation: 1,
    })
  })
})
