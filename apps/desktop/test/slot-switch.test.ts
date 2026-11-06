// M2.4, §5.10, §13: moving parked work to another slot. New attempt, same worktree, no session, and
// a person says yes unless policy already did.
import { join } from 'node:path'
import { loadPolicy } from '@mec/policy'
import type { SqliteStore } from '@mec/store'
import { afterEach, describe, expect, it } from 'vitest'
import { resumeAuthority } from '../src/recovery'
import { applySwitch, type SwitchDeps } from '../src/slot-switch'
import {
  attemptOf,
  brainThatNeverRuns,
  cleanUp,
  eventsOf,
  POLICY,
  PROBE_DOWN,
  PROBE_OK,
  peek,
  peekAsync,
  type Rig,
  type Served,
  scratch,
  seedStore,
  serve,
  settle,
  until,
  WORK,
} from './recovery-rig'

afterEach(cleanUp)

const STEPS = [{ init: true }, { sh: 'echo more >> resumed.txt' }, { result: 'completed' }]
const PRE_AUTHORISED = '{"preAuthorised":{"slot_switch":[{"scope":"repo","repoId":"repo_a"}]}}'
// The parked slot's reset is far ahead, so a healthy login leaves it degraded.
const QUIET = { brain: brainThatNeverRuns, probeRun: PROBE_OK } as const

/** A parked attempt on a bad slot, with its worktree on record, and a second healthy slot. */
function parked(rig: Rig, state = 'quota_wait'): string {
  const worktree = join(rig.dataDir, 'work', 'att_1')
  seedStore(rig, {
    noRow: true,
    slot: { state: 'degraded', state_reason: 'quota_exhausted', resets_at: '2099-01-01T00:00:00.000Z' },
    attempt: { state, session_id: 'session-1', worktree, branch: 'mec/abcdefgh/task_1/a1' },
  })
  peek(rig, (store) => {
    store.slots.save({
      id: 'slot_b',
      engine: 'claude',
      kind: 'claude-sub',
      home: '/nowhere',
      state: 'healthy',
      env: {},
    })
  })
  return worktree
}

const ask = (server: Served, to = 'slot_b') =>
  fetch(`${server.url}/api/work/${WORK}/switch-slot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toSlot: to, reason: 'quota' }),
  })

const card = async (server: Served): Promise<string> =>
  ((await (await ask(server)).json()) as { confirmationId: string }).confirmationId

const answer = (server: Served, id: string, value: string) =>
  fetch(`${server.url}/api/inbox/${id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer: value }),
  })

const attempts = (rig: Rig) => peek(rig, (store) => store.attempts.list({ taskId: 'task_1' }))

const NOW = '2026-11-05T11:00:00.000Z'

/** The module's own seam, on a real store, for what only a race can reach. */
const direct = (store: SqliteStore): SwitchDeps => ({
  store,
  effects: store.effects,
  policy: loadPolicy(POLICY),
  now: () => NOW,
  probe: async () => true,
})

const patchAttempt = (rig: Rig, fields: Record<string, unknown>, id = 'att_1'): void => {
  peek(rig, (store) => store.attempts.save({ ...store.attempts.get(id), id, ...(fields as object) }))
}

describe('switch slot', { timeout: 40_000 }, () => {
  it('switch needs a confirmation', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    const asked = await ask(server)
    expect(asked.status).toBe(202)
    const { confirmationId } = (await asked.json()) as { confirmationId: string }
    const doc = peek(rig, (store) => store.confirmations.get(confirmationId))
    expect(doc?.cls).toBe('slot_switch')
    expect(doc?.status).toBe('pending')
    await settle()
    expect(attempts(rig)).toHaveLength(1)
    expect((await fetch(`${server.url}/api/inbox/${confirmationId}/detail`)).status).toBe(200)
  })

  it('a denied card moves nothing', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    await answer(server, await card(server), 'deny')
    await settle()
    expect(attempts(rig)).toHaveLength(1)
  })

  it('auth park refuses switch', async () => {
    const rig = scratch(STEPS)
    parked(rig, 'auth_required')
    const server = await serve(rig, QUIET)
    const asked = await ask(server)
    expect(asked.status).toBe(409)
    expect(await asked.json()).toMatchObject({ error: 'auth_park_never_switches' })
    expect(peek(rig, (store) => store.confirmations.list({ status: 'pending' }))).toHaveLength(0)
  })

  it('new attempt, same worktree, no session id', async () => {
    const rig = scratch(STEPS)
    const worktree = parked(rig)
    const server = await serve(rig, QUIET)
    await answer(server, await card(server), 'approve')
    await until(() => attempts(rig).length === 2)
    const next = attempts(rig).find((doc) => doc.id !== 'att_1')
    expect(next).toMatchObject({ slotId: 'slot_b', taskId: 'task_1' })
    expect(next?.continuation).toMatchObject({ worktree })
    expect(next?.session_id).toBeUndefined()
    expect(attemptOf(rig)?.switched_to).toBe(next?.id)
    expect(attemptOf(rig)?.state).toBe('quota_wait')
  })

  it('handoff recorded', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    await answer(server, await card(server), 'approve')
    await until(() => attempts(rig).length === 2)
    const handoff = peek(rig, (store) =>
      store.engines.list({ workItemId: WORK }).find((doc) => String(doc.id).startsWith('handoff/')),
    )
    expect(handoff).toMatchObject({ fromSlot: 'slot_a', toSlot: 'slot_b', reason: 'quota' })
    expect(handoff?.pack).toMatchObject({ openQuestions: 0, holds: 0 })
    expect(JSON.stringify(handoff?.pack)).toContain('add the thing')
    expect(eventsOf(rig, `work:${WORK}`)).toContain('slot_switched')
  })

  it('applies once, across a restart with the card already approved', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const first = await serve(rig, QUIET)
    await answer(first, await card(first), 'approve')
    await until(() => attempts(rig).length === 2)
    await first.close()
    await serve(rig, QUIET)
    await settle()
    expect(attempts(rig)).toHaveLength(2)
  })

  it('an unhealthy target is refused', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    peek(rig, (store) => {
      const slot = { engine: 'claude', kind: 'claude-sub', home: '/nowhere', env: {} }
      store.slots.save({ id: 'slot_b', ...slot, state: 'degraded', state_reason: 'engine_unsupported' })
    })
    const server = await serve(rig, QUIET)
    expect((await ask(server)).status).toBe(409)
  })

  it('a target that fails its re-probe at approval moves nothing', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    let down = false
    const server = await serve(rig, {
      brain: brainThatNeverRuns,
      probeRun: () => (down ? PROBE_DOWN() : PROBE_OK()),
    })
    const id = await card(server)
    down = true
    await answer(server, id, 'approve')
    await until(() => eventsOf(rig, `work:${WORK}`).includes('slot_switch_refused'))
    expect(attempts(rig)).toHaveLength(1)
  })

  it('a hold is refused: a switch never lifts one', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    peek(rig, (store) => {
      const work = store.workItems.get(WORK) as Record<string, never>
      store.workItems.save({ ...work, hold: { reason: 'wait', at: 'then' } as never })
    })
    const server = await serve(rig, QUIET)
    expect((await ask(server)).status).toBe(409)
  })

  it('pre-authorised by policy runs with no card, and says so on the record', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, { ...QUIET, policyText: PRE_AUTHORISED })
    expect((await ask(server)).status).toBe(200)
    expect(peek(rig, (store) => store.confirmations.list({ status: 'pending' }))).toHaveLength(0)
    expect(attempts(rig)).toHaveLength(2)
    expect(eventsOf(rig, `work:${WORK}`)).toContain('slot_switch_preauthorised')
  })

  it('a pair moves work unasked only when policy pre-authorises it', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    peek(rig, (store) => {
      const slot = store.slots.get('slot_a') as Record<string, never>
      store.slots.save({ ...slot, pairs: ['slot_b'] as never })
    })
    const first = await serve(rig, QUIET)
    await settle()
    expect(attempts(rig)).toHaveLength(1)
    await first.close()
    await serve(rig, { ...QUIET, policyText: PRE_AUTHORISED })
    await until(() => attempts(rig).length === 2)
  })

  it('the launch on the new slot never resumes a session', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    await answer(server, await card(server), 'approve')
    await until(() => attempts(rig).length === 2)
    await until(() => rig.started() || attemptOf(rig, 'att_2')?.state === 'failed')
    if (rig.started()) expect(rig.seen().argv).not.toContain('--resume')
  })

  it('a resuming attempt cannot also switch', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    patchAttempt(rig, { resuming: true })
    const server = await serve(rig, QUIET)
    const asked = await ask(server)
    expect(asked.status).toBe(409)
    expect(await asked.json()).toMatchObject({ error: 'nothing_parked' })
    expect(attempts(rig)).toHaveLength(1)
  })

  it('a late resume row for an attempt that switched is dropped', () => {
    const rig = scratch(STEPS)
    parked(rig)
    patchAttempt(rig, { resuming: true, switched_to: 'att_2', generation: 2 })
    const payload = { attempt_id: 'att_1', work_item_id: WORK, generation: 2, resume: true }
    const verdict = peek(rig, (store) => resumeAuthority(store, payload, NOW, 'any-hash'))
    expect(verdict).toEqual({ verdict: 'drop', reason: 'attempt_not_queued' })
  })
})
