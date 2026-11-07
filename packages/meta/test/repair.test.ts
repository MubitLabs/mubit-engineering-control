// M2.3: bounded repair and review (§11, §15), through the scheduler pass over the memory store.
import type { Json, Report, StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS, type SlotModelsView } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import {
  FollowUps,
  holdWorkItem,
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
