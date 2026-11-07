// §10 "before every resume": what stops a parked or interrupted attempt starting again.
import type { StoreDoc } from '@mec/contracts'
import { Later } from '@mec/store'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import { launchHandler } from '../src/composition'
import { resumeAuthority } from '../src/recovery'

const AT = '2026-11-06T12:00:00.000Z'
const POLICY = 'policy-hash'

function seeded(work: StoreDoc, repo: StoreDoc = { hostRunAgreedAt: AT }): MemoryRepositories {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({ id: 'repo_a', url: 'https://example.test/a', ...repo })
    store.workItems.save({
      id: 'wi_1',
      repoId: 'repo_a',
      state: 'executing',
      mandate: { originMessageId: 'msg_1', status: 'active' },
      ...work,
    })
    store.attempts.save({
      id: 'att_1',
      workItemId: 'wi_1',
      generation: 1,
      state: 'interrupted',
      resuming: true,
    })
  })
  return store
}

const verdict = (store: MemoryRepositories) =>
  resumeAuthority(store, { attempt_id: 'att_1', work_item_id: 'wi_1', generation: 1 } as never, AT, POLICY)

describe('a resume (§10, §12.5)', () => {
  it('on stopped work is dropped', () => {
    expect(verdict(seeded({ state: 'stopped' }))).toEqual({ verdict: 'drop', reason: 'work_terminal' })
  })

  it('on held work waits for the lift', () => {
    const held = seeded({ hold: { at: AT, reason: 'wait' } })
    expect(verdict(held)).toMatchObject({ verdict: 'defer', reason: 'held' })
  })

  it('on a repository the owner has not agreed to waits for the owner', () => {
    expect(verdict(seeded({}, {}))).toMatchObject({ verdict: 'defer', reason: 'host_run_unagreed' })
  })

  it('with its slot full waits, and leaves the attempt as it was', () => {
    const store = seeded({})
    store.atomic(() => {
      store.slots.save({ id: 'slot_a', concurrency: 1 })
      store.attempts.save({ ...(store.attempts.get('att_1') as StoreDoc), slotId: 'slot_a' })
      store.attempts.save({ id: 'att_2', workItemId: 'wi_1', slotId: 'slot_a', state: 'running' })
    })
    expect(verdict(store)).toEqual({ verdict: 'defer', reason: 'capacity' })
    expect(store.attempts.get('att_1')).toMatchObject({ state: 'interrupted', resuming: true })
  })
})

describe('the launch row (§11)', () => {
  const ready = (ids: string[]): MemoryRepositories => {
    const store = seeded({ pin: { repoId: 'repo_a' } })
    store.atomic(() => {
      store.slots.save({ id: 'slot_a', concurrency: 2 })
      store.tasks.save({ id: 'task_1', workItemId: 'wi_1', repoId: 'repo_a', status: 'active' })
      for (const id of ids) {
        store.attempts.save({ id, workItemId: 'wi_1', taskId: 'task_1', slotId: 'slot_a', state: 'queued' })
      }
    })
    return store
  }
  const row = (id: string) => ({ attempt_id: id, task_id: 'task_1', work_item_id: 'wi_1', generation: 1 })

  it('a launch still setting up holds its unit, and gives it back when the job ends', async () => {
    const store = ready(['att_a', 'att_b', 'att_c'])
    const release: (() => void)[] = []
    const launcher = {
      launch: () => new Promise<void>((resolve) => release.push(resolve)),
    }
    const pastGate = new Set<string>()
    const run = launchHandler(store as never, POLICY, () => launcher as never, pastGate)
    const first = run(row('att_a') as never)
    const second = run(row('att_b') as never)
    await expect(run(row('att_c') as never)).rejects.toBeInstanceOf(Later)
    expect(pastGate).toEqual(new Set(['att_a', 'att_b']))
    for (const done of release) done()
    await Promise.all([first, second])
    expect(pastGate).toEqual(new Set())
  })
})
