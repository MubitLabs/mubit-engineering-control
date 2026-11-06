// M2.3: bounded repair and review (§11, §15), through the scheduler pass over the memory store.
import type { Json, Report, StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS, type SlotModelsView } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import { FollowUps, repairLedger, repoFields, type SchedulerDeps, schedulePass } from '../src'

const AT = '2026-11-05T12:00:00.000Z'
const POLICY = '{"preAuthorised":{}}'
const REPO = 'repo_a'
const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)

const SLOT: SlotModelsView = { slotId: 'slot_a', engine: 'claude', healthy: true, marks: {}, concurrency: 4 }

function rig(extra: StoreDoc = {}) {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({
      id: REPO,
      url: 'https://example.test/a',
      bootstrap: [],
      checks: [{ name: 'unit', cmd: 'true' }],
      trust: false,
    })
    store.workItems.save({
      id: 'wi_1',
      state: 'reviewing',
      mandate: { originMessageId: 'msg_1', status: 'active' },
      ...repoFields(store, REPO, POLICY),
    })
    store.tasks.save({
      id: 'task_a',
      localKey: 'a',
      workItemId: 'wi_1',
      repoId: REPO,
      role: 'implementer',
      status: 'awaiting_review',
      dependsOn: [],
      basePolicy: 'integration',
      acceptanceChecks: ['unit'],
      createdAt: AT,
      ...extra,
    })
  })
  const deps: SchedulerDeps = {
    store,
    effects: store.effects,
    caps: DEFAULT_CAPS,
    slots: () => [SLOT],
    table: () => undefined,
    followups: new FollowUps({ store, effects: store.effects, now: () => AT }),
  }
  const pass = () => store.atomic(() => schedulePass(deps, { at: AT }))
  return { store, pass }
}

type Store = ReturnType<typeof rig>['store']

/** An attempt that ran to a verdict, as the runner leaves it. */
function finished(
  store: Store,
  id: string,
  outcome: { state: string; status: 'passed' | 'failed' | 'error'; head: string; continuation?: Json },
): void {
  store.atomic(() => {
    store.attempts.save({
      id,
      taskId: 'task_a',
      workItemId: 'wi_1',
      slotId: 'slot_a',
      state: outcome.state,
      head_sha: outcome.head,
      worktree: '/work/att_1',
      branch: 'mec/wi/task_a/a1',
      checks: ['unit'],
      createdAt: `2026-11-05T12:00:0${id.at(-1)}.000Z`,
      ...(outcome.continuation !== undefined && { continuation: outcome.continuation }),
    })
    store.engines.save({
      id: `check/${id}/unit`,
      attemptId: id,
      name: 'unit',
      status: outcome.status,
      log_tail: 'expected 2, got 3',
      sha: outcome.head,
    })
  })
}

function report(store: Store, attemptId: string, doc: Report): void {
  store.atomic(() => {
    const attempt = store.attempts.get(attemptId) as StoreDoc
    store.attempts.save({ ...attempt, reports: 1 })
    store.engines.save({
      id: `report/${attemptId}/1`,
      attemptId,
      n: 1,
      report: doc as unknown as Json,
      observed_head: attempt.head_sha ?? null,
    })
  })
}

const failing = { state: 'checks_failed', status: 'failed', head: H1 } as const

/** The queued attempt the last pass wrote. */
const queued = (store: Store) => store.attempts.list().filter((doc) => doc.state === 'queued')

describe('bounded repair (§11, §15)', () => {
  it('failed checks open a repair attempt in the same worktree with exact evidence', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', failing)
    pass()

    expect(store.tasks.get('task_a')?.status).toBe('ready')
    const [attempt] = queued(store)
    expect(attempt).toMatchObject({ role: 'repair_agent', taskId: 'task_a' })
    const continuation = attempt?.continuation as Record<string, string>
    expect(continuation).toMatchObject({
      kind: 'repair',
      worktree: '/work/att_1',
      branch: 'mec/wi/task_a/a1',
    })
    expect(continuation.evidence).toContain('unit')
    expect(continuation.evidence).toContain('expected 2, got 3')
    expect(continuation.evidence).toContain(H1)
  })

  it('repair stops at the cap and blocks', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', failing)
    finished(store, 'att_2', { ...failing, continuation: { kind: 'repair' } })
    finished(store, 'att_3', { ...failing, continuation: { kind: 'repair' } })
    pass()

    expect(queued(store)).toEqual([])
    const task = store.tasks.get('task_a')
    expect(task?.status).toBe('blocked')
    expect(String(task?.blockedReason)).toContain('unit')
    expect(String(task?.blockedReason)).toContain('2 of 2')
    expect(store.workItems.get('wi_1')?.state).toBe('blocked')
  })

  it('a pass after the repair is queued opens no second one', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', failing)
    pass()
    pass()
    expect(queued(store)).toHaveLength(1)
  })
})

describe('review of sensitive work (#13, §15)', () => {
  it('routine work gets no reviewer', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    pass()
    expect(queued(store)).toEqual([])
    expect(store.tasks.get('task_a')).toMatchObject({ status: 'accepted', acceptedHead: H1 })
  })

  it('sensitive work gets one read-only reviewer attempt on its worktree and waits for it', () => {
    const { store, pass } = rig({ sensitive: true })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    pass()
    expect(store.tasks.get('task_a')?.status).toBe('awaiting_review')
    const [attempt] = queued(store)
    expect(attempt).toMatchObject({
      role: 'code_reviewer',
      continuation: { kind: 'review', worktree: '/work/att_1' },
    })
  })

  it('a clean review on the head accepts, and a finding goes to a repair bound to that SHA', () => {
    const clean = rig({ sensitive: true })
    finished(clean.store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    finished(clean.store, 'att_2', {
      state: 'succeeded',
      status: 'passed',
      head: H1,
      continuation: { kind: 'review' },
    })
    report(clean.store, 'att_2', { kind: 'ready', summary: 'reviewed' })
    clean.pass()
    expect(clean.store.tasks.get('task_a')?.status).toBe('accepted')

    const found = rig({ sensitive: true })
    finished(found.store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    finished(found.store, 'att_2', {
      state: 'succeeded',
      status: 'passed',
      head: H1,
      continuation: { kind: 'review' },
    })
    report(found.store, 'att_2', {
      kind: 'ready',
      summary: 'one finding',
      artifacts: [{ kind: 'finding', ref: 'the key is logged in auth.ts' }],
    })
    found.pass()
    const [repair] = queued(found.store)
    const continuation = repair?.continuation as Record<string, string>
    expect(continuation.kind).toBe('repair')
    expect(continuation.evidence).toContain('the key is logged in auth.ts')
    expect(continuation.evidence).toContain(H1)
  })

  it('round count continues across attempts', () => {
    const reports = [
      { attemptId: 'att_2', report: { kind: 'ready', summary: 'x', round: { count: 2 } } },
    ] as unknown as StoreDoc[]
    const attempts = [
      { id: 'att_2', continuation: { kind: 'review' } },
      { id: 'att_3', continuation: { kind: 'repair' } },
    ] as unknown as StoreDoc[]
    // One review attempt on this record, but the report says the count already stood at two.
    expect(repairLedger(attempts, reports)).toEqual({ repairs: 1, rounds: 2 })

    const { store, pass } = rig({ sensitive: true })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    finished(store, 'att_2', {
      state: 'succeeded',
      status: 'passed',
      head: H1,
      continuation: { kind: 'review' },
    })
    report(store, 'att_2', {
      kind: 'ready',
      summary: 'a finding',
      artifacts: [{ kind: 'finding', ref: 'still wrong' }],
      round: { count: 2 },
    })
    finished(store, 'att_3', {
      state: 'succeeded',
      status: 'passed',
      head: H2,
      continuation: { kind: 'repair' },
    })
    pass()
    expect(queued(store)[0]?.continuation).toMatchObject({ kind: 'review', round: 3 })
  })

  it('the review rounds stop at their cap and block with what remains', () => {
    const { store, pass } = rig({ sensitive: true })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    finished(store, 'att_2', {
      state: 'succeeded',
      status: 'passed',
      head: H1,
      continuation: { kind: 'review' },
    })
    report(store, 'att_2', { kind: 'ready', summary: 'x', round: { count: 3 } })
    finished(store, 'att_3', { state: 'succeeded', status: 'passed', head: H2 })
    pass()
    expect(queued(store)).toEqual([])
    expect(store.tasks.get('task_a')?.status).toBe('blocked')
    expect(String(store.tasks.get('task_a')?.blockedReason)).toContain('3 of 3')
  })
})

describe('reports and the head (§10, §15)', () => {
  it('a ready from before MEC committed speaks for the commit of the tree it left', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    report(store, 'att_1', { kind: 'ready', summary: 'done' })
    pass()
    expect(store.tasks.get('task_a')?.status).toBe('accepted')
  })

  it('a ready naming a head the worktree never had is sent back', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    report(store, 'att_1', { kind: 'ready', summary: 'done', head_sha: H2 })
    store.atomic(() => {
      const doc = store.engines.get('report/att_1/1') as StoreDoc
      store.engines.save({ ...doc, head_matches: false })
    })
    pass()
    expect(store.tasks.get('task_a')?.status).not.toBe('accepted')
    expect(String((queued(store)[0]?.continuation as StoreDoc).evidence)).toContain(H2)
  })
})

describe('work state (§10)', () => {
  it('work moves executing, reviewing, integrating through the machine as tasks do', () => {
    const { store, pass } = rig()
    store.atomic(() => {
      const work = store.workItems.get('wi_1') as StoreDoc
      store.workItems.save({ ...work, state: 'executing' })
    })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    pass()
    expect(store.workItems.get('wi_1')?.state).toBe('integrating')
    const events = store.events.read('work:wi_1').map((event) => event.type)
    expect(events).toContain('task_accepted')
  })
})
