import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MetaBrain, MetaDecision } from '../src'
import { fakeBrain, MetaAgentService, RepoAdmissionError } from '../src'

/**
 * Repo and canonical identity (M1.2, spec §10, §12.1, decisions #10 and #19): the planner's
 * task ids are local keys, the store's ids are canonical, and nothing crosses a repository.
 */

const NOW = () => '2026-11-05T12:00:00.000Z'

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

const seedRepo = (store: MemoryRepositories, id: string, trust = true): void => {
  store.atomic(() => {
    store.engines.save({ id, url: `https://example.test/${id}`, bootstrap: [], checks: [], trust })
  })
}

const rig = (brain: MetaBrain, store = new MemoryRepositories()) => {
  seedRepo(store, 'repo_a')
  seedRepo(store, 'repo_b')
  const service = new MetaAgentService({
    store,
    effects: store.effects,
    brain,
    now: NOW,
    policyText: '{"preAuthorised":{}}',
  })
  return { service, store }
}

/** A brain answering each turn in order; the last answer repeats. */
const scripted = (...decisions: MetaDecision[]): MetaBrain => {
  let turn = 0
  return async () => decisions[Math.min(turn++, decisions.length - 1)]!
}

const taskByKey = (store: MemoryRepositories, workItemId: string, key: string) =>
  store.tasks.list({ workItemId, localKey: key })[0]

describe('repo admission and canonical identity', () => {
  beforeEach(() => {
    process.env.MEC_FAKE_ENGINE = '1'
  })
  afterEach(() => {
    delete process.env.MEC_FAKE_ENGINE
  })

  it('two repos reuse task_1 without overwrite', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const a = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const b = await service.onUserMessage({ messageId: 'msg_b', text: 'b', repoId: 'repo_b' })

    expect(store.tasks.list()).toHaveLength(2)
    const inA = taskByKey(store, a.workItemId!, 'task_1')!
    const inB = taskByKey(store, b.workItemId!, 'task_1')!
    expect(inA.id).not.toBe(inB.id)
    expect(inA.id).toMatch(/^task_[A-Za-z0-9_-]+$/)
    expect(inA.id).not.toBe('task_1')
    expect(inA).toMatchObject({ repoId: 'repo_a', planRevision: 1 })
    expect(inB).toMatchObject({ repoId: 'repo_b', planRevision: 1 })
    expect(store.snapshot().effects.map((row) => (row.payload as { task_id: string }).task_id)).toEqual([
      inA.id,
      inB.id,
    ])
  })

  it('work, message and plan snapshot carry the repo', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })

    expect(store.workItems.get(workItemId!)).toMatchObject({ repoId: 'repo_a', planRevision: 1 })
    expect(store.messages.get('msg_a')).toMatchObject({ repoId: 'repo_a' })
    const snapshot = store.engines.get(`plan/${workItemId}/1`)!
    expect(snapshot).toMatchObject({ workItemId, repoId: 'repo_a', revision: 1, messageId: 'msg_a' })
    expect(snapshot.tasks).toEqual([
      expect.objectContaining({
        taskId: taskByKey(store, workItemId!, 'task_1')!.id,
        localKey: 'task_1',
      }),
    ])
  })

  it('dependsOn rewrites to canonical ids atomically', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []], ['task_2', ['task_1']])))
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const first = taskByKey(store, workItemId!, 'task_1')!
    expect(taskByKey(store, workItemId!, 'task_2')?.dependsOn).toEqual([first.id])

    // A failure part-way through the plan leaves no task, no snapshot and no launch behind.
    const save = store.tasks.save.bind(store.tasks)
    let saves = 0
    store.tasks.save = (doc) => {
      saves += 1
      if (saves === 2) throw new Error('disk full')
      save(doc)
    }
    await expect(
      service.onUserMessage({ messageId: 'msg_a2', text: 'again', repoId: 'repo_b' }),
    ).rejects.toThrow('disk full')
    store.tasks.save = save
    expect(store.tasks.list()).toHaveLength(2)
    expect(store.snapshot().effects).toHaveLength(1)
    const planned = store.workItems.list({ repoId: 'repo_b' })
    expect(planned.map((doc) => doc.state)).toEqual(['planning'])
    expect(store.engines.get(`plan/${String(planned[0]?.id)}/1`)).toBeUndefined()
  })

  it('cross-plan dependency refused', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const a = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const foreign = String(taskByKey(store, a.workItemId!, 'task_1')!.id)
    const { service: next } = rig(fakeBrain(plan(['task_2', [foreign]])), store)
    const b = await next.onUserMessage({ messageId: 'msg_b', text: 'b', repoId: 'repo_b' })

    expect(b.tasksCreated).toBe(0)
    expect(b.launchesEnqueued).toEqual([])
    expect(b.acknowledged).toContain(foreign)
    expect(store.tasks.list({ repoId: 'repo_b' })).toHaveLength(0)
    expect(store.events.read(`work:${b.workItemId!}`).map((event) => event.type)).toContain('plan_rejected')
  })

  it('a key reused by a replan is the same task: canonical id, status and attempts stay (#19)', async () => {
    const { service, store } = rig(
      scripted(plan(['task_1', []], ['task_2', ['task_1']]), {
        ack: 'Replanned',
        plan: {
          tasks: [
            { taskId: 'task_1', objective: 'Do task_1 better', dependsOn: [], role: 'implementer' },
            { taskId: 'task_3', objective: 'New', dependsOn: ['task_1'], role: 'implementer' },
          ],
        },
      }),
    )
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const before = taskByKey(store, workItemId!, 'task_1')!
    store.atomic(() => {
      store.tasks.save({ ...before, status: 'integrated' })
    })

    const replan = await service.onWake({ reason: 'report', workItemId: workItemId! })

    const after = taskByKey(store, workItemId!, 'task_1')!
    expect(after.id).toBe(before.id)
    expect(after).toMatchObject({
      status: 'integrated',
      objective: 'Do task_1 better',
      createdAt: before.createdAt,
      planRevision: 2,
    })
    // task_1 already ran: only the new task launches, on its satisfied canonical dependency.
    const added = taskByKey(store, workItemId!, 'task_3')!
    expect(added.dependsOn).toEqual([before.id])
    expect(replan.launchesEnqueued).toHaveLength(1)
    expect(store.attempts.list({ taskId: added.id })).toHaveLength(1)
    expect(store.attempts.list({ taskId: before.id })).toHaveLength(1)
    // The first revision's snapshot is untouched; the second sits beside it.
    expect(store.engines.get(`plan/${workItemId}/1`)?.revision).toBe(1)
    expect(store.engines.get(`plan/${workItemId}/2`)?.revision).toBe(2)
    expect(store.workItems.get(workItemId!)?.planRevision).toBe(2)
  })

  it('a replan never launches a reused key again, and never resets its status', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const task = taskByKey(store, workItemId!, 'task_1')!
    store.atomic(() => {
      store.tasks.save({ ...task, status: 'active' })
    })

    const replan = await service.onWake({ reason: 'report', workItemId: workItemId! })

    expect(replan.launchesEnqueued).toEqual([])
    expect(store.attempts.list()).toHaveLength(1)
    expect(taskByKey(store, workItemId!, 'task_1')?.status).toBe('active')
  })

  it('a replan does not launch a ready key that already has an attempt', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const replan = await service.onWake({ reason: 'report', workItemId: workItemId! })
    expect(replan.launchesEnqueued).toEqual([])
    expect(store.attempts.list()).toHaveLength(1)
  })

  it('spawn gets a task_ id and inherits repo', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    let spawned: unknown
    const spawner: MetaBrain = async ({ tools }) => {
      spawned = tools?.execute('spawn_agent', {
        task: 'Look into it',
        role: 'implementer',
        work_item: workItemId,
        model_request: { model: 'm', reason: 'cheap' },
      })
      return { ack: 'Spawned', plan: plan(['task_1', []]).plan, spawns: tools?.journal().spawns }
    }
    const { service: next } = rig(spawner, store)
    await next.onWake({ reason: 'report', workItemId: workItemId! })

    const id = (spawned as { task: string }).task
    expect(id).toMatch(/^task_[A-Za-z0-9_-]+$/)
    expect(store.tasks.get(id)).toMatchObject({ workItemId, repoId: 'repo_a' })
  })

  it('wake never creates repo-less work', async () => {
    let turns = 0
    const { service, store } = rig(async () => {
      turns += 1
      return plan(['task_1', []])
    })

    const outcome = await service.onWake({ reason: 'timer' })
    const dangling = await service.onWake({ reason: 'timer', workItemId: 'wi_gone' })

    expect(outcome.workItemId).toBeUndefined()
    expect(dangling.workItemId).toBeUndefined()
    expect(turns).toBe(0)
    expect(store.workItems.list()).toHaveLength(0)
    expect(store.tasks.list()).toHaveLength(0)
    expect(store.snapshot().effects).toHaveLength(0)
    expect(store.events.read('wakes').map((event) => event.type)).toEqual(['wake_unbound', 'wake_unbound'])
  })

  it('a wake inherits the repo of its work item', async () => {
    const { service, store } = rig(scripted(plan(['task_1', []]), { ack: 'Heard' }))
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    await service.onWake({ reason: 'report', workItemId: workItemId! })
    const wake = store.messages.list().find((doc) => String(doc.id).startsWith('msg_wake_'))
    expect(wake).toMatchObject({ repoId: 'repo_a', workItemId })
  })

  it('repo pin is immutable after registry edit', async () => {
    const { service, store } = rig(scripted(plan(['task_1', []]), plan(['task_1', []], ['task_2', []])))
    const { workItemId } = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const pin = store.workItems.get(workItemId!)?.pin
    expect(pin).toMatchObject({
      repoId: 'repo_a',
      url: 'https://example.test/repo_a',
      profileHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      policyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      promptRevision: 'unresolved',
    })

    store.atomic(() => {
      store.engines.save({
        id: 'repo_a',
        url: 'https://example.test/moved',
        bootstrap: ['npm ci'],
        checks: [],
        trust: false,
      })
    })
    await service.onWake({ reason: 'report', workItemId: workItemId! })

    expect(store.workItems.get(workItemId!)?.pin).toEqual(pin)
  })

  it('the profile hash follows the repo profile, not its identity', async () => {
    const { service, store } = rig(fakeBrain({ ack: 'Thinking' }))
    seedRepo(store, 'repo_c', false)
    const hash = async (messageId: string, repoId: string) => {
      const { workItemId } = await service.onUserMessage({ messageId, text: 'x', repoId })
      return (store.workItems.get(workItemId!)?.pin as { profileHash: string }).profileHash
    }
    const a = await hash('msg_a', 'repo_a')
    const b = await hash('msg_b', 'repo_b')
    const c = await hash('msg_c', 'repo_c')
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })

  it('an unknown repo is refused before any write', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    await expect(
      service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_nope' }),
    ).rejects.toBeInstanceOf(RepoAdmissionError)
    // A non-repo doc in the same collection is not a repo.
    store.atomic(() => {
      store.engines.save({ id: 'settings/meta-slot', slotId: 'slot_1' })
    })
    await expect(
      service.onUserMessage({ messageId: 'msg_b', text: 'a', repoId: 'settings/meta-slot' }),
    ).rejects.toMatchObject({ code: 'unknown_repo' })
    expect(store.workItems.list()).toHaveLength(0)
    expect(store.messages.list()).toHaveLength(0)
  })

  it('a reference into another repo is refused, never routed as new work', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const a = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })

    await expect(
      service.onUserMessage({
        messageId: 'msg_b',
        text: 'b',
        repoId: 'repo_b',
        referencesWorkItem: a.workItemId!,
      }),
    ).rejects.toMatchObject({ code: 'repo_mismatch' })
    await expect(
      service.onUserMessage({ messageId: 'msg_c', text: 'c', referencesWorkItem: a.workItemId! }),
    ).rejects.toMatchObject({ code: 'repo_mismatch' })
    expect(store.workItems.list()).toHaveLength(1)
    expect(store.messages.list()).toHaveLength(1)
  })

  it('a resent message id under another repo is refused', async () => {
    const { service } = rig(fakeBrain(plan(['task_1', []])))
    await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    await expect(
      service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_b' }),
    ).rejects.toMatchObject({ code: 'repo_mismatch' })
  })

  it("one repo's live work does not route another's request, and each sees only its own", async () => {
    const seen: { work: string[]; conversation: string[]; live: string[] }[] = []
    const { service, store } = rig(async (context) => {
      seen.push({
        work: context.snapshot?.work.map((item) => item.id) ?? [],
        conversation: context.snapshot?.conversation.map((entry) => entry.id) ?? [],
        live: context.liveWork.map((item) => item.workItemId),
      })
      return plan(['task_1', []])
    })
    const a = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const b = await service.onUserMessage({ messageId: 'msg_b', text: 'b', repoId: 'repo_b' })
    const note = await service.onUserMessage({ messageId: 'msg_a2', text: 'fyi', repoId: 'repo_a' })

    expect(store.messages.get('msg_b')?.routing).toBe('new_work')
    expect(b.tasksCreated).toBe(1)
    expect(seen[1]).toEqual({
      work: [b.workItemId],
      conversation: ['msg_b'],
      live: [b.workItemId],
    })
    expect(store.messages.get('msg_a2')).toMatchObject({ routing: 'conversation', repoId: 'repo_a' })
    expect(note.acknowledged).toContain(a.workItemId)
    expect(note.acknowledged).not.toContain(b.workItemId)
  })

  it('the planner tools cannot reach across repos', async () => {
    const results: Record<string, { ok: boolean }> = {}
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const a = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const foreignTask = String(store.tasks.list({ workItemId: a.workItemId! })[0]?.id)
    const foreignAttempt = String(store.attempts.list()[0]?.id)
    const reaching: MetaBrain = async ({ tools }) => {
      const run = (name: string, tool: Parameters<NonNullable<typeof tools>['execute']>[0], args: object) => {
        results[name] = tools?.execute(tool, args) as { ok: boolean }
      }
      run('stop', 'route', { message_id: 'msg_b', decision: 'stop', target: a.workItemId })
      run('hold', 'route', { message_id: 'msg_b', decision: 'hold', target: a.workItemId })
      run('attach', 'route', { message_id: 'msg_b', decision: 'attach', target: a.workItemId })
      run('cancel', 'cancel_task', { task: foreignTask })
      run('stopAgent', 'stop_agent', { agent: foreignAttempt })
      run('report', 'report_result', { work_item: a.workItemId, summary: 'done' })
      run('read', 'read', { resource: `work_item/${a.workItemId}` })
      run('spawn', 'spawn_agent', {
        task: 'x',
        role: 'implementer',
        work_item: a.workItemId,
        model_request: { model: 'm', reason: 'cheap' },
      })
      return { ack: 'Nothing' }
    }
    const { service: next } = rig(reaching, store)
    await next.onUserMessage({ messageId: 'msg_b', text: 'b', repoId: 'repo_b' })

    expect(Object.keys(results)).toHaveLength(8)
    for (const [name, result] of Object.entries(results)) expect([name, result.ok]).toEqual([name, false])
  })

  it('a scripted decision that reaches across repos is dropped by the service', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const a = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    const foreignTask = String(store.tasks.list({ workItemId: a.workItemId! })[0]?.id)
    const foreignAttempt = String(store.attempts.list()[0]?.id)
    const { service: next } = rig(
      fakeBrain({
        ack: 'Reaching',
        routes: [{ messageId: 'msg_b', decision: 'stop', target: a.workItemId! }],
        cancels: [{ taskId: foreignTask }],
        stops: [{ attemptId: foreignAttempt }],
        reports: [{ workItemId: a.workItemId!, summary: 'x', artifacts: [] }],
        spawns: [{ taskId: 'task_foreign', objective: 'x', role: 'implementer', workItemId: a.workItemId! }],
        plan: plan(['task_1', []]).plan,
      }),
      store,
    )
    const b = await next.onUserMessage({ messageId: 'msg_b', text: 'b', repoId: 'repo_b' })

    expect(b.tasksCreated).toBe(1)
    expect(store.workItems.get(a.workItemId!)?.state).toBe('executing')
    expect(store.tasks.get(foreignTask)?.status).toBe('ready')
    expect(store.tasks.get('task_foreign')).toBeUndefined()
    expect(store.attempts.get(foreignAttempt)?.state).toBe('queued')
    expect(store.events.read(`work:${a.workItemId!}`).map((event) => event.type)).not.toContain(
      'result_reported',
    )
    expect(store.events.read(`work:${b.workItemId!}`).map((event) => event.type)).toContain(
      'cross_repo_refused',
    )
  })
})

describe('Unassigned work', () => {
  beforeEach(() => {
    process.env.MEC_FAKE_ENGINE = '1'
  })
  afterEach(() => {
    delete process.env.MEC_FAKE_ENGINE
  })

  it('absent repoId: planned as Unassigned, never launched', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    const outcome = await service.onUserMessage({ messageId: 'msg_a', text: 'a' })

    expect(outcome.tasksCreated).toBe(1)
    expect(outcome.launchesEnqueued).toEqual([])
    expect(store.attempts.list()).toHaveLength(0)
    expect(store.snapshot().effects).toHaveLength(0)
    const work = store.workItems.get(outcome.workItemId!)!
    expect(work.repoId).toBeUndefined()
    expect(work.pin).toBeUndefined()
    expect(store.events.read(`work:${outcome.workItemId!}`).map((event) => event.type)).toContain(
      'launch_withheld',
    )
  })

  it('a legacy row stays read-only: a wake runs no planner and writes nothing to it', async () => {
    const store = new MemoryRepositories()
    let turns = 0
    const { service } = rig(async () => {
      turns += 1
      return plan(['task_1', []])
    }, store)
    store.atomic(() => {
      store.workItems.save({ id: 'wi_old', state: 'executing', updatedAt: 'then' })
      store.tasks.save({ id: 'task_1', workItemId: 'wi_old', status: 'ready' })
    })

    const outcome = await service.onWake({ reason: 'report', workItemId: 'wi_old' })

    expect(turns).toBe(0)
    expect(outcome.tasksCreated).toBe(0)
    expect(outcome.acknowledged).toContain('read-only')
    expect(store.workItems.get('wi_old')).toEqual({ id: 'wi_old', state: 'executing', updatedAt: 'then' })
    expect(store.tasks.list()).toEqual([{ id: 'task_1', workItemId: 'wi_old', status: 'ready' }])
    expect(store.snapshot().effects).toHaveLength(0)
  })

  it('an Unassigned turn cannot change a legacy row', async () => {
    const store = new MemoryRepositories()
    const results: { ok: boolean }[] = []
    const { service } = rig(async ({ tools }) => {
      results.push(tools?.execute('cancel_task', { task: 'task_old' }) as { ok: boolean })
      results.push(
        tools?.execute('route', { message_id: 'msg_a', decision: 'hold', target: 'wi_old' }) as {
          ok: boolean
        },
      )
      return { ack: 'Nothing', cancels: [{ taskId: 'task_old' }] }
    }, store)
    store.atomic(() => {
      store.workItems.save({ id: 'wi_old', state: 'stopped' })
      store.tasks.save({ id: 'task_old', workItemId: 'wi_old', status: 'ready' })
    })

    await service.onUserMessage({ messageId: 'msg_a', text: 'a' })

    expect(results.map((result) => result.ok)).toEqual([false, false])
    expect(store.tasks.get('task_old')?.status).toBe('ready')
  })

  it('legacy live work does not block a repo', async () => {
    const { service, store } = rig(fakeBrain(plan(['task_1', []])))
    store.atomic(() => {
      store.workItems.save({ id: 'wi_old', state: 'executing' })
    })
    const outcome = await service.onUserMessage({ messageId: 'msg_a', text: 'a', repoId: 'repo_a' })
    expect(store.messages.get('msg_a')?.routing).toBe('new_work')
    expect(outcome.launchesEnqueued).toHaveLength(1)
  })
})
