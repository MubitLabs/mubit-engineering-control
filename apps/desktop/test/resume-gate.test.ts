// §10 "before every resume": what stops a parked or interrupted attempt starting again.
import type { StoreDoc } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
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
})
