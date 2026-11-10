// M2.3: bounded repair and review (§11, §15), through the scheduler pass over the memory store.
import type { Json, Report, StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS, type SlotModelsView } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import {
  FollowUps,
  holdWorkItem,
  openRepairTask,
  ownerRepairOffer,
  ownerRetryRepair,
  repairLedger,
  repoFields,
  type SchedulerDeps,
  schedulePass,
  stopWorkItem,
} from '../src'

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
      hostRunAgreedAt: '2026-11-05T08:00:00.000Z',
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

describe("the owner's Try again (owner ruling 2026-11-07)", () => {
  /** Repairs used up: the task and its work are blocked with what remains. */
  function usedUp() {
    const r = rig()
    finished(r.store, 'att_1', failing)
    finished(r.store, 'att_2', { ...failing, continuation: { kind: 'repair' } })
    finished(r.store, 'att_3', { ...failing, continuation: { kind: 'repair' } })
    r.pass()
    return r
  }
  const work = (store: Store) => store.workItems.get('wi_1') as StoreDoc

  it('used-up repairs offer one fresh repair attempt, and pressing it queues exactly one', () => {
    const { store, pass } = usedUp()
    expect(ownerRepairOffer(store, work(store))).toMatchObject({
      taskId: 'task_a',
      reason: expect.stringContaining('repairs used up'),
    })
    expect(ownerRetryRepair(store, 'wi_1', AT)).toEqual({ status: 'retrying', taskId: 'task_a' })
    expect(work(store).state).not.toBe('blocked')
    expect(work(store).blockedReason).toBeUndefined()
    pass()
    const [attempt] = queued(store)
    expect(queued(store)).toHaveLength(1)
    expect(attempt).toMatchObject({ taskId: 'task_a', role: 'repair_agent' })
    expect(attempt?.continuation).toMatchObject({
      kind: 'repair',
      origin: 'owner',
      worktree: '/work/att_1',
      evidence: expect.stringContaining('expected 2, got 3'),
    })
    expect(store.events.read('work:wi_1').map((event) => event.type)).toContain('retry_requested')
  })

  it('a second press finds nothing to try, and nothing more is queued', () => {
    const { store, pass } = usedUp()
    ownerRetryRepair(store, 'wi_1', AT)
    expect(ownerRetryRepair(store, 'wi_1', AT)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
    pass()
    pass()
    expect(queued(store)).toHaveLength(1)
  })

  it('the fresh attempt failing again blocks again: nothing loops', () => {
    const { store, pass } = usedUp()
    ownerRetryRepair(store, 'wi_1', AT)
    pass()
    const [attempt] = queued(store)
    // It ran after the three before it, as a real one would.
    const later = { state: 'checks_failed', head_sha: H1, createdAt: '2026-11-05T12:00:09.000Z' }
    store.atomic(() => {
      store.attempts.save({ ...(attempt as StoreDoc), ...later })
      store.tasks.save({ ...(store.tasks.get('task_a') as StoreDoc), status: 'awaiting_review' })
    })
    store.atomic(() =>
      store.engines.save({
        id: `check/${String(attempt?.id)}/unit`,
        attemptId: String(attempt?.id),
        name: 'unit',
        status: 'failed',
        log_tail: 'still red',
        sha: H1,
      }),
    )
    pass()
    expect(store.tasks.get('task_a')?.status).toBe('blocked')
    expect(work(store).state).toBe('blocked')
    expect(queued(store)).toEqual([])
  })

  it('a blocked report offers it too', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    report(store, 'att_1', { kind: 'blocked', summary: 'RELEASE_STAMP is not set' })
    pass()
    expect(work(store).state).toBe('blocked')
    expect(ownerRepairOffer(store, work(store))).toMatchObject({ taskId: 'task_a' })
  })

  it('held work, stopped work and a repository not agreed to host runs offer nothing', () => {
    const held = usedUp()
    held.store.atomic(() => holdWorkItem(held.store, 'wi_1', { reason: 'wait', at: AT }))
    expect(ownerRepairOffer(held.store, work(held.store))).toBeUndefined()
    expect(ownerRetryRepair(held.store, 'wi_1', AT)).toEqual({ status: 'refused', error: 'held' })

    const stopped = usedUp()
    stopped.store.atomic(() => stopWorkItem(stopped.store, 'wi_1', { reason: 'no', at: AT }))
    expect(ownerRepairOffer(stopped.store, work(stopped.store))).toBeUndefined()

    const unagreed = usedUp()
    unagreed.store.atomic(() => {
      const { hostRunAgreedAt: _agreed, ...repo } = unagreed.store.engines.get(REPO) as StoreDoc
      unagreed.store.engines.save(repo as StoreDoc)
    })
    expect(ownerRepairOffer(unagreed.store, work(unagreed.store))).toBeUndefined()
    expect(ownerRetryRepair(unagreed.store, 'wi_1', AT)).toEqual({
      status: 'refused',
      error: 'host_run_unagreed',
    })
  })

  it('a block no repair can answer offers nothing', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'checks_failed', status: 'error', head: H1 })
    pass()
    expect(work(store).state).toBe('blocked')
    expect(ownerRepairOffer(store, work(store))).toBeUndefined()
  })
})

describe('Try again on an integration whose repairs are used up (walkthrough, 9 November 2026)', () => {
  const INTEGRATION = { worktree: '/work/integration', branch: 'mec/wi/integration' }

  /** The task is integrated, so the used-up block lands on its work: no task carries it. */
  function integrationUsedUp() {
    const r = rig({ status: 'integrated' })
    finished(r.store, 'att_2', { ...failing, continuation: { kind: 'repair' } })
    finished(r.store, 'att_3', { ...failing, continuation: { kind: 'repair' } })
    r.store.atomic(() => {
      r.store.workItems.save({ ...(r.store.workItems.get('wi_1') as StoreDoc), state: 'integrating' })
      r.store.engines.save({
        id: 'integration/wi_1',
        workItemId: 'wi_1',
        ...INTEGRATION,
        head: H2,
        integrated: { task_a: H1 },
        failed: { taskId: 'task_a', reason: 'checks_failed', sha: H2, failing: [], repairing: true },
      })
      openRepairTask(r.store, r.store.effects, DEFAULT_CAPS, {
        root: r.store.tasks.get('task_a') as StoreDoc,
        evidence: 'Check unit failed on the combined head',
        ...INTEGRATION,
        id: 'task_r',
        at: AT,
      })
    })
    return r
  }
  const work = (store: Store) => store.workItems.get('wi_1') as StoreDoc

  it('offers one fresh repair in the integration worktree, and pressing it queues exactly one', () => {
    const { store, pass } = integrationUsedUp()
    expect(work(store)).toMatchObject({
      state: 'blocked',
      blockedReason: expect.stringContaining('repairs used up'),
    })
    expect(store.tasks.get('task_r')).toBeUndefined()
    expect(ownerRepairOffer(store, work(store))).toMatchObject({
      taskId: 'task_a',
      reason: expect.stringContaining('repairs used up'),
    })
    const outcome = ownerRetryRepair(store, 'wi_1', AT)
    expect(outcome).toMatchObject({ status: 'retrying' })
    expect(work(store).state).toBe('integrating')
    expect(work(store).blockedReason).toBeUndefined()
    const repair = store.tasks.list({ workItemId: 'wi_1' }).find((task) => task.repairOf === 'task_a')
    expect(repair).toMatchObject({ status: 'ready', role: 'repair_agent', basePolicy: 'integration' })
    expect(outcome).toEqual({ status: 'retrying', taskId: repair?.id })
    expect(store.tasks.get('task_a')?.status).toBe('integrated')
    pass()
    expect(queued(store)).toHaveLength(1)
    expect(queued(store)[0]).toMatchObject({ taskId: repair?.id, role: 'repair_agent' })
    expect(queued(store)[0]?.continuation).toMatchObject({
      kind: 'repair',
      origin: 'owner',
      ...INTEGRATION,
      evidence: expect.stringContaining('repairs used up'),
    })
    expect(store.events.read('work:wi_1').map((event) => event.type)).toContain('retry_requested')
  })

  it('a second press finds nothing to try', () => {
    const { store } = integrationUsedUp()
    ownerRetryRepair(store, 'wi_1', AT)
    expect(ownerRetryRepair(store, 'wi_1', AT)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
    expect(
      store.tasks.list({ workItemId: 'wi_1' }).filter((task) => task.repairOf === 'task_a'),
    ).toHaveLength(1)
  })

  it('held work and a repository not agreed to host runs offer nothing', () => {
    const held = integrationUsedUp()
    held.store.atomic(() => holdWorkItem(held.store, 'wi_1', { reason: 'wait', at: AT }))
    expect(ownerRepairOffer(held.store, work(held.store))).toBeUndefined()
    const unagreed = integrationUsedUp()
    unagreed.store.atomic(() => {
      const { hostRunAgreedAt: _agreed, ...repo } = unagreed.store.engines.get(REPO) as StoreDoc
      unagreed.store.engines.save(repo as StoreDoc)
    })
    expect(ownerRepairOffer(unagreed.store, work(unagreed.store))).toBeUndefined()
  })

  it('an integration with no failure on record offers nothing', () => {
    const { store } = integrationUsedUp()
    store.atomic(() => {
      const { failed: _failed, ...doc } = store.engines.get('integration/wi_1') as StoreDoc
      store.engines.save(doc as StoreDoc)
    })
    expect(ownerRepairOffer(store, work(store))).toBeUndefined()
  })
})

describe('repair tasks from integration (§14, decision #36)', () => {
  it("carry the root task's model request, so the cheapest tier stays the cheapest tier", () => {
    const modelRequest = { tier: 'fast', reason: 'the owner asked for the cheapest tier' }
    const { store } = rig({ status: 'integrated', modelRequest })
    store.atomic(() =>
      openRepairTask(store, store.effects, DEFAULT_CAPS, {
        root: store.tasks.get('task_a') as StoreDoc,
        evidence: 'Check docs failed on abc',
        worktree: '/work/integration',
        branch: 'mec/wi/integration',
        id: 'task_r',
        at: AT,
      }),
    )
    expect(store.tasks.get('task_r')).toMatchObject({ repairOf: 'task_a', modelRequest })
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
    expect(queued(store)[0]?.continuation).toMatchObject({ evidence: expect.stringContaining(H2) })
  })
})

describe('no change, a Blocked: ending and owned paths (real runs 2026-11-06/07)', () => {
  /** The attempt's own fields the runner leaves: where it started and what its commits changed. */
  const patch = (store: Store, id: string, fields: StoreDoc): void =>
    store.atomic(() => store.attempts.save({ ...(store.attempts.get(id) as StoreDoc), ...fields }))

  const say = (store: Store, id: string, text: string): void =>
    store.atomic(() => {
      const stream = `attempt:${id}`
      const seq = store.events.read(stream).length + 1
      store.events.append(stream, {
        stream,
        seq,
        at: AT,
        type: 'message',
        body: { type: 'message', role: 'assistant', text },
      })
    })

  it('green checks on the unchanged base with no report go to a repair, not acceptance', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    patch(store, 'att_1', { base_sha: H1 })
    pass()
    expect(store.tasks.get('task_a')?.status).not.toBe('accepted')
    expect(queued(store)[0]?.continuation).toMatchObject({
      kind: 'repair',
      evidence: expect.stringContaining('no change'),
    })
  })

  it('a brief that allows no change accepts the unchanged base', () => {
    const { store, pass } = rig({ noChangeOk: true })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    patch(store, 'att_1', { base_sha: H1 })
    pass()
    expect(store.tasks.get('task_a')?.status).toBe('accepted')
  })

  it('a final message beginning Blocked: with no report blocks the task with its words', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    patch(store, 'att_1', { base_sha: H1 })
    say(store, 'att_1', 'Looking at the task.')
    say(store, 'att_1', '**Blocked:** the harness refuses `sleep 80`, so I did not run the waits.')
    pass()
    const task = store.tasks.get('task_a')
    expect(task?.status).toBe('blocked')
    expect(String(task?.blockedReason)).toContain('the harness refuses')
    expect(queued(store)).toEqual([])
  })

  it('a Blocked: word earlier in the turn, not at its end, decides nothing', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    say(store, 'att_1', 'Blocked: the first try failed.')
    say(store, 'att_1', 'Fixed it; the test passes.')
    pass()
    expect(store.tasks.get('task_a')?.status).toBe('accepted')
  })

  it("a commit outside the task's owned paths is sent to a repair with the reason", () => {
    const { store, pass } = rig({ ownedPaths: ['src/slug.mjs', 'test/slug.test.mjs'] })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    patch(store, 'att_1', { base_sha: H2, changed_paths: ['src/slug.mjs', 'src/title.mjs'] })
    pass()
    expect(store.tasks.get('task_a')?.status).not.toBe('accepted')
    expect(queued(store)[0]?.continuation).toMatchObject({
      kind: 'repair',
      evidence: expect.stringContaining('src/title.mjs'),
    })
  })

  it('a task with no owned paths takes any change', () => {
    const { store, pass } = rig({ ownedPaths: [] })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    patch(store, 'att_1', { base_sha: H2, changed_paths: ['anything.txt'] })
    pass()
    expect(store.tasks.get('task_a')?.status).toBe('accepted')
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

describe("an implementer's own notes and a repair that found nothing (live, 10 November 2026)", () => {
  /** The implementer's ready report, its artifacts of kind `finding` describing what it made. */
  const notes: Report = {
    kind: 'ready',
    summary: 'Created the home page.',
    artifacts: [
      { kind: 'finding', ref: 'index.html — new home page markup' },
      { kind: 'finding', ref: 'style.css — warm palette' },
    ],
  }
  const nothingToFix: Report = {
    kind: 'dropped',
    summary: 'Neither finding reproduces as a defect. Both describe the content, so no fix was applied.',
  }
  const one = (ref: string): Report => ({
    kind: 'ready',
    summary: 'one',
    artifacts: [{ kind: 'finding', ref }],
  })
  const repair = { kind: 'repair', role: 'repair_agent', evidence: 'x', round: 0 }
  const review = { kind: 'review', role: 'code_reviewer', evidence: 'x', round: 1 }

  it("the implementer's own finding artifacts start no repair, and the task is accepted", () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    report(store, 'att_1', notes)
    pass()
    expect(queued(store)).toEqual([])
    expect(store.tasks.get('task_a')).toMatchObject({ status: 'accepted', acceptedHead: H1 })
    expect(store.tasks.get('task_a')?.findings).toBeUndefined()
  })

  it('a planned reviewer role still finds: its findings route to a repair', () => {
    const { store, pass } = rig({ role: 'code_reviewer' })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    store.atomic(() => {
      const doc = store.attempts.get('att_1') as StoreDoc
      store.attempts.save({ ...doc, role: 'code_reviewer' })
    })
    report(store, 'att_1', one('no alt text'))
    pass()
    expect(queued(store)[0]?.continuation).toMatchObject({ kind: 'repair' })
  })

  it('the live replay: a repair sent on self-notes that drops is judged on its head, never cancelled', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    report(store, 'att_1', notes)
    finished(store, 'att_2', { state: 'succeeded', status: 'passed', head: H1, continuation: repair })
    report(store, 'att_2', nothingToFix)
    pass()
    expect(store.tasks.get('task_a')).toMatchObject({ status: 'accepted', acceptedHead: H1 })
    const events = store.events.read('work:wi_1').map((event) => event.type)
    expect(events).not.toContain('task_cancelled')
  })

  it("a reviewer's findings a repair declined are recorded declined with one factual sentence", () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    finished(store, 'att_2', { state: 'succeeded', status: 'passed', head: H1, continuation: review })
    report(store, 'att_2', one('no alt text'))
    finished(store, 'att_3', { state: 'succeeded', status: 'passed', head: H1, continuation: repair })
    report(store, 'att_3', nothingToFix)
    pass()
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'accepted',
      acceptedHead: H1,
      findings: [
        { text: 'no alt text', disposition: 'declined', reason: 'Neither finding reproduces as a defect.' },
      ],
    })
  })

  it('a finding a repair fixed stays fixed, silently', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    finished(store, 'att_2', { state: 'succeeded', status: 'passed', head: H1, continuation: review })
    report(store, 'att_2', one('no alt text'))
    finished(store, 'att_3', { state: 'succeeded', status: 'passed', head: H2, continuation: repair })
    report(store, 'att_3', { kind: 'ready', summary: 'Added the alt text.' })
    pass()
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'accepted',
      findings: [{ text: 'no alt text', disposition: 'fixed' }],
    })
  })

  it('each finding is answered by the repair after its own review', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    finished(store, 'att_2', { state: 'succeeded', status: 'passed', head: H1, continuation: review })
    report(store, 'att_2', one('no alt text'))
    finished(store, 'att_3', { state: 'succeeded', status: 'passed', head: H1, continuation: repair })
    report(store, 'att_3', nothingToFix)
    finished(store, 'att_4', { state: 'succeeded', status: 'passed', head: H1, continuation: review })
    report(store, 'att_4', one('the link is broken'))
    finished(store, 'att_5', { state: 'succeeded', status: 'passed', head: H2, continuation: repair })
    report(store, 'att_5', { kind: 'ready', summary: 'Fixed the link.' })
    pass()
    expect(store.tasks.get('task_a')).toMatchObject({
      status: 'accepted',
      acceptedHead: H2,
      findings: [
        { text: 'no alt text', disposition: 'declined', reason: 'Neither finding reproduces as a defect.' },
        { text: 'the link is broken', disposition: 'fixed' },
      ],
    })
  })

  it('sensitive work: a declined repair goes on to the next review of the same head', () => {
    const { store, pass } = rig({ sensitive: true })
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    finished(store, 'att_2', { state: 'succeeded', status: 'passed', head: H1, continuation: review })
    report(store, 'att_2', one('no alt text'))
    finished(store, 'att_3', { state: 'succeeded', status: 'passed', head: H1, continuation: repair })
    report(store, 'att_3', nothingToFix)
    pass()
    expect(store.tasks.get('task_a')?.status).not.toBe('cancelled')
    expect(queued(store)[0]?.continuation).toMatchObject({ kind: 'review', round: 2 })
  })

  it("a dropped report from the task's own implementer still ends it", () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    report(store, 'att_1', { kind: 'dropped', summary: 'already done upstream' })
    pass()
    expect(store.tasks.get('task_a')?.status).toBe('cancelled')
  })
})

describe('work whose every task ended (live, 10 November 2026)', () => {
  const cancelled = (store: Store): void =>
    store.atomic(() => {
      const doc = store.tasks.get('task_a') as StoreDoc
      store.tasks.save({ ...doc, status: 'cancelled', cancelledReason: 'attempt att_2 dropped it: nothing' })
    })

  it('blocks in plain words instead of sitting at reviewing with nothing running', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'succeeded', status: 'passed', head: H1 })
    cancelled(store)
    pass()
    const work = store.workItems.get('wi_1')
    expect(work?.state).toBe('blocked')
    expect(String(work?.blockedReason)).toBe(
      'every task ended with no result to deliver: a was cancelled (attempt att_2 dropped it: nothing)',
    )
    expect(work?.blockedTask).toBeUndefined()
    // Nothing comes back by itself: the cancelled task stays cancelled, and nothing is queued.
    expect(store.tasks.get('task_a')?.status).toBe('cancelled')
    expect(queued(store)).toEqual([])
    pass()
    expect(store.workItems.get('wi_1')?.state).toBe('blocked')
  })

  it('waits while an attempt still holds its place', () => {
    const { store, pass } = rig()
    finished(store, 'att_1', { state: 'running', status: 'passed', head: H1 })
    cancelled(store)
    pass()
    expect(store.workItems.get('wi_1')?.state).toBe('reviewing')
  })
})
