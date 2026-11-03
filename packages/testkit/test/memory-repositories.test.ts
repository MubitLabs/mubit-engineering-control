import type { DomainEvent, Json } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { MemoryRepositories } from '../src/index'

const AT = '2026-11-03T00:00:00.000Z'

const event = (stream: string, seq: number, type: string, body: Json = {}): DomainEvent => ({
  stream,
  seq,
  at: AT,
  type,
  body,
})

describe('MemoryRepositories', () => {
  describe('atomic nested rollback', () => {
    it('an inner throw rolls back only the inner writes; the outer transaction continues', () => {
      const store = new MemoryRepositories()
      const result = store.atomic(() => {
        store.workItems.save({ id: 'wi_outer', title: 'outer' })
        expect(() =>
          store.atomic(() => {
            store.workItems.save({ id: 'wi_inner', title: 'inner' })
            store.tasks.save({ id: 'task_inner', kind: 'check' })
            throw new Error('inner failed')
          }),
        ).toThrow('inner failed')
        store.tasks.save({ id: 'task_after', kind: 'check' })
        return 'done'
      })
      expect(result).toBe('done')
      expect(store.commits).toBe(1)
      expect(store.workItems.get('wi_outer')).toBeDefined()
      expect(store.workItems.get('wi_inner')).toBeUndefined()
      expect(store.tasks.get('task_inner')).toBeUndefined()
      expect(store.tasks.get('task_after')).toBeDefined()
    })

    it('an outer throw rolls back both levels, including appended events', () => {
      const store = new MemoryRepositories()
      expect(() =>
        store.atomic(() => {
          store.workItems.save({ id: 'wi_a', n: 1 })
          store.atomic(() => {
            store.workItems.save({ id: 'wi_b', n: 2 })
          })
          store.events.append('att_1', event('att_1', 1, 'started'))
          throw new Error('outer failed')
        }),
      ).toThrow('outer failed')
      expect(store.workItems.list()).toEqual([])
      expect(store.events.read('att_1')).toEqual([])
      expect(store.commits).toBe(0)
    })

    it('a rolled-back inner append frees its seq numbers for the retry', () => {
      const store = new MemoryRepositories()
      store.atomic(() => {
        expect(() =>
          store.atomic(() => {
            store.events.append('att_1', event('att_1', 1, 'started'))
            throw new Error('boom')
          }),
        ).toThrow('boom')
        store.events.append('att_1', event('att_1', 1, 'started'))
        store.events.append('att_1', event('att_1', 2, 'exit'))
      })
      expect(store.events.read('att_1').map((e) => e.seq)).toEqual([1, 2])
    })

    it('afterCommit callbacks run only when the outermost transaction commits', () => {
      const store = new MemoryRepositories()
      const calls: string[] = []
      store.atomic(() => {
        store.atomic(() => {
          store.afterCommit(() => calls.push('inner'))
        })
        expect(calls).toEqual([])
        store.afterCommit(() => calls.push('outer'))
      })
      expect(calls).toEqual(['inner', 'outer'])
      expect(store.commits).toBe(1)
    })

    it('afterCommit callbacks are discarded when their transaction rolls back', () => {
      const store = new MemoryRepositories()
      const calls: string[] = []
      expect(() =>
        store.atomic(() => {
          store.afterCommit(() => calls.push('outer-never'))
          store.atomic(() => {
            store.afterCommit(() => calls.push('inner-never'))
            throw new Error('boom')
          })
        }),
      ).toThrow('boom')
      expect(calls).toEqual([])
      expect(store.commits).toBe(0)
    })

    it('afterCommit outside a transaction runs immediately', () => {
      const store = new MemoryRepositories()
      const calls: string[] = []
      store.afterCommit(() => calls.push('now'))
      expect(calls).toEqual(['now'])
    })
  })

  describe('repositories', () => {
    it('save upserts by id and list filters by shallow equality', () => {
      const store = new MemoryRepositories()
      store.attempts.save({ id: 'att_1', status: 'open' })
      store.attempts.save({ id: 'att_2', status: 'open' })
      store.attempts.save({ id: 'att_3', status: 'closed' })
      store.attempts.save({ id: 'att_1', status: 'closed' })
      expect(store.attempts.get('att_1')).toMatchObject({ id: 'att_1', status: 'closed' })
      expect(store.attempts.list()).toHaveLength(3)
      expect(store.attempts.list({ status: 'open' }).map((doc) => doc.id)).toEqual(['att_2'])
      expect(store.attempts.list({ status: 'open', engine: 'claude' })).toEqual([])
      expect(store.attempts.get('att_missing')).toBeUndefined()
    })

    it('save without a string id is refused', () => {
      const store = new MemoryRepositories()
      expect(() => store.workItems.save({ title: 'no id' })).toThrow(/string id/)
    })
  })

  describe('events', () => {
    it('enforces a gap-free strictly increasing seq per stream, starting at 1', () => {
      const store = new MemoryRepositories()
      store.events.append('att_1', event('att_1', 1, 'started'))
      store.events.append('att_1', event('att_1', 2, 'message'))
      expect(() => store.events.append('att_1', event('att_1', 4, 'message'))).toThrow(/gap/)
      expect(() => store.events.append('att_1', event('att_1', 2, 'message'))).toThrow(/repeats/)
      expect(() => store.events.append('att_1', event('att_1', 0, 'message'))).toThrow()
      store.events.append('att_1', event('att_1', 3, 'exit'))
      expect(store.events.read('att_1').map((e) => e.seq)).toEqual([1, 2, 3])
    })

    it('tracks seq per stream', () => {
      const store = new MemoryRepositories()
      store.events.append('att_1', event('att_1', 1, 'started'))
      store.events.append('att_2', event('att_2', 1, 'started'))
      store.events.append('att_2', event('att_2', 2, 'exit'))
      expect(() => store.events.append('att_1', event('att_1', 3, 'exit'))).toThrow(/gap/)
      expect(store.events.read('att_1')).toHaveLength(1)
    })

    it('read slices after a cursor and returns nothing for an unknown stream', () => {
      const store = new MemoryRepositories()
      for (const seq of [1, 2, 3]) store.events.append('att_1', event('att_1', seq, 'tick'))
      expect(store.events.read('att_1').map((e) => e.seq)).toEqual([1, 2, 3])
      expect(store.events.read('att_1', 1).map((e) => e.seq)).toEqual([2, 3])
      expect(store.events.read('att_1', 3)).toEqual([])
      expect(store.events.read('att_unknown')).toEqual([])
    })
  })

  describe('effects', () => {
    it('enqueue requires a transaction and coalesces to one row per kind + key', () => {
      const store = new MemoryRepositories()
      expect(() => store.effects.enqueue('launch', 'att_1', {})).toThrow(/atomic/)
      store.atomic(() => {
        store.effects.enqueue('launch', 'att_1', { n: 1 })
        store.effects.enqueue('launch', 'att_1', { n: 2 })
        store.effects.enqueue('deliver', 'att_1', { n: 3 })
      })
      const rows = store.snapshot().effects
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.kind === 'launch')?.payload).toEqual({ n: 2 })
      expect(rows.find((row) => row.kind === 'deliver')?.payload).toEqual({ n: 3 })
    })

    it('enqueued effects roll back with the transaction', () => {
      const store = new MemoryRepositories()
      expect(() =>
        store.atomic(() => {
          store.effects.enqueue('probe', 'slot_1', {})
          throw new Error('boom')
        }),
      ).toThrow('boom')
      expect(store.snapshot().effects).toEqual([])
    })
  })

  describe('snapshot', () => {
    it('returns a deep copy that mutations never feed back into the store', () => {
      const store = new MemoryRepositories()
      store.workItems.save({ id: 'wi_1', nested: { count: 1 } })
      store.events.append('att_1', event('att_1', 1, 'started'))
      const snap = store.snapshot()
      const row = snap.workItems[0] as unknown as { nested: { count: number } }
      row.nested.count = 99
      const snapEvent = snap.events.att_1?.[0]
      if (snapEvent !== undefined) snapEvent.type = 'mutated'
      expect((store.workItems.get('wi_1') as unknown as { nested: { count: number } }).nested.count).toBe(1)
      expect(store.events.read('att_1')[0]?.type).toBe('started')
    })
  })
})
