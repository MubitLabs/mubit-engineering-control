// M2.2: the §11 pass, over the memory store. Its effects queue refuses an enqueue outside
// `atomic`, so a green run also proves a launch row commits with its attempt.
import type { Json, Report, StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS, type SlotModelsView } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FollowUps,
  openRepairTask,
  type PlacementTable,
  repoFields,
  type SchedulerDeps,
  schedulePass,
} from '../src'
import { holdWorkItem, refuseLaunch, stopWorkItem } from '../src/authority'

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

function attempt(store: MemoryRepositories, fields: StoreDoc): void {
  store.atomic(() => {
    store.attempts.save({ id: 'att_1', taskId: 'task_a', workItemId: 'wi_1', slotId: 'slot_a', ...fields })
  })
}

/** The repository registers `unit`, and the attempt's stored verdict on `sha` says `status`. */
function verdict(store: MemoryRepositories, status: 'passed' | 'failed', sha = 'abc'): void {
  store.atomic(() => {
    const repo = store.engines.get(REPO) as StoreDoc
    store.engines.save({ ...repo, checks: [{ name: 'unit', cmd: 'true' }] })
    const doc = store.attempts.get('att_1') as StoreDoc
    store.attempts.save({ ...doc, checks: ['unit'] })
    store.engines.save({
      id: 'check/att_1/unit',
      attemptId: 'att_1',
      name: 'unit',
      status,
      log_tail: 'two tests red',
      sha,
    })
  })
}

function saveReport(store: MemoryRepositories, n: number, report: Report): void {
  store.atomic(() => {
    store.engines.save({ id: `report/att_1/${n}`, attemptId: 'att_1', n, report: report as unknown as Json })
  })
}

const wakes = (store: MemoryRepositories) => store.snapshot().effects.filter((row) => row.kind === 'relay')

/** A task whose implementer already spent a repair, and the repair that just ran red. */
function repairRanRed(store: MemoryRepositories): void {
  work(store)
  task(store, 'task_a', { status: 'active' })
  store.atomic(() => {
    store.attempts.save({
      id: 'att_0',
      taskId: 'task_a',
      workItemId: 'wi_1',
      slotId: 'slot_a',
      state: 'checks_failed',
      createdAt: '2026-11-05T11:00:00.000Z',
    })
  })
  attempt(store, {
    state: 'checks_failed',
    head_sha: 'abc',
    reports: 1,
    createdAt: AT,
    continuation: { kind: 'repair', role: 'repair_agent', evidence: 'red', round: 0 },
  })
  verdict(store, 'failed')
}

describe('a report on a red head (§10)', () => {
  it.each([['blocked'], ['failed']] as const)(
    'a repair reporting %s on a red head ends the repairs',
    (kind) => {
      const { store, pass } = rig()
      repairRanRed(store)
      saveReport(store, 1, { kind, summary: 'a person must issue the stamp' })

      expect(pass()).toEqual([])
      expect(store.tasks.get('task_a')).toMatchObject({ status: 'blocked' })
      expect(String(store.tasks.get('task_a')?.blockedReason)).toContain('a person must issue the stamp')
      expect(store.tasks.get('task_a')?.next).toBeUndefined()
      expect(attemptsOf(store, 'task_a')).toHaveLength(2)
      expect(store.workItems.get('wi_1')).toMatchObject({ state: 'blocked' })
      pass()
      expect(attemptsOf(store, 'task_a')).toHaveLength(2)
    },
  )

  it('a dropped report on a red head is no block: checks still decide', () => {
    const { store, pass } = rig()
    repairRanRed(store)
    saveReport(store, 1, { kind: 'dropped', summary: 'nothing to do' })

    pass()
    expect(store.tasks.get('task_a')?.status).not.toBe('cancelled')
    expect(attemptsOf(store, 'task_a')).toHaveLength(3)
  })

  it('a progress report on a red head still earns its repair', () => {
    const { store, pass } = rig()
    repairRanRed(store)
    saveReport(store, 1, { kind: 'progress', summary: 'tried' })

    pass()
    expect(attemptsOf(store, 'task_a')).toHaveLength(3)
  })
})

describe('used-up repairs wake the planner once (§6)', () => {
  const noRepairs = { caps: { ...DEFAULT_CAPS, repairAttemptsPerTask: 0 } }

  it('a task that used up its repairs wakes one turn, with what remains', () => {
    const { store, pass } = rig([slot('slot_a')], noRepairs)
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    attempt(store, { state: 'checks_failed', head_sha: 'abc' })
    verdict(store, 'failed')

    pass()
    pass()

    expect(wakes(store)).toHaveLength(1)
    expect(wakes(store)[0]?.payload).toMatchObject({ reason: 'work parked', workItemId: 'wi_1' })
    expect(JSON.stringify(wakes(store)[0]?.payload)).toContain('Check unit failed on abc')
  })

  it('its dependents add no wake of their own', () => {
    const { store, pass } = rig([slot('slot_a')], noRepairs)
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    task(store, 'task_b', { dependsOn: ['task_a'] })
    attempt(store, { state: 'checks_failed', head_sha: 'abc' })
    verdict(store, 'failed')

    pass()

    expect(store.tasks.get('task_b')?.status).toBe('blocked')
    expect(wakes(store)).toHaveLength(1)
  })

  it('a failed check with a repair left wakes nobody', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    attempt(store, { state: 'checks_failed', head_sha: 'abc' })
    verdict(store, 'failed')

    pass()

    expect(wakes(store)).toEqual([])
  })

  it('a block a specialist reported is its report’s wake, not a second one', () => {
    const { store, pass } = rig([slot('slot_a')], noRepairs)
    repairRanRed(store)
    saveReport(store, 1, { kind: 'blocked', summary: 'a person must act' })

    pass()

    expect(store.tasks.get('task_a')?.status).toBe('blocked')
    expect(wakes(store)).toEqual([])
  })

  it('an integration repair past the cap wakes one turn too', () => {
    const { store, deps } = rig([slot('slot_a')], noRepairs)
    work(store)
    task(store, 'task_a', { status: 'integrated' })
    const root = store.tasks.get('task_a') as StoreDoc
    const open = () =>
      store.atomic(() => {
        openRepairTask(store, store.effects, deps.caps, {
          root,
          evidence: 'combined checks red',
          worktree: '/w',
          branch: 'b',
          id: 'task_r',
          at: AT,
        })
      })

    open()
    open()

    expect(store.workItems.get('wi_1')?.state).toBe('blocked')
    expect(wakes(store)).toHaveLength(1)
  })
})

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

  it('a launch dropped on a changed policy gives its slot unit back', () => {
    const { store, pass } = rig([slot('slot_a', { concurrency: 1 })])
    work(store)
    task(store, 'task_a')
    pass()
    const [queued] = attemptsOf(store, 'task_a')
    const payload = { attempt_id: String(queued?.id), task_id: 'task_a', work_item_id: 'wi_1' }
    store.atomic(() => refuseLaunch(store, payload, 'policy_changed', AT))
    work(store, 'wi_2')
    task(store, 'task_b', {}, 'wi_2')

    expect(pass().map((row) => row.taskId)).toEqual(['task_b'])
    expect(store.workItems.get('wi_1')).toMatchObject({ state: 'blocked', blockedReason: 'policy_changed' })
  })

  it('a failed attempt keeps its slot unit while its group is still there (§8.1)', () => {
    const { store, pass } = rig([slot('slot_a', { concurrency: 1 })])
    work(store)
    task(store, 'task_a', { status: 'blocked' })
    attempt(store, { state: 'failed', held_groups: [{ pid: 4242, started: 'then' }] })
    task(store, 'task_b')
    expect(pass()).toEqual([])
    expect(store.tasks.get('task_b')?.deferred).toMatchObject({ reason: 'capacity' })

    const { held_groups: _gone, ...rest } = store.attempts.get('att_1') as StoreDoc
    store.atomic(() => store.attempts.save(rest))
    expect(pass().map((row) => row.taskId)).toEqual(['task_b'])
  })

  it('a held group leaves its failed attempt failed, and the task still blocks', () => {
    const { store, pass } = rig([slot('slot_a', { concurrency: 1 })])
    work(store)
    task(store, 'task_a', { status: 'active' })
    attempt(store, {
      state: 'failed',
      terminal_reason: 'refused to die',
      held_groups: [{ pid: 4242, started: 'then' }],
    })
    pass('wi_1')
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'blocked',
      blockedReason: 'attempt att_1 failed: refused to die',
    })
    expect(store.attempts.get('att_1')?.state).toBe('failed')
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

  it('checks failing on the head with no repairs left block the task', () => {
    const { store, pass } = rig([slot('slot_a')], { caps: { ...DEFAULT_CAPS, repairAttemptsPerTask: 0 } })
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
    verdict(store, 'failed')
    pass()
    expect(store.tasks.get('task_a')).toMatchObject({ status: 'blocked' })
    expect(String(store.tasks.get('task_a')?.blockedReason)).toContain('Check unit failed on abc')
  })

  it('an attempt that ran out of its wall clock blocks its task and its dependents', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'active' })
    task(store, 'task_b', { dependsOn: ['task_a'] })
    attempt(store, { state: 'interrupted', terminal_reason: 'wall_clock' })

    expect(pass()).toEqual([])
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'blocked',
      blockedReason: 'attempt att_1 ran out of its wall clock',
    })
    expect(String(store.tasks.get('task_b')?.blockedReason)).toContain('prerequisite a cannot finish')
    expect(store.workItems.get('wi_1')).toMatchObject({
      state: 'blocked',
      blockedReason: 'attempt att_1 ran out of its wall clock',
    })
  })

  it('a wall clock during the checks blocks the task and its dependents', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    task(store, 'task_b', { dependsOn: ['task_a'] })
    attempt(store, {
      state: 'work_complete',
      checks_note: 'stopped during check unit: wall_clock',
      checks_stopped: 'wall_clock',
    })

    expect(pass()).toEqual([])
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'blocked',
      blockedReason: 'attempt att_1 ran out of its wall clock',
    })
    expect(String(store.tasks.get('task_b')?.blockedReason)).toContain('prerequisite a cannot finish')
  })

  it('a stop or a close during the checks stays fenced', () => {
    for (const checks_stopped of ['stop_requested', 'server_closing']) {
      const { store, pass } = rig()
      work(store)
      task(store, 'task_a', { status: 'awaiting_review' })
      attempt(store, {
        state: 'work_complete',
        checks_note: `stopped during check unit: ${checks_stopped}`,
        checks_stopped,
      })
      pass()
      expect(store.tasks.get('task_a')?.status).toBe('awaiting_review')
    }
  })

  it('a stopped attempt, or one the server closed on, is not a failure', () => {
    for (const terminal_reason of ['stop_requested', 'server_closing', undefined]) {
      const { store, pass } = rig()
      work(store)
      task(store, 'task_a', { status: 'active' })
      attempt(store, { state: 'interrupted', ...(terminal_reason !== undefined && { terminal_reason }) })
      pass()
      expect(store.tasks.get('task_a')?.status).toBe('active')
    }
  })

  for (const kind of ['failed', 'blocked'] as const) {
    it(`a specialist that reports ${kind} is not accepted, and its dependent never runs`, () => {
      const { store, pass } = rig()
      work(store)
      task(store, 'task_a', { status: 'awaiting_review' })
      task(store, 'task_b', { dependsOn: ['task_a'] })
      attempt(store, { state: 'succeeded', head_sha: 'abc', reports: 1 })
      saveReport(store, 1, { kind, summary: 'I could not do it' })

      expect(pass()).toEqual([])
      expect(store.tasks.get('task_a')).toMatchObject({
        status: 'blocked',
        blockedReason: `attempt att_1 reported ${kind}: I could not do it`,
      })
      expect(store.tasks.get('task_a')?.acceptedHead).toBeUndefined()
      expect(store.tasks.get('task_b')?.status).toBe('blocked')
      expect(String(store.tasks.get('task_b')?.blockedReason)).toContain('I could not do it')
    })
  }

  it('a dropped report ends the task, and a dependent says why it cannot start', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    task(store, 'task_b', { dependsOn: ['task_a'] })
    attempt(store, { state: 'succeeded', head_sha: 'abc', reports: 1 })
    saveReport(store, 1, { kind: 'dropped', summary: 'already done upstream' })

    expect(pass()).toEqual([])
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'cancelled',
      cancelledReason: 'attempt att_1 dropped it: already done upstream',
    })
    expect(store.events.read('work:wi_1').map((event) => event.type)).toContain('task_cancelled')
    expect(String(store.tasks.get('task_b')?.blockedReason)).toContain('already done upstream')
  })

  it('only the last report counts: a blocked attempt that recovered is accepted', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    attempt(store, { state: 'succeeded', head_sha: 'abc', reports: 2 })
    saveReport(store, 1, { kind: 'blocked', summary: 'stuck for a moment' })
    saveReport(store, 2, { kind: 'ready', summary: 'done' })
    verdict(store, 'passed')

    pass()
    expect(store.tasks.get('task_a')).toMatchObject({ status: 'accepted', acceptedHead: 'abc' })
  })

  it('a repo with no checks still hears the report: failed blocks, and work_complete stays out', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'awaiting_review' })
    attempt(store, { state: 'work_complete', checks_note: 'no checks', reports: 1 })
    saveReport(store, 1, { kind: 'failed', summary: 'nothing worked' })

    pass()
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'blocked',
      blockedReason: 'attempt att_1 reported failed: nothing worked',
    })
  })

  it('a report settles only a task still waiting on its attempt', () => {
    const { store, pass } = rig()
    work(store)
    task(store, 'task_a', { status: 'accepted', acceptedHead: 'abc' })
    attempt(store, { state: 'succeeded', head_sha: 'abc', reports: 1 })
    saveReport(store, 1, { kind: 'failed', summary: 'too late to matter' })

    pass()
    expect(store.tasks.get('task_a')?.status).toBe('accepted')
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

  it('acceptance moves a succeeded attempt’s task through the machine', () => {
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
    verdict(store, 'passed')

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

  describe('which slot an unpinned task lands on', () => {
    const claude = slot('z_claude')
    const codex = slot('a_codex', { engine: 'codex' })
    const tierOnly = (tier: string) => ({ modelRequest: { tier, reason: 'r' } })
    const onlyPlacement = (store: MemoryRepositories) => attemptsOf(store, 'task_a')[0]?.placement
    /** Both engines serve `balanced`, so only the preference can choose between them. */
    const BOTH = {
      engines: {
        ...(TABLE as unknown as { engines: Record<string, unknown> }).engines,
        codex: { select: { flag: '-m' }, models: { 'gpt-mid': { tier: 'balanced', vendor_says: 'x' } } },
      },
    } as unknown as PlacementTable

    it('takes the meta slot engine where the tier fits, and says so', () => {
      const { store, pass } = rig([codex, claude], { metaEngine: () => 'claude', table: () => BOTH })
      work(store)
      task(store, 'task_a', tierOnly('balanced'))
      expect(pass()).toMatchObject([{ slotId: 'z_claude' }])
      expect(onlyPlacement(store)).toBe("z_claude: on the meta agent's engine, claude")
    })

    it('a tier the meta engine would degrade goes where the order puts it, and says why', () => {
      // The table's Claude tops out at balanced, so `strong` degrades there; only id decides here.
      const { store, pass } = rig([claude, codex], { metaEngine: () => 'claude' })
      work(store)
      task(store, 'task_a', tierOnly('strong'))
      expect(pass()).toMatchObject([{ slotId: 'a_codex' }])
      expect(onlyPlacement(store)).toBe('a_codex: no claude slot fits; first by id of 2 tied candidates')
    })

    it('a pin beats the meta engine and keeps its reason', () => {
      const { store, pass } = rig([codex, claude], { metaEngine: () => 'claude', table: () => BOTH })
      work(store)
      task(store, 'task_a', { ...tierOnly('balanced'), slotHint: { slotId: 'a_codex' } })
      expect(pass()).toMatchObject([{ slotId: 'a_codex' }])
      expect(onlyPlacement(store)).toBe('pinned to a_codex by the plan')
    })

    it('a slot class hint is a preference: it wins where it matches, and a miss is recorded', () => {
      const matched = rig([claude, slot('a_review', { engine: 'codex', slotClass: 'review' })], {
        metaEngine: () => 'claude',
      })
      work(matched.store)
      task(matched.store, 'task_a', { slotHint: { slotClass: 'review' } })
      expect(matched.pass()).toMatchObject([{ slotId: 'a_review' }])
      expect(onlyPlacement(matched.store)).toBe('a_review: in slot class review')

      const missed = rig([claude], { metaEngine: () => 'claude' })
      work(missed.store)
      task(missed.store, 'task_a', { slotHint: { slotClass: 'review' } })
      expect(missed.pass()).toMatchObject([{ slotId: 'z_claude' }])
      expect(onlyPlacement(missed.store)).toBe(
        'z_claude: no candidate in slot class review; the only candidate',
      )
    })

    it('reports the tiebreak that decided, not a utilisation nobody read', () => {
      const tied = rig([slot('slot_a'), slot('slot_b')])
      work(tied.store)
      task(tied.store, 'task_a')
      tied.pass()
      expect(onlyPlacement(tied.store)).toBe('slot_a: first by id of 2 tied candidates')

      const measured = rig([slot('slot_a', { utilisation: 0.4 }), slot('slot_b', { utilisation: 0.1 })])
      work(measured.store)
      task(measured.store, 'task_a')
      measured.pass()
      expect(onlyPlacement(measured.store)).toBe('slot_b: lowest utilisation of 2 candidates')

      const busy = rig([slot('slot_a'), slot('slot_b')])
      work(busy.store)
      task(busy.store, 'task_b')
      task(busy.store, 'task_c')
      busy.pass()
      expect(attemptsOf(busy.store, 'task_c')[0]?.placement).toBe('slot_b: fewest attempts of 2 candidates')

      const lone = rig([slot('slot_a')])
      work(lone.store)
      task(lone.store, 'task_a')
      lone.pass()
      expect(onlyPlacement(lone.store)).toBe('slot_a: the only candidate')
    })
  })
})
