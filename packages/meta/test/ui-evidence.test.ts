// §14, §15: the scheduler's acceptance holds a user-visible change back for before and after
// screenshots where the repository requires them, and decides as before where it does not.
import type { Store, StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import {
  evidenceDocId,
  FollowUps,
  plannerContextFromStore,
  profileChanged,
  repoFields,
  retakeScreenshots,
  type SchedulerDeps,
  schedulePass,
  screenshotsDue,
  screenshotsOffer,
  screenshotWait,
} from '../src'

const AT = '2026-11-10T12:00:00.000Z'
const POLICY = '{"preAuthorised":{}}'
const REPO = 'repo_a'
const BASE = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)

function rig(uiEvidence?: StoreDoc) {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({
      id: REPO,
      url: 'https://example.test/a',
      bootstrap: [],
      checks: [{ name: 'unit', cmd: 'true' }],
      trust: false,
      hostRunAgreedAt: AT,
      ...(uiEvidence !== undefined && { uiEvidence }),
    })
    store.workItems.save({
      id: 'wi_1',
      state: 'executing',
      mandate: { originMessageId: 'msg_1', status: 'active' },
      ...repoFields(store, REPO, POLICY),
    })
    store.tasks.save({
      id: 'task_a',
      localKey: 'a',
      workItemId: 'wi_1',
      repoId: REPO,
      role: 'implementer',
      status: 'active',
      dependsOn: [],
      basePolicy: 'contract',
      createdAt: AT,
    })
  })
  const deps: SchedulerDeps = {
    store,
    effects: store.effects,
    caps: DEFAULT_CAPS,
    slots: () => [],
    table: () => undefined,
    followups: new FollowUps({ store, effects: store.effects, now: () => AT }),
  }
  const pass = () => store.atomic(() => schedulePass(deps, { at: AT }))
  return { store, pass }
}

/** A finished attempt on HEAD from BASE with `unit` green, having changed `changed`. */
function finished(store: MemoryRepositories, changed: string[], id = 'att_1', extra: StoreDoc = {}): void {
  store.atomic(() => {
    store.attempts.save({
      id,
      taskId: 'task_a',
      workItemId: 'wi_1',
      slotId: 'slot_a',
      state: 'succeeded',
      base_sha: BASE,
      head_sha: HEAD,
      changed_paths: changed,
      checks: ['unit'],
      createdAt: AT,
      ...extra,
    })
    store.engines.save({ id: `check/${id}/unit`, attemptId: id, name: 'unit', status: 'passed', sha: HEAD })
  })
}

const shot = (file: string) => ({ path: '/', file, bytes: 100, at: AT, status: 200 })

function captured(store: MemoryRepositories, fields: StoreDoc, attemptId = 'att_1'): void {
  store.atomic(() =>
    store.engines.save({
      id: evidenceDocId(attemptId),
      attemptId,
      taskId: 'task_a',
      workItemId: 'wi_1',
      repoId: REPO,
      ...fields,
    }),
  )
}

const BOTH = {
  state: 'taken',
  before: { sha: BASE, status: 'captured', shots: [shot('before-1.png')] },
  after: { sha: HEAD, status: 'captured', shots: [shot('after-1.png')] },
}

const work = (store: Store) => store.workItems.get('wi_1') as StoreDoc
const status = (store: Store) => store.tasks.get('task_a')?.status

describe('UI evidence at acceptance (§15)', () => {
  it('flag off: a user-visible change is accepted on its checks, as before', () => {
    const { store, pass } = rig()
    finished(store, ['index.html'])
    pass()
    expect(status(store)).toBe('accepted')
    expect(screenshotWait(store, work(store))).toBeUndefined()
  })

  it('flag on: a user-visible change waits for both screenshots, and says so', () => {
    const { store, pass } = rig({ required: true })
    finished(store, ['index.html', 'style.css'])
    pass()
    expect(status(store)).toBe('active')
    expect(screenshotWait(store, work(store))).toEqual({ state: 'waiting' })
    expect(screenshotsDue(store, 'wi_1').map((due) => [due.task.id, due.attempt.id, due.state])).toEqual([
      ['task_a', 'att_1', 'waiting'],
    ])
    pass()
    expect(status(store)).toBe('active')
  })

  it('flag on: after-only is not enough', () => {
    const { store, pass } = rig({ required: true })
    finished(store, ['app.js'])
    const { before: _before, ...afterOnly } = BOTH
    captured(store, afterOnly)
    pass()
    expect(status(store)).toBe('active')
  })

  it('flag on: both captures on the right commits accept it', () => {
    const { store, pass } = rig({ required: true })
    finished(store, ['index.html'])
    captured(store, BOTH)
    pass()
    expect(status(store)).toBe('accepted')
    expect(screenshotWait(store, work(store))).toBeUndefined()
  })

  it('flag on: a change users do not see needs none', () => {
    const { store, pass } = rig({ required: true })
    finished(store, ['README.md'])
    pass()
    expect(status(store)).toBe('accepted')
  })

  it('the repository’s own globs decide what users see', () => {
    const { store, pass } = rig({ required: true, patterns: ['web/**'] })
    finished(store, ['index.html'])
    pass()
    expect(status(store)).toBe('accepted')
  })

  it('a capture that could not be taken is the owner’s to retry, never a pass', () => {
    const { store, pass } = rig({ required: true })
    finished(store, ['index.html'])
    captured(store, {
      state: 'could_not',
      before: BOTH.before,
      after: {
        sha: HEAD,
        status: 'could_not',
        reason: 'the app did not answer on 127.0.0.1:4100 within 30 s',
      },
    })
    pass()
    expect(status(store)).toBe('active')
    expect(screenshotWait(store, work(store))).toEqual({ state: 'could_not', side: 'after' })
    expect(screenshotsOffer(store, work(store))).toEqual({
      reason: "Couldn't take the after screenshot: the app did not answer on 127.0.0.1:4100 within 30 s",
    })
    expect(store.atomic(() => retakeScreenshots(store, 'wi_1', AT))).toBe(1)
    expect(store.engines.get(evidenceDocId('att_1'))).toMatchObject({ state: 'requested' })
    expect(store.engines.get(evidenceDocId('att_1'))?.after).toBeUndefined()
    expect(screenshotWait(store, work(store))).toEqual({ state: 'waiting' })
    expect(screenshotsOffer(store, work(store))).toBeUndefined()
  })

  it('held work offers no retry', () => {
    const { store } = rig({ required: true })
    finished(store, ['index.html'])
    captured(store, { state: 'could_not', after: { sha: HEAD, status: 'could_not', reason: 'x' } })
    store.atomic(() => store.workItems.save({ ...work(store), hold: { at: AT, reason: 'wait' } }))
    expect(screenshotsOffer(store, work(store))).toBeUndefined()
  })

  it('under a review, the captures of the work it read are the evidence', () => {
    const { store, pass } = rig({ required: true })
    finished(store, ['index.html'])
    finished(store, [], 'att_2', { continuation: { kind: 'review' }, createdAt: '2026-11-10T12:05:00.000Z' })
    captured(store, BOTH)
    pass()
    expect(status(store)).toBe('accepted')
  })

  it('turning the flag on changes no pinned profile: work in flight is not refused', () => {
    const { store } = rig()
    expect(profileChanged(store, REPO, work(store))).toBe(false)
    store.atomic(() =>
      store.engines.save({ ...(store.engines.get(REPO) as StoreDoc), uiEvidence: { required: true } }),
    )
    expect(profileChanged(store, REPO, work(store))).toBe(false)
  })

  it('the planner reads the same stage', () => {
    const { store, pass } = rig({ required: true })
    finished(store, ['index.html'])
    pass()
    const context = plannerContextFromStore(store, {
      turn: { wake: 'user message' } as never,
      policyText: POLICY,
      caps: DEFAULT_CAPS,
      now: () => AT,
    })
    expect(context.work[0]?.stage).toBe('Waiting for before and after screenshots')
  })
})
