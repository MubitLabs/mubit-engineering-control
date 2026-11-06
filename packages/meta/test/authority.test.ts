import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPolicy } from '../../policy/src/policy'
import type { MetaBrain, MetaDecision, PlannerTools } from '../src'
import { fakeBrain, isHeld, launchAuthority, MetaAgentService, mandateOf, refuseLaunch } from '../src'

/**
 * The authority fence (M1.4a, spec §10, §12.5, §13 invariant 4, decisions #20 and #21): a stop
 * ends work for good, a hold lasts until the owner's lift, and only the owner's commands decide.
 */

const NOW = '2026-11-05T12:00:00.000Z'
const POLICY = '{"preAuthorised":{}}'
const POLICY_HASH = loadPolicy(POLICY).versionHash

const plan = (...keys: [string, string[]][]): MetaDecision => ({
  ack: 'On it',
  plan: {
    tasks: keys.map(([taskId, dependsOn]) => ({
      taskId,
      objective: `Do ${taskId}`,
      dependsOn,
      role: 'implementer',
    })),
  },
})

const rig = (brain: MetaBrain, store = new MemoryRepositories()) => {
  if (store.engines.get('repo_a') === undefined) {
    store.atomic(() => {
      store.engines.save({
        id: 'repo_a',
        url: 'https://example.test/a',
        bootstrap: [],
        checks: [],
        trust: true,
      })
    })
  }
  const service = new MetaAgentService({
    store,
    effects: store.effects,
    brain,
    now: () => NOW,
    policyText: POLICY,
  })
  return { service, store }
}

/** A brain that stays on its await until the test answers, so the race window is real. */
const heldBrain = () => {
  const answers: ((decision: MetaDecision) => void)[] = []
  const brain: MetaBrain = () => new Promise((resolve) => answers.push(resolve))
  return { brain, answer: (decision: MetaDecision) => answers.shift()!(decision) }
}

/** A brain answering each turn in order; the last answer repeats. */
const scripted = (...decisions: MetaDecision[]): MetaBrain => {
  let turn = 0
  return async () => decisions[Math.min(turn++, decisions.length - 1)]!
}

const launchPayload = (store: MemoryRepositories) =>
  store.snapshot().effects.map((row) => row.payload)[0] as {
    attempt_id: string
    task_id: string
    work_item_id: string
  }

const eventTypes = (store: MemoryRepositories, workItemId: string): string[] =>
  store.events.read(`work:${workItemId}`).map((event) => event.type)

const start = async (service: MetaAgentService): Promise<string> => {
  const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'do it', repoId: 'repo_a' })
  return outcome.workItemId!
}

/** Starts a turn on a held brain; the work item exists before the brain answers. */
const startHeld = (service: MetaAgentService, store: MemoryRepositories) => {
  const turn = service.onUserMessage({ messageId: 'msg_1', text: 'do it', repoId: 'repo_a' })
  return { turn, id: String(store.workItems.list()[0]!.id) }
}

describe('authority fence', () => {
  beforeEach(() => {
    process.env.MEC_FAKE_ENGINE = '1'
  })
  afterEach(() => {
    delete process.env.MEC_FAKE_ENGINE
  })

  describe('mandates', () => {
    it('new work carries a real mandate pinned to the policy version', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      const work = store.workItems.get(id)!
      expect(work.mandate).toMatchObject({
        originMessageId: 'msg_1',
        scope: 'do it',
        policyHash: POLICY_HASH,
        budgetTurns: 0,
        expiresAt: null,
        status: 'active',
      })
      expect((work.pin as { policyHash: string }).policyHash).toBe(POLICY_HASH)
    })

    it('scope is the first 200 characters of the origin message', async () => {
      const { service, store } = rig(fakeBrain({ ack: 'Thinking' }))
      const text = 'x'.repeat(300)
      const { workItemId } = await service.onUserMessage({ messageId: 'msg_1', text, repoId: 'repo_a' })
      expect((store.workItems.get(workItemId!)!.mandate as { scope: string }).scope).toBe('x'.repeat(200))
    })

    it('legacy mandate status derives from work state', () => {
      const legacy = { id: 'wi_old', mandate: { originMessageId: 'msg_0' } }
      expect(mandateOf({ ...legacy, state: 'stopped' }).status).toBe('withdrawn')
      expect(mandateOf({ ...legacy, state: 'executing' })).toMatchObject({
        status: 'active',
        originMessageId: 'msg_0',
        expiresAt: null,
      })
    })
  })

  describe('commit fence', () => {
    it('stop during awaited planning launches nothing', async () => {
      const { brain, answer } = heldBrain()
      const { service, store } = rig(brain)
      const { turn, id } = startHeld(service, store)

      expect(service.stopWork(id)).toBe('stopped')
      answer({
        ...plan(['a', []]),
        questions: [{ id: 'q_1', question: 'Which?', options: [], at: NOW }],
      })
      const outcome = await turn

      expect(outcome.launchesEnqueued).toEqual([])
      expect(outcome.tasksCreated).toBe(0)
      expect(outcome.acknowledged).toContain('stopped')
      expect(outcome.acknowledged).toContain('nothing')
      expect(store.snapshot().effects).toEqual([])
      expect(store.attempts.list()).toEqual([])
      expect(store.tasks.list()).toEqual([])
      expect(store.engines.get('question/q_1')).toBeUndefined()
      expect(store.workItems.get(id)?.state).toBe('stopped')
      expect(store.messages.get('msg_1')?.ackText).toBe(outcome.acknowledged)
    })

    it('an ack-only turn on work stopped mid-turn keeps none of its extras', async () => {
      const { brain, answer } = heldBrain()
      const { service, store } = rig(brain)
      const { turn, id } = startHeld(service, store)

      service.stopWork(id)
      answer({ ack: 'Which?', questions: [{ id: 'q_1', question: 'Which?', options: [], at: NOW }] })
      const outcome = await turn

      expect(outcome.acknowledged).toContain('stopped')
      expect(store.engines.get('question/q_1')).toBeUndefined()
    })

    it('an invalid plan on work stopped mid-turn is discarded as stopped', async () => {
      const { brain, answer } = heldBrain()
      const { service, store } = rig(brain)
      const { turn, id } = startHeld(service, store)

      service.stopWork(id)
      answer(plan(['a', ['missing']]))
      const outcome = await turn

      expect(outcome.acknowledged).toContain('stopped')
      expect(eventTypes(store, id)).not.toContain('plan_rejected')
    })

    it('a plan finishing during a hold saves tasks with zero launches', async () => {
      const { brain, answer } = heldBrain()
      const { service, store } = rig(brain)
      const { turn, id } = startHeld(service, store)

      expect(service.holdWork(id, 'wait')).toBe('held')
      answer(plan(['a', []], ['b', ['a']]))
      const outcome = await turn

      expect(outcome.tasksCreated).toBe(2)
      expect(outcome.launchesEnqueued).toEqual([])
      expect(outcome.acknowledged).toContain('held')
      expect(store.messages.get('msg_1')?.ackText).toBe(outcome.acknowledged)
      expect(store.tasks.list({ workItemId: id })).toHaveLength(2)
      expect(store.engines.get(`plan/${id}/1`)).toBeDefined()
      expect(store.attempts.list()).toEqual([])
      expect(store.snapshot().effects).toEqual([])
      expect(isHeld(store.workItems.get(id)!)).toBe(true)
      expect(store.workItems.get(id)?.state).toBe('executing')
    })

    it('a replan on executing work commits without a machine error', async () => {
      const { service, store } = rig(scripted(plan(['a', []]), plan(['a', []], ['b', []])))
      const id = await start(service)
      expect(store.workItems.get(id)?.state).toBe('executing')

      const outcome = await service.onWake({ reason: 'specialist report', workItemId: id })

      expect(outcome.tasksCreated).toBe(2)
      expect(store.workItems.get(id)?.state).toBe('executing')
      expect(store.workItems.get(id)?.planRevision).toBe(2)
    })

    it('a replan never moves blocked work back to executing or launches it', async () => {
      const { service, store } = rig(scripted(plan(['a', []]), plan(['a', []], ['b', []])))
      const id = await start(service)
      const work = store.workItems.get(id)!
      store.atomic(() => store.workItems.save({ ...work, state: 'blocked' }))

      const outcome = await service.onWake({ reason: 'specialist report', workItemId: id })

      expect(store.workItems.get(id)?.state).toBe('blocked')
      expect(outcome.launchesEnqueued).toEqual([])
    })

    it('a stop route in the same turn as a plan launches nothing', async () => {
      const { brain, answer } = heldBrain()
      const { service, store } = rig(brain)
      const { turn, id } = startHeld(service, store)
      answer({ ...plan(['a', []]), routes: [{ messageId: 'msg_1', decision: 'stop', target: id }] })
      await turn

      expect(store.workItems.get(id)?.state).toBe('stopped')
      expect(store.snapshot().effects).toEqual([])
    })
  })

  describe('wakes', () => {
    it('wake on stopped work never calls the brain', async () => {
      let calls = 0
      const { service } = rig(async () => {
        calls += 1
        return plan(['a', []])
      })
      const id = await start(service)
      service.stopWork(id)
      calls = 0

      const outcome = await service.onWake({ reason: 'specialist report', workItemId: id })

      expect(calls).toBe(0)
      expect(outcome.launchesEnqueued).toEqual([])
    })

    it('late answer cannot revive stopped work', async () => {
      const { service, store } = rig(
        scripted(
          { ack: 'Which?', questions: [{ id: 'q_1', question: 'Which?', options: [], at: NOW }] },
          plan(['a', []]),
        ),
      )
      const id = await start(service)
      service.stopWork(id)

      const answered = await service.onQuestionAnswered('q_1', 'that one')

      expect(answered.status).toBe('answered')
      expect(store.workItems.get(id)?.state).toBe('stopped')
      expect(store.tasks.list()).toEqual([])
      expect(store.snapshot().effects).toEqual([])
    })

    it('failed wake does not stop executing work', async () => {
      let turn = 0
      const { service, store } = rig(async () => {
        turn += 1
        if (turn > 1) throw new Error('brain down')
        return plan(['a', []])
      })
      const id = await start(service)

      await service.onWake({ reason: 'specialist report', workItemId: id })

      expect(store.workItems.get(id)?.state).toBe('executing')
      expect(eventTypes(store, id)).toContain('meta_agent_error')
      expect(eventTypes(store, id)).not.toContain('work_stopped')
    })

    it('plan rejection on a wake does not stop executing work', async () => {
      const { service, store } = rig(scripted(plan(['a', []]), plan(['b', ['missing']])))
      const id = await start(service)

      await service.onWake({ reason: 'specialist report', workItemId: id })

      expect(store.workItems.get(id)?.state).toBe('executing')
      expect(eventTypes(store, id)).toContain('plan_rejected')
      expect(eventTypes(store, id)).not.toContain('work_stopped')
    })

    it('a hold or stop route on a wake turn is ignored', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      const wakeWith = (decision: 'hold' | 'stop') => {
        const { service: awake } = rig(
          fakeBrain({ ack: 'ok', routes: [{ messageId: 'msg_wake', decision, target: id }] }),
          store,
        )
        return awake.onWake({ reason: 'timer', workItemId: id })
      }

      await wakeWith('hold')
      await wakeWith('stop')

      const work = store.workItems.get(id)!
      expect(isHeld(work)).toBe(false)
      expect(work.state).toBe('executing')
      expect(mandateOf(work).status).toBe('active')
      expect(eventTypes(store, id).filter((type) => type === 'route_refused')).toHaveLength(2)
    })
  })

  describe('holds', () => {
    it('hold survives restart and blocks launch', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      service.holdWork(id, 'wait')

      const { store: reopened } = rig(fakeBrain(plan(['a', []])), store)

      expect(isHeld(reopened.workItems.get(id)!)).toBe(true)
      expect(launchAuthority(reopened, launchPayload(reopened), NOW, POLICY_HASH)).toEqual({
        verdict: 'defer',
        reason: 'held',
      })
    })

    it('a hold records the message that caused it', async () => {
      const { service, store } = rig(fakeBrain({ ack: 'Thinking' }))
      const id = await start(service)
      service.holdWork(id, 'wait', 'msg_9')
      expect(store.workItems.get(id)?.hold).toMatchObject({ reason: 'wait', sourceMessageId: 'msg_9' })
    })

    it('a second hold keeps the first', async () => {
      const { service, store } = rig(fakeBrain({ ack: 'Thinking' }))
      const id = await start(service)
      service.holdWork(id, 'first')
      const before = JSON.stringify(store.snapshot())

      expect(service.holdWork(id, 'second')).toBe('held')
      expect(JSON.stringify(store.snapshot())).toBe(before)
    })

    it('lift launches the saved ready tasks once', async () => {
      const { brain, answer } = heldBrain()
      const { service, store } = rig(brain)
      const { turn, id } = startHeld(service, store)
      service.holdWork(id, 'wait')
      answer(plan(['a', []], ['b', ['a']]))
      await turn

      const lifted = service.liftHold(id)

      expect(lifted.status).toBe('lifted')
      expect(lifted.status === 'lifted' && lifted.launches).toHaveLength(1)
      expect(store.attempts.list()).toHaveLength(1)
      expect(store.snapshot().effects).toHaveLength(1)
      expect(launchAuthority(store, launchPayload(store), NOW, POLICY_HASH)).toEqual({ verdict: 'run' })
      expect(eventTypes(store, id)).toContain('hold_lifted')

      expect(service.liftHold(id)).toEqual({ status: 'free' })
      expect(store.attempts.list()).toHaveLength(1)
      expect(store.snapshot().effects).toHaveLength(1)
    })

    it('lift does not relaunch a task that already has an attempt', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      service.holdWork(id, 'wait')

      expect(service.liftHold(id)).toEqual({ status: 'lifted', launches: [] })
      expect(store.attempts.list()).toHaveLength(1)
    })

    it('lift on a free item returns free and writes nothing', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      const before = JSON.stringify(store.snapshot())

      expect(service.liftHold(id)).toEqual({ status: 'free' })
      expect(JSON.stringify(store.snapshot())).toBe(before)
    })

    it('lift on withdrawn work refuses and keeps the hold', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      service.holdWork(id, 'wait')
      service.stopWork(id)

      expect(service.liftHold(id)).toEqual({ status: 'refused', error: 'mandate_withdrawn' })
      expect(isHeld(store.workItems.get(id)!)).toBe(true)
    })

    it('lift refuses a changed policy and keeps the hold', async () => {
      const { service, store } = rig(fakeBrain({ ack: 'Thinking' }))
      const id = await start(service)
      service.holdWork(id, 'wait')
      const work = store.workItems.get(id)!
      store.atomic(() => {
        store.workItems.save({ ...work, mandate: { ...(work.mandate as object), policyHash: 'older' } })
      })

      expect(service.liftHold(id)).toEqual({ status: 'refused', error: 'mandate_policy_changed' })
      expect(isHeld(store.workItems.get(id)!)).toBe(true)
    })

    it('timer wake cannot lift a hold', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      service.holdWork(id, 'wait')
      const { service: awake } = rig(
        fakeBrain({ ack: 'ok', routes: [{ messageId: 'msg_wake', decision: 'release', target: id }] }),
        store,
      )

      await awake.onWake({ reason: 'timer', workItemId: id })

      expect(isHeld(store.workItems.get(id)!)).toBe(true)
    })

    it('a chat message cannot lift a hold', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      service.holdWork(id, 'wait')

      await service.onUserMessage({
        messageId: 'msg_2',
        text: 'go',
        repoId: 'repo_a',
        referencesWorkItem: id,
      })
      await service.onUserMessage({ messageId: 'msg_3', text: 'go ahead', repoId: 'repo_a' })

      expect(isHeld(store.workItems.get(id)!)).toBe(true)
    })

    it('planner release is refused by the route tool', async () => {
      let tools: PlannerTools | undefined
      const { service } = rig(async (context) => {
        tools = context.tools
        return { ack: 'Thinking' }
      })
      const id = await start(service)

      const answer = tools!.execute('route', { message_id: 'msg_1', decision: 'release', target: id }) as {
        ok: boolean
        issues: string[]
      }

      expect(answer.ok).toBe(false)
      expect(answer.issues.join(' ')).toContain('release')
      expect(tools!.journal().routes).toEqual([])
    })

    it('a planner release carried on a decision lifts nothing on a user turn', async () => {
      const { brain, answer } = heldBrain()
      const { service, store } = rig(brain)
      const { turn, id } = startHeld(service, store)
      service.holdWork(id, 'wait')
      answer({ ...plan(['a', []]), routes: [{ messageId: 'msg_1', decision: 'release', target: id }] })
      await turn

      expect(isHeld(store.workItems.get(id)!)).toBe(true)
      expect(store.snapshot().effects).toEqual([])
    })

    it('a planner hold on a user turn holds and names its message', async () => {
      const { brain, answer } = heldBrain()
      const { service, store } = rig(brain)
      const { turn, id } = startHeld(service, store)
      answer({
        ...plan(['a', []]),
        routes: [{ messageId: 'msg_1', decision: 'hold', target: id, note: 'wait' }],
      })
      const outcome = await turn

      expect(store.workItems.get(id)?.hold).toMatchObject({ reason: 'wait', sourceMessageId: 'msg_1' })
      expect(outcome.launchesEnqueued).toEqual([])
      expect(store.snapshot().effects).toEqual([])
    })

    it('legacy read-only work takes a stop but neither hold nor lift', () => {
      const store = new MemoryRepositories()
      const legacy = { id: 'wi_old', state: 'executing', mandate: { originMessageId: 'msg_0' } }
      store.atomic(() => store.workItems.save(legacy))
      const { service } = rig(fakeBrain({ ack: 'ok' }), store)

      expect(service.holdWork('wi_old', 'wait')).toBe('read_only')

      store.atomic(() => store.workItems.save({ ...legacy, hold: { reason: 'old', at: NOW } }))
      expect(service.liftHold('wi_old')).toEqual({ status: 'refused', error: 'read_only' })

      expect(service.stopWork('wi_old')).toBe('stopped')
      expect(mandateOf(store.workItems.get('wi_old')!).status).toBe('withdrawn')
    })

    it('hold refuses terminal work and unknown ids', async () => {
      const { service } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      service.stopWork(id)

      expect(service.holdWork(id, 'wait')).toBe('terminal')
      expect(service.holdWork('wi_none', 'wait')).toBe('missing')
    })
  })

  describe('stop', () => {
    it('a stop asks the runner to end an attempt still in its checks', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      const attempt = store.attempts.list({ workItemId: id })[0]!
      store.attempts.save({ ...attempt, state: 'work_complete' })
      service.stopWork(id)
      expect(store.attempts.get(String(attempt.id))?.state).toBe('work_complete')
      expect(store.events.read(`attempt:${String(attempt.id)}`).map((event) => event.type)).toContain(
        'attempt.interrupt_requested',
      )
    })

    it('stop withdraws the mandate and interrupts queued attempts', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      const attempt = store.attempts.list()[0]!
      store.atomic(() => {
        store.attempts.save({ ...attempt, id: 'att_running', state: 'running' })
      })

      expect(service.stopWork(id)).toBe('stopped')

      const work = store.workItems.get(id)!
      expect(work.state).toBe('stopped')
      expect((work.mandate as { status: string }).status).toBe('withdrawn')
      const stopped = store.events.read(`work:${id}`).find((event) => event.type === 'work_stopped')
      expect((stopped!.body as { mandate: string[] }).mandate[0]).toContain('withdrawn')
      expect(store.attempts.get(String(attempt.id))?.state).toBe('interrupted')
      expect(store.attempts.get('att_running')?.state).toBe('running')
      expect(store.events.read('attempt:att_running').map((event) => event.type)).toContain(
        'attempt.interrupt_requested',
      )
    })

    it('the planner stop_agent leaves a running attempt to the runner', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      const queued = store.attempts.list()[0]!
      store.atomic(() => {
        store.attempts.save({ ...queued, id: 'att_running', state: 'running' })
        // Finished work leaves the next message to plan, which is the turn that carries extras.
        store.workItems.save({ ...store.workItems.get(id), id, state: 'done' })
      })
      const stopping = fakeBrain({
        ack: 'Stopping',
        plan: plan(['b', []]).plan,
        stops: [{ attemptId: 'att_running' }, { attemptId: String(queued.id) }],
      })
      await rig(stopping, store).service.onUserMessage({
        messageId: 'msg_2',
        text: 'one more thing',
        repoId: 'repo_a',
      })

      expect(store.attempts.get('att_running')?.state).toBe('running')
      expect(store.events.read('attempt:att_running').map((event) => event.type)).toContain(
        'attempt.interrupt_requested',
      )
      expect(store.attempts.get(String(queued.id))?.state).toBe('interrupted')
    })

    it('a second stop changes nothing', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      service.stopWork(id)
      const before = JSON.stringify(store.snapshot())

      expect(service.stopWork(id)).toBe('stopped')
      expect(JSON.stringify(store.snapshot())).toBe(before)
    })

    it('stop refuses done work and leaves it done', async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      const work = store.workItems.get(id)!
      store.atomic(() => store.workItems.save({ ...work, state: 'done' }))

      expect(service.stopWork(id)).toBe('done')
      expect(store.workItems.get(id)?.state).toBe('done')
    })

    it('stop on an unknown id is missing', () => {
      const { service } = rig(fakeBrain({ ack: 'ok' }))
      expect(service.stopWork('wi_none')).toBe('missing')
    })
  })

  describe('launchAuthority', () => {
    const planned = async () => {
      const { service, store } = rig(fakeBrain(plan(['a', []])))
      const id = await start(service)
      return { service, store, id, payload: launchPayload(store) }
    }

    it('runs a queued launch on live work', async () => {
      const { store, payload } = await planned()
      expect(launchAuthority(store, payload, NOW, POLICY_HASH)).toEqual({ verdict: 'run' })
    })

    it('drops a launch for missing work', async () => {
      const { store, payload } = await planned()
      expect(launchAuthority(store, { ...payload, work_item_id: 'wi_none' }, NOW, POLICY_HASH)).toEqual({
        verdict: 'drop',
        reason: 'work_missing',
      })
    })

    it('drops a launch on stopped work', async () => {
      const { service, store, id, payload } = await planned()
      service.stopWork(id)
      expect(launchAuthority(store, payload, NOW, POLICY_HASH)).toEqual({
        verdict: 'drop',
        reason: 'work_terminal',
      })
    })

    it('drops a launch whose mandate was withdrawn while the state is live', async () => {
      const { store, id, payload } = await planned()
      const work = store.workItems.get(id)!
      store.atomic(() => {
        store.workItems.save({ ...work, mandate: { ...(work.mandate as object), status: 'withdrawn' } })
      })
      expect(launchAuthority(store, payload, NOW, POLICY_HASH)).toEqual({
        verdict: 'drop',
        reason: 'mandate_withdrawn',
      })
    })

    it('launchAuthority drops a replayed launch whose attempt already ran', async () => {
      const { store, payload } = await planned()
      const attempt = store.attempts.get(payload.attempt_id)!
      store.atomic(() => store.attempts.save({ ...attempt, state: 'succeeded' }))
      expect(launchAuthority(store, payload, NOW, POLICY_HASH)).toEqual({
        verdict: 'drop',
        reason: 'attempt_not_queued',
      })
    })

    it('launchAuthority drops a launch on an expired mandate', async () => {
      const { store, id, payload } = await planned()
      const work = store.workItems.get(id)!
      store.atomic(() => {
        store.workItems.save({
          ...work,
          mandate: { ...(work.mandate as object), expiresAt: '2026-11-05T11:00:00.000Z' },
        })
      })
      expect(launchAuthority(store, payload, NOW, POLICY_HASH)).toEqual({
        verdict: 'drop',
        reason: 'mandate_expired',
      })
    })

    it('a launch row that drains on an expired mandate settles its attempt', async () => {
      const { store, id, payload } = await planned()
      const work = store.workItems.get(id)!
      store.atomic(() => {
        store.workItems.save({
          ...work,
          mandate: { ...(work.mandate as object), expiresAt: '2026-11-05T11:00:00.000Z' },
        })
        refuseLaunch(store, payload, 'mandate_expired', NOW)
      })
      expect(store.attempts.get(payload.attempt_id)).toMatchObject({
        state: 'failed',
        terminal_reason: 'mandate_expired',
      })
      expect(store.workItems.get(id)).toMatchObject({ state: 'blocked', blockedReason: 'mandate_expired' })
    })

    it.each(['mandate_withdrawn', 'repo_mismatch'] as const)(
      'a row drained on %s settles too',
      async (why) => {
        const { store, id, payload } = await planned()
        store.atomic(() => refuseLaunch(store, payload, why, NOW))
        expect(store.attempts.get(payload.attempt_id)).toMatchObject({
          state: 'failed',
          terminal_reason: why,
        })
        expect(store.workItems.get(id)).toMatchObject({ state: 'blocked', blockedReason: why })
      },
    )

    it('a policy change fails the attempt that never started: the work blocks with the reason', async () => {
      const { store, id, payload } = await planned()
      store.atomic(() => refuseLaunch(store, payload, 'policy_changed', NOW))
      expect(store.attempts.get(payload.attempt_id)).toMatchObject({
        state: 'failed',
        terminal_reason: 'policy_changed',
      })
      expect(store.workItems.get(id)).toMatchObject({ state: 'blocked', blockedReason: 'policy_changed' })
    })

    it('a policy change cancels no running work (§13)', async () => {
      const { store, id, payload } = await planned()
      const live = { taskId: payload.task_id, workItemId: id, slotId: 'slot_a', generation: 1 }
      store.atomic(() => {
        store.attempts.save({ ...live, id: 'att_running', state: 'running' })
        store.attempts.save({ ...live, id: 'att_checks', state: 'work_complete' })
      })
      expect(launchAuthority(store, payload, NOW, 'another-hash')).toEqual({
        verdict: 'drop',
        reason: 'policy_changed',
      })
      store.atomic(() => refuseLaunch(store, payload, 'policy_changed', NOW))
      expect(store.attempts.get('att_running')?.state).toBe('running')
      expect(store.attempts.get('att_checks')?.state).toBe('work_complete')
      expect(store.events.read('attempt:att_running')).toEqual([])
      expect(store.events.read('attempt:att_checks')).toEqual([])
    })

    it.each(['mandate_expired', 'mandate_withdrawn', 'policy_changed', 'repo_mismatch'] as const)(
      'a queued attempt whose group is not proven gone keeps its capacity on %s (§8.1)',
      async (why) => {
        const { store, payload } = await planned()
        const attempt = store.attempts.get(payload.attempt_id)!
        store.atomic(() => {
          store.attempts.save({ ...attempt, reconcile_refused: 'unprovable' })
          refuseLaunch(store, payload, why, NOW)
        })
        expect(store.attempts.get(payload.attempt_id)).toMatchObject({
          state: 'queued',
          reconcile_refused: 'unprovable',
        })
        const types = store.events.read(`attempt:${payload.attempt_id}`).map((event) => event.type)
        expect(types).not.toContain('attempt.failed')
      },
    )

    it('a policy change still blocks the work of an attempt that keeps its capacity', async () => {
      const { store, id, payload } = await planned()
      const attempt = store.attempts.get(payload.attempt_id)!
      store.atomic(() => {
        store.attempts.save({ ...attempt, reconcile_refused: 'unprovable' })
        refuseLaunch(store, payload, 'policy_changed', NOW)
      })
      expect(store.workItems.get(id)).toMatchObject({ state: 'blocked', blockedReason: 'policy_changed' })
    })

    it('a stale row for an attempt queued again leaves that attempt alone', async () => {
      const { store, id, payload } = await planned()
      store.atomic(() => refuseLaunch(store, payload, 'attempt_not_queued', NOW))
      expect(store.attempts.get(payload.attempt_id)?.state).toBe('queued')
      expect(store.workItems.get(id)?.state).toBe('executing')
    })

    it('a refused resume blocks nothing and leaves a parked attempt as it was', async () => {
      const { store, id, payload } = await planned()
      const attempt = store.attempts.get(payload.attempt_id)!
      store.atomic(() => {
        store.attempts.save({ ...attempt, state: 'quota_wait' })
        refuseLaunch(store, payload, 'mandate_expired', NOW)
      })
      expect(store.attempts.get(payload.attempt_id)?.state).toBe('quota_wait')
      expect(store.workItems.get(id)?.state).toBe('executing')
    })

    it('launchAuthority drops a launch whose repo differs from the pin', async () => {
      const { store, id, payload } = await planned()
      const work = store.workItems.get(id)!
      store.atomic(() => store.workItems.save({ ...work, repoId: 'repo_b' }))
      expect(launchAuthority(store, payload, NOW, POLICY_HASH)).toEqual({
        verdict: 'drop',
        reason: 'repo_mismatch',
      })
    })

    it('drops a launch whose policy changed', async () => {
      const { store, payload } = await planned()
      expect(launchAuthority(store, payload, NOW, 'another-hash')).toEqual({
        verdict: 'drop',
        reason: 'policy_changed',
      })
    })

    it('a legacy mandate skips the policy comparison', async () => {
      const { store, id, payload } = await planned()
      const work = store.workItems.get(id)!
      store.atomic(() => store.workItems.save({ ...work, mandate: { originMessageId: 'msg_1' } }))
      expect(launchAuthority(store, payload, NOW, 'another-hash')).toEqual({ verdict: 'run' })
    })

    it('a withdrawn mandate outranks a hold', async () => {
      const { service, store, id, payload } = await planned()
      service.holdWork(id, 'wait')
      service.stopWork(id)
      expect(launchAuthority(store, payload, NOW, POLICY_HASH)).toMatchObject({ verdict: 'drop' })
    })
  })
})
