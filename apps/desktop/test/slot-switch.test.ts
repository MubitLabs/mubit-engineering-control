// M2.4, §5.10, §13: moving parked work to another slot. New attempt, same worktree, no session, and
// a person says yes unless policy already did.
import { join } from 'node:path'
import { loadPolicy } from '@mec/policy'
import type { SqliteStore } from '@mec/store'
import { afterEach, describe, expect, it } from 'vitest'
import { resumeAuthority } from '../src/recovery'
import { applyApprovedSwitches, applySwitch, requestSwitch, type SwitchDeps } from '../src/slot-switch'
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
  clean: (_attemptId, value) => value,
})

const patchAttempt = (rig: Rig, fields: Record<string, unknown>, id = 'att_1'): void => {
  peek(rig, (store) => store.attempts.save({ ...store.attempts.get(id), id, ...(fields as object) }))
}

const patchWork = (rig: Rig, fields: Record<string, unknown>): void => {
  peek(rig, (store) => {
    const work = store.workItems.get(WORK) as Record<string, never>
    store.workItems.save({ ...work, ...(fields as object) })
  })
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
    expect(eventsOf(rig, `work:${WORK}`)).not.toContain('slot_switch_refused')
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

  it('a hold keeps an open card pending at the approve, and the lift lets it land', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    const id = await card(server)
    patchWork(rig, { hold: { reason: 'wait', at: 'then' } })
    const held = await answer(server, id, 'approve')
    expect(await held.json()).toMatchObject({ status: 'pending', reason: 'held' })
    await settle()
    expect(peek(rig, (store) => store.confirmations.get(id))?.status).toBe('pending')
    expect(attempts(rig)).toHaveLength(1)

    patchWork(rig, { hold: { reason: 'wait', at: 'then', liftedAt: 'now' } })
    await answer(server, id, 'approve')
    await until(() => attempts(rig).length === 2)
  })

  it('a stop withdraws an open card at the approve, and nothing moves', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    const id = await card(server)
    patchWork(rig, { mandate: { status: 'withdrawn' } })
    const stopped = await answer(server, id, 'approve')
    expect(await stopped.json()).toMatchObject({ status: 'stale', reason: 'mandate_withdrawn' })
    await settle()
    expect(peek(rig, (store) => store.confirmations.get(id))?.status).toBe('stale')
    expect(eventsOf(rig, `work:${WORK}`)).toContain('card_withdrawn')
    expect(attempts(rig)).toHaveLength(1)
  })

  it('a deny still lands on stopped work', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    const id = await card(server)
    patchWork(rig, { mandate: { status: 'withdrawn' } })
    await answer(server, id, 'deny')
    expect(peek(rig, (store) => store.confirmations.get(id))?.status).toBe('denied')
  })

  it('a card approved before a hold waits out the hold, unused', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    await peekAsync(rig, async (store) => {
      const deps = direct(store)
      const opened = await requestSwitch(deps, { workItemId: WORK, toSlot: 'slot_b', reason: 'quota' })
      const id = String(opened.body.confirmationId)
      store.confirmations.save({ ...store.confirmations.get(id), id, status: 'approved' })
      const work = store.workItems.get(WORK) as Record<string, never>
      store.workItems.save({ ...work, hold: { reason: 'wait', at: 'then' } as never })

      await applyApprovedSwitches(deps)
      expect(store.confirmations.get(id)?.applied).toBeUndefined()
      expect(store.events.read(`work:${WORK}`).map((event) => event.type)).not.toContain(
        'slot_switch_refused',
      )

      store.workItems.save({ ...work, hold: { reason: 'wait', at: 'then', liftedAt: NOW } as never })
      await applyApprovedSwitches(deps)
      expect(store.confirmations.get(id)?.applied).toBe(true)
      expect(store.attempts.list({ taskId: 'task_1' })).toHaveLength(2)
    })
  })

  it('the handoff pack goes through the parked attempt cleaner', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    await peekAsync(rig, async (store) => {
      const clean: SwitchDeps['clean'] = (_attemptId, value) =>
        JSON.parse(JSON.stringify(value).replaceAll('add the thing', '[gone]')) as never
      const deps = { ...direct(store), clean }
      await applySwitch(deps, { workItemId: WORK, toSlot: 'slot_b', reason: 'quota' })
      const handoff = store.engines.list({ workItemId: WORK }).find((doc) => doc.fromAttempt === 'att_1')
      expect(JSON.stringify(handoff?.pack)).toContain('[gone]')
      expect(JSON.stringify(handoff?.pack)).not.toContain('add the thing')
    })
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

  it('two switches at once make one new attempt', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const answers = await peekAsync(rig, (store) => {
      const input = { workItemId: WORK, toSlot: 'slot_b', reason: 'quota' }
      return Promise.all([applySwitch(direct(store), input), applySwitch(direct(store), input)])
    })
    expect(attempts(rig)).toHaveLength(2)
    expect(answers.filter((answer) => answer === undefined)).toHaveLength(1)
    expect(eventsOf(rig, `work:${WORK}`).filter((type) => type === 'slot_switched')).toHaveLength(1)
  })

  it('an attempt that parks while the pack is built refuses the switch', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const answer = await peekAsync(rig, (store) => {
      let calls = 0
      // The second clock read is the one after the packs, just before the atomic block.
      const now = (): string => {
        calls += 1
        if (calls === 2) {
          store.attempts.save({ ...store.attempts.get('att_1'), id: 'att_9', slotId: 'slot_a' })
        }
        return NOW
      }
      const input = { workItemId: WORK, toSlot: 'slot_b', reason: 'quota' }
      return applySwitch({ ...direct(store), now }, input)
    })
    expect(answer).toBe('stale')
    expect(attemptOf(rig)?.switched_to).toBeUndefined()
    expect(eventsOf(rig, `work:${WORK}`)).toContain('slot_switch_refused')
    expect(eventsOf(rig, `work:${WORK}`)).not.toContain('slot_switched')
  })

  it('an approval moves only the attempts its card stated (§13)', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    const id = await card(server)
    // The card said att_1 on slot_a. That one resumed; another parked on a slot the owner never saw.
    peek(rig, (store) => {
      const slot = { engine: 'claude', kind: 'claude-sub', home: '/nowhere', env: {} }
      const resets = { state_reason: 'quota_exhausted', resets_at: '2099-01-01T00:00:00.000Z' }
      store.slots.save({ id: 'slot_c', ...slot, state: 'degraded', ...resets })
      store.tasks.save({ ...store.tasks.get('task_1'), id: 'task_2' })
      const first = store.attempts.get('att_1') as Record<string, never>
      store.attempts.save({ ...first, state: 'running' })
      const { session_id: _session, ...rest } = first
      store.attempts.save({ ...rest, id: 'att_2', taskId: 'task_2', slotId: 'slot_c' })
    })
    await answer(server, id, 'approve')
    await until(() => eventsOf(rig, `work:${WORK}`).includes('slot_switch_refused'))
    const body = peek(rig, (store) =>
      store.events.read(`work:${WORK}`).find((event) => event.type === 'slot_switch_refused'),
    )?.body
    expect(body).toMatchObject({ reason: 'stale' })
    expect(peek(rig, (store) => store.confirmations.get(id)?.applied)).toBe(true)
    expect(attemptOf(rig, 'att_2')?.switched_to).toBeUndefined()
    expect(peek(rig, (store) => store.attempts.list({ workItemId: WORK }))).toHaveLength(2)
  })

  it('the card states the parked attempts, and its hash binds them', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    const first = await card(server)
    const hashOf = (id: string): unknown => peek(rig, (store) => store.confirmations.get(id)?.operationHash)
    expect(peek(rig, (store) => store.confirmations.get(first)?.payload)).toMatchObject({
      parkedAttempts: ['att_1'],
      evidence: { parkedAttempts: 'att_1' },
    })
    await answer(server, first, 'deny')
    peek(rig, (store) => {
      store.attempts.save({ ...store.attempts.get('att_1'), id: 'att_1', state: 'succeeded' })
      const twin = { ...store.attempts.get('att_1'), id: 'att_2', state: 'quota_wait' }
      store.attempts.save(twin)
    })
    const second = await card(server)
    expect(hashOf(second)).not.toBe(hashOf(first))
  })

  it.each([
    ['stopped', { state: 'stopped' }, 'work_ended'],
    ['done', { state: 'done' }, 'work_ended'],
    ['withdrawn', { mandate: { status: 'withdrawn' } }, 'work_ended'],
    ['expired', { mandate: { expiresAt: '2020-01-01T00:00:00.000Z' } }, 'work_ended'],
    ['under an old policy', { mandate: { policyHash: 'an-older-policy' } }, 'policy_changed'],
  ])('work %s refuses a switch: its queued attempt would never settle', async (_name, work, error) => {
    const rig = scratch(STEPS)
    parked(rig)
    patchWork(rig, work)
    const server = await serve(rig, QUIET)
    const asked = await ask(server)
    expect(asked.status).toBe(409)
    expect(await asked.json()).toMatchObject({ error })
    expect(attempts(rig)).toHaveLength(1)
  })

  it('work stopped after the card moves nothing when it is approved', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const server = await serve(rig, QUIET)
    const id = await card(server)
    patchWork(rig, { state: 'stopped' })
    await answer(server, id, 'approve')
    await until(() => eventsOf(rig, `work:${WORK}`).includes('slot_switch_refused'))
    expect(attempts(rig)).toHaveLength(1)
    expect(peek(rig, (store) => store.confirmations.get(id)?.applied)).toBe(true)
  })

  it('a pre-authorised reason is cleaned before any write', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const clean = <T>(attemptId: string, value: T): T =>
      (typeof value === 'string' ? value.replaceAll(`token-of-${attemptId}`, '[clean]') : value) as T
    await peekAsync(rig, async (store) => {
      const deps = { ...direct(store), policy: loadPolicy(PRE_AUTHORISED), clean }
      const input = { workItemId: WORK, toSlot: 'slot_b', reason: 'quota token-of-att_1' }
      expect((await requestSwitch(deps, input)).status).toBe(200)
    })
    const written = peek(rig, (store) =>
      JSON.stringify([
        store.events.read(`work:${WORK}`),
        store.attempts.list({ workItemId: WORK }),
        store.engines.list({ workItemId: WORK }),
      ]),
    )
    expect(written).toContain('quota [clean]')
    expect(written).not.toContain('token-of-att_1')
  })

  it('a card a worker forged names no target, and is refused without stopping the pass', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    peek(rig, (store) => {
      store.confirmations.save({
        id: 'conf_forged',
        cls: 'slot_switch',
        status: 'approved',
        requestedBy: 'specialist',
        workItemId: WORK,
        attemptId: 'att_1',
        payload: { operation: { class: 'slot_switch' }, evidence: { why: 'trust me' } },
      })
    })
    // No runner and no probe run: a target of undefined reaches the store, which finds no slot.
    await serve(rig, { brain: brainThatNeverRuns, real: false })
    await until(() => eventsOf(rig, `work:${WORK}`).includes('slot_switch_refused'), 8000)
    const body = peek(rig, (store) =>
      store.events.read(`work:${WORK}`).find((event) => event.type === 'slot_switch_refused'),
    )?.body
    expect(body).toMatchObject({ reason: 'target_unhealthy' })
    expect(peek(rig, (store) => store.confirmations.get('conf_forged')?.applied)).toBe(true)
    expect(attempts(rig)).toHaveLength(1)
  })

  it('work stopped while the pack is built refuses the switch', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    const answer = await peekAsync(rig, (store) => {
      let calls = 0
      const now = (): string => {
        calls += 1
        if (calls === 2) store.workItems.save({ ...store.workItems.get(WORK), id: WORK, state: 'stopped' })
        return NOW
      }
      const input = { workItemId: WORK, toSlot: 'slot_b', reason: 'quota' }
      return applySwitch({ ...direct(store), now }, input)
    })
    expect(answer).toBe('work_ended')
    expect(attempts(rig)).toHaveLength(1)
  })

  it('a card that names no attempts stated nothing, and moves nothing', async () => {
    const rig = scratch(STEPS)
    parked(rig)
    peek(rig, (store) => {
      store.confirmations.save({
        id: 'conf_bare',
        cls: 'slot_switch',
        status: 'approved',
        workItemId: WORK,
        payload: { toSlot: 'slot_b', reason: 'quota' },
      })
    })
    await serve(rig, QUIET)
    await until(() => eventsOf(rig, `work:${WORK}`).includes('slot_switch_refused'))
    expect(attempts(rig)).toHaveLength(1)
    expect(peek(rig, (store) => store.confirmations.get('conf_bare')?.applied)).toBe(true)
  })
})
