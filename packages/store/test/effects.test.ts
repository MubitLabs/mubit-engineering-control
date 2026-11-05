import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Later } from '@mec/contracts'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EffectsQueue, HealthBoardImpl } from '../src/effects-queue'
import { MIGRATIONS_v1, migrate } from '../src/migrations'
import { SqliteStore } from '../src/store'

let dir: string
let db: Database.Database
let health: HealthBoardImpl
let queue: EffectsQueue
let clockMs: number

/** The fixed clock everything in this suite reads; advance it to move time forward. */
const clock = (): Date => new Date(clockMs)
const advance = (seconds: number): void => {
  clockMs += seconds * 1000
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mec-effects-'))
  db = new Database(join(dir, 'state.db'))
  migrate(db, MIGRATIONS_v1)
  health = new HealthBoardImpl()
  clockMs = Date.parse('2026-11-03T12:00:00.000Z')
  queue = new EffectsQueue(db, { health, now: clock })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Seconds between the fixed clock and a row's next_run_at. */
const delayOf = (snapshot: { nextRunAt: string }): number => (Date.parse(snapshot.nextRunAt) - clockMs) / 1000

describe('effects queue', () => {
  it('coalesces: a second enqueue of the same kind+key replaces the payload, one row remains', () => {
    queue.enqueue('relay', 'wi_1', { wake: 1 })
    advance(5)
    queue.enqueue('relay', 'wi_1', { wake: 2 })
    const rows = db.prepare('SELECT COUNT(*) AS n FROM effects').get() as { n: number }
    expect(rows.n).toBe(1)
    const job = queue.snapshot('relay', 'wi_1')
    expect(job?.payload).toEqual({ wake: 2 })
    expect(job?.state).toBe('pending')
    expect(job?.attempts).toBe(0)
    // A waiting row keeps its due time (queue order preserved across coalescing).
    expect(delayOf(job!)).toBe(-5)
  })

  it('enqueue joins the caller transaction', () => {
    db.exec('BEGIN')
    queue.enqueue('note', 'wi_1', { text: 'hello' })
    db.exec('ROLLBACK')
    expect(queue.snapshot('note', 'wi_1')).toBeUndefined()
  })

  it('Later defers 30 s as waiting, without counting a failure', async () => {
    let calls = 0
    queue.handle('note', async () => {
      calls += 1
      if (calls === 1) throw new Later('no slot free yet')
    })
    queue.enqueue('note', 'wi_1', { text: 'first' })

    await queue.run({ now: clock() })
    const job = queue.snapshot('note', 'wi_1')
    expect(calls).toBe(1)
    expect(job?.state).toBe('waiting')
    expect(job?.attempts).toBe(0)
    expect(job?.lastError).toBeUndefined()
    expect(delayOf(job!)).toBe(30)

    // Not due at +29 s; due at +30 s and then it succeeds.
    advance(29)
    await queue.run({ now: clock() })
    expect(calls).toBe(1)
    advance(1)
    await queue.run({ now: clock() })
    expect(calls).toBe(2)
    expect(queue.snapshot('note', 'wi_1')).toBeUndefined() // Success drains the row.
    expect(health.entry('effects:note')?.state).not.toBe('error')
  })

  it('an ordered kind holds later jobs behind a failing one', async () => {
    const calls: string[] = []
    let failFirst = true
    queue.handle('relay', async (payload) => {
      const tag = (payload as { tag: string }).tag
      calls.push(tag)
      if (tag === 'first' && failFirst) throw new Error('relay down')
    })
    queue.enqueue('relay', 'wi_1', { tag: 'first' })
    queue.enqueue('relay', 'wi_2', { tag: 'second' })

    await queue.run({ now: clock() })
    expect(calls).toEqual(['first']) // One at a time, oldest first.

    advance(1) // Past the first backoff step.
    await queue.run({ now: clock() })
    expect(calls).toEqual(['first', 'first']) // The retry fails; 'second' stays held.

    failFirst = false
    advance(4) // Past the second backoff step.
    await queue.run({ now: clock() })
    expect(calls).toEqual(['first', 'first', 'first'])
    await queue.run({ now: clock() })
    expect(calls).toEqual(['first', 'first', 'first', 'second']) // Only after 'first' lands.
    expect(queue.snapshot('relay', 'wi_1')).toBeUndefined() // Drained on success.
    expect(queue.snapshot('relay', 'wi_2')).toBeUndefined()
  })

  it('an ordered kind gives up on a job whose attempts exhaust and moves to the next', async () => {
    const calls: string[] = []
    queue.handle('relay', async (payload) => {
      const tag = (payload as { tag: string }).tag
      calls.push(tag)
      if (tag === 'first') throw new Error('relay permanently down')
    })
    queue.enqueue('relay', 'wi_1', { tag: 'first' })
    queue.enqueue('relay', 'wi_2', { tag: 'second' })

    // 'first' burns one run per backoff step (1 s, 4 s, 16 s, 64 s, 300 s) without succeeding.
    for (const step of [1, 4, 16, 64, 300]) {
      await queue.run({ now: clock() })
      expect(queue.snapshot('relay', 'wi_1')?.state).toBe('pending')
      advance(step)
    }
    await queue.run({ now: clock() }) // The sixth failure exhausts the attempts.
    expect(queue.snapshot('relay', 'wi_1')?.state).toBe('failed')
    expect(queue.snapshot('relay', 'wi_1')?.attempts).toBe(6)
    expect(queue.snapshot('relay', 'wi_1')?.lastError).toBe('relay permanently down')

    await queue.run({ now: clock() }) // The failed head no longer holds the kind.
    expect(calls).toEqual(['first', 'first', 'first', 'first', 'first', 'first', 'second'])
    expect(queue.snapshot('relay', 'wi_2')).toBeUndefined()
  })

  it('failures back off 1 s, 4 s, 16 s, 64 s, 300 s, then the job is failed', async () => {
    queue.handle('launch', async () => {
      throw new Error('boom')
    })
    queue.enqueue('launch', 'att_1', { attempt: 'att_1' })

    const expected = [1, 4, 16, 64, 300]
    for (let attempt = 1; attempt <= expected.length; attempt++) {
      await queue.run({ now: clock() })
      const job = queue.snapshot('launch', 'att_1')
      expect(job?.attempts).toBe(attempt)
      expect(job?.state).toBe('pending')
      expect(job?.lastError).toBe('boom')
      const delay = delayOf(job!)
      expect(delay).toBe(expected[attempt - 1])
      advance(delay)
    }
    await queue.run({ now: clock() }) // The failure past the last backoff is terminal.
    const job = queue.snapshot('launch', 'att_1')
    expect(job?.state).toBe('failed')
    expect(job?.attempts).toBe(6)
    expect(job?.lastError).toBe('boom')
    await queue.run({ now: clock() }) // A failed row is never picked again.
    expect(queue.snapshot('launch', 'att_1')?.attempts).toBe(6)
  })

  it('respects the default concurrency of 2 within one pass', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const calls: string[] = []
    queue.handle('launch', async (payload) => {
      const key = (payload as { key: string }).key
      calls.push(key)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      await Promise.resolve()
      inFlight -= 1
    })
    queue.enqueue('launch', 'k1', { key: 'k1' })
    queue.enqueue('launch', 'k2', { key: 'k2' })
    queue.enqueue('launch', 'k3', { key: 'k3' })

    await queue.run({ now: clock() })
    expect(calls).toEqual(['k1', 'k2']) // The limit holds within the pass.
    expect(maxInFlight).toBe(2)

    await queue.run({ now: clock() })
    expect(calls).toEqual(['k1', 'k2', 'k3'])
    expect(maxInFlight).toBe(2)
  })

  it('drains every due job and then stops', async () => {
    const calls: string[] = []
    queue.handle(
      'note',
      async (payload) => {
        calls.push((payload as { key: string }).key)
      },
      { concurrency: 2 },
    )
    queue.enqueue('note', 'k1', { key: 'k1' })
    queue.enqueue('note', 'k2', { key: 'k2' })
    await queue.drain()
    expect(calls).toEqual(['k1', 'k2'])
    expect(queue.snapshot('note', 'k1')).toBeUndefined() // Drained on success.
    expect(queue.snapshot('note', 'k2')).toBeUndefined()
    await queue.drain() // Nothing left: returns without touching handlers.
    expect(calls).toEqual(['k1', 'k2'])
  })

  it('health turns error after three consecutive failures of a kind and clears on success', async () => {
    let fail = true
    queue.handle('note', async () => {
      if (fail) throw new Error('note handler broken')
    })
    queue.enqueue('note', 'wi_1', { text: 'x' })

    const states: string[] = []
    const failOnce = async (): Promise<void> => {
      await queue.run({ now: clock() })
      states.push(health.entry('effects:note')?.state ?? 'missing')
      advance(delayOf(queue.snapshot('note', 'wi_1')!))
    }
    await failOnce() // failure 1 → starting
    await failOnce() // failure 2 → still starting
    await failOnce() // failure 3 → error
    expect(states).toEqual(['starting', 'starting', 'error'])
    const errorEntry = health.entry('effects:note')
    expect(errorEntry?.detail).toContain('note handler broken')

    fail = false
    advance(delayOf(queue.snapshot('note', 'wi_1')!))
    await queue.run({ now: clock() })
    expect(queue.snapshot('note', 'wi_1')).toBeUndefined() // Drained on success.
    expect(health.entry('effects:note')?.state).toBe('ready')

    // A later failure starts the consecutive count from zero again.
    fail = true
    queue.enqueue('note', 'wi_1', { text: 'y' })
    await queue.run({ now: clock() })
    expect(health.entry('effects:note')?.state).toBe('ready')
  })

  it('Later does not feed the health failure count', async () => {
    queue.handle('note', async () => {
      throw new Later('paused')
    })
    queue.enqueue('note', 'wi_1', { text: 'x' })
    for (let i = 0; i < 4; i++) {
      await queue.run({ now: clock() })
      advance(30)
    }
    expect(queue.snapshot('note', 'wi_1')?.attempts).toBe(0)
    expect(queue.snapshot('note', 'wi_1')?.state).toBe('waiting')
    expect(health.entry('effects:note')?.state).not.toBe('error')
  })
})

/** A handler body that stays in flight until `release` is called. */
const gate = (): { wait: Promise<void>; release: () => void } => {
  let release = (): void => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

describe('a pause shifts deadlines, not what it held back (§20)', () => {
  const hour = 3600

  it('a row written during the pause is due at resume, and holds no later relay', async () => {
    const ran: string[] = []
    queue.handle('relay', async (payload) => {
      ran.push(String(payload))
    })
    // Paused for an hour; the owner answers halfway through it.
    advance(hour / 2)
    queue.enqueue('relay', 'wake:answer', 'answer')
    advance(hour / 2)
    queue.enqueue('relay', 'wake:later', 'later')

    queue.shiftWaiting(hour * 1000)
    await queue.drain()

    expect(ran).toEqual(['answer', 'later'])
  })

  it('a deadline still ahead at resume moves later by the pause', () => {
    queue.handle('launch', async () => {
      throw new Later('not yet')
    })
    queue.enqueue('launch', 'a', {})
    return queue.run().then(() => {
      const before = Date.parse(queue.snapshot('launch', 'a')?.nextRunAt ?? '')
      queue.shiftWaiting(hour * 1000)
      expect(Date.parse(queue.snapshot('launch', 'a')?.nextRunAt ?? '')).toBe(before + hour * 1000)
    })
  })
})

describe('overlapping passes', () => {
  it('a running job is not re-picked by an overlapping pass', async () => {
    const held = gate()
    const payloads: unknown[] = []
    queue.handle('launch', async (payload) => {
      payloads.push(payload)
      await held.wait
    })
    queue.enqueue('launch', 'att_1', { attempt: 1 })

    const first = queue.run({ now: clock() })
    const second = queue.run({ now: clock() })
    expect(payloads).toEqual([{ attempt: 1 }])
    expect(queue.snapshot('launch', 'att_1')?.state).toBe('running') // A pass never resets it.

    // A coalesced re-enqueue returns the row to pending, but its job is still in flight.
    queue.enqueue('launch', 'att_1', { attempt: 2 })
    const third = queue.run({ now: clock() })
    expect(payloads).toEqual([{ attempt: 1 }])

    held.release()
    await Promise.all([first, second, third])
  })

  it('concurrency holds across overlapping passes', async () => {
    const held = gate()
    const calls: string[] = []
    queue.handle('launch', async (payload) => {
      calls.push((payload as { key: string }).key)
      await held.wait
    })
    queue.enqueue('launch', 'k1', { key: 'k1' })
    queue.enqueue('launch', 'k2', { key: 'k2' })
    queue.enqueue('launch', 'k3', { key: 'k3' })

    const first = queue.run({ now: clock() })
    const second = queue.run({ now: clock() })
    expect(calls).toEqual(['k1', 'k2'])
    held.release()
    await Promise.all([first, second])
    await queue.run({ now: clock() })
    expect(calls).toEqual(['k1', 'k2', 'k3'])
  })

  it('a free slot fills on the next pass while another job of the kind still runs', async () => {
    const held = gate()
    const calls: string[] = []
    queue.handle('launch', async (payload) => {
      const key = (payload as { key: string }).key
      calls.push(key)
      if (key === 'slow') await held.wait
    })
    queue.enqueue('launch', 'slow', { key: 'slow' })
    const first = queue.run({ now: clock() })
    queue.enqueue('launch', 'k2', { key: 'k2' })

    // §11: a slow launch delays only its own task, so the pass is not held behind it.
    const second = queue.run({ now: clock() })
    expect(calls).toEqual(['slow', 'k2'])

    held.release()
    await Promise.all([first, second])
  })

  it('a slow job of one kind does not hold back another kind', async () => {
    const held = gate()
    const calls: string[] = []
    queue.handle('launch', async () => {
      calls.push('launch')
      await held.wait
    })
    queue.handle('relay', async () => {
      calls.push('relay')
    })
    queue.enqueue('launch', 'att_1', {})
    const first = queue.run({ now: clock() })
    queue.enqueue('relay', 'wi_1', {})

    const second = queue.run({ now: clock() })
    expect(calls).toEqual(['launch', 'relay'])

    held.release()
    await Promise.all([first, second])
  })

  it('an ordered kind stays one at a time across overlapping passes', async () => {
    const held = gate()
    const calls: string[] = []
    queue.handle('relay', async (payload) => {
      calls.push((payload as { key: string }).key)
      await held.wait
    })
    queue.enqueue('relay', 'k1', { key: 'k1' })
    queue.enqueue('relay', 'k2', { key: 'k2' })

    const first = queue.run({ now: clock() })
    const second = queue.run({ now: clock() })
    expect(calls).toEqual(['k1'])

    // Coalescing the head mid-run must not expose it, or the job behind it, to a second pass.
    queue.enqueue('relay', 'k1', { key: 'k1', again: true })
    const third = queue.run({ now: clock() })
    expect(calls).toEqual(['k1'])

    held.release()
    await Promise.all([first, second, third])
  })

  it('a re-enqueue with a new payload during a run survives the success and runs once after it', async () => {
    const held = gate()
    const payloads: unknown[] = []
    queue.handle('launch', async (payload) => {
      payloads.push(payload)
      await held.wait
    })
    queue.enqueue('launch', 'att_1', { rev: 1 })
    const first = queue.run({ now: clock() })
    queue.enqueue('launch', 'att_1', { rev: 2 })
    held.release()
    await first

    expect(queue.snapshot('launch', 'att_1')?.state).toBe('pending')
    await queue.run({ now: clock() })
    expect(payloads).toEqual([{ rev: 1 }, { rev: 2 }])
    expect(queue.snapshot('launch', 'att_1')).toBeUndefined()
  })

  it('an identical re-enqueue during a run adds no second run (a replayed launch)', async () => {
    const held = gate()
    let calls = 0
    queue.handle('launch', async () => {
      calls += 1
      await held.wait
    })
    queue.enqueue('launch', 'att_1', { attempt: 1 })
    const first = queue.run({ now: clock() })
    queue.enqueue('launch', 'att_1', { attempt: 1 })
    held.release()
    await first

    expect(queue.snapshot('launch', 'att_1')).toBeUndefined()
    await queue.run({ now: clock() })
    expect(calls).toBe(1)
  })

  it('drain waits for a job an earlier pass started, and does not run it again', async () => {
    const held = gate()
    let calls = 0
    let finished = false
    queue.handle('launch', async () => {
      calls += 1
      await held.wait
      finished = true
    })
    queue.enqueue('launch', 'att_1', {})
    const first = queue.run({ now: clock() })

    let returned = false
    const drained = queue.drain().then(() => {
      returned = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(returned).toBe(false) // Shutdown closes the database right after the drain.
    held.release()
    await drained
    expect(finished).toBe(true)
    expect(calls).toBe(1)
    await first
  })

  it('a settled job leaves the guard: the same key runs again when enqueued again', async () => {
    let calls = 0
    queue.handle('launch', async () => {
      calls += 1
    })
    queue.enqueue('launch', 'att_1', {})
    await queue.run({ now: clock() })
    queue.enqueue('launch', 'att_1', {})
    await queue.run({ now: clock() })
    expect(calls).toBe(2)
  })
})

describe('settle', () => {
  it('settle waits for in-flight jobs and starts none', async () => {
    const ran: string[] = []
    let finish: () => void = () => {}
    queue.handle(
      'launch',
      async (payload) => {
        ran.push(String(payload))
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
      { concurrency: 1 },
    )
    queue.enqueue('launch', 'first', 'first')
    queue.enqueue('launch', 'second', 'second')
    void queue.run()

    let settled = false
    const settling = queue.settle().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finish()
    await settling

    expect(ran).toEqual(['first'])
    expect(queue.snapshot('launch', 'first')).toBeUndefined()
    expect(queue.snapshot('launch', 'second')?.state).toBe('pending')
  })

  it('settle with nothing in flight returns and leaves due rows alone', async () => {
    queue.handle('launch', async () => {})
    queue.enqueue('launch', 'due', {})

    await queue.settle()

    expect(queue.snapshot('launch', 'due')?.state).toBe('pending')
  })
})

describe('restart', () => {
  /** What a crash leaves behind: a row marked running that no live handler owns. */
  const crashed = (kind: string, key: string): void => {
    db.prepare("UPDATE effects SET state = 'running' WHERE kind = ? AND key = ?").run(kind, key)
  }

  it('boot resumes a crashed running row', async () => {
    const calls: string[] = []
    queue.handle('launch', async (payload) => {
      calls.push((payload as { key: string }).key)
    })
    queue.enqueue('launch', 'att_1', { key: 'att_1' })
    crashed('launch', 'att_1')

    queue.resumeRunning()
    expect(queue.snapshot('launch', 'att_1')?.state).toBe('pending')
    await queue.run({ now: clock() })
    expect(calls).toEqual(['att_1'])
    expect(queue.snapshot('launch', 'att_1')).toBeUndefined()
  })

  it('a crashed ordered head resumes first and keeps its place', async () => {
    const calls: string[] = []
    queue.handle('relay', async (payload) => {
      calls.push((payload as { key: string }).key)
    })
    queue.enqueue('relay', 'k1', { key: 'k1' })
    queue.enqueue('relay', 'k2', { key: 'k2' })
    crashed('relay', 'k1')

    queue.resumeRunning()
    await queue.drain()
    expect(calls).toEqual(['k1', 'k2'])
  })

  it('a pass alone does not resume a running row', async () => {
    let calls = 0
    queue.handle('launch', async () => {
      calls += 1
    })
    queue.enqueue('launch', 'att_1', {})
    crashed('launch', 'att_1')

    await queue.run({ now: clock() })
    expect(calls).toBe(0)
    expect(queue.snapshot('launch', 'att_1')?.state).toBe('running')
  })
})

describe('health board', () => {
  it('records state per name and refuses a second claim', () => {
    const handle = health.claim('runtime')
    expect(health.entry('runtime')).toMatchObject({ state: 'starting' })

    handle.ready('listening on 127.0.0.1:7331')
    expect(health.entry('runtime')).toMatchObject({ state: 'ready', detail: 'listening on 127.0.0.1:7331' })

    handle.paused()
    expect(health.entry('runtime')?.state).toBe('paused')

    handle.error('no slot is healthy')
    expect(health.entry('runtime')).toMatchObject({ state: 'error', detail: 'no slot is healthy' })

    expect(() => health.claim('runtime')).toThrow(/already claimed/)
    expect(health.entry('scheduler')).toBeUndefined()
    expect(health.names()).toEqual(['runtime'])
  })
})

describe('store and queue together', () => {
  it('a store transaction carries its enqueues; handlers only run against committed rows', async () => {
    const store = new SqliteStore(db, { now: clock })
    const seen: string[] = []
    store.effects.handle('note', async (payload) => {
      seen.push((payload as { key: string }).key)
    })

    expect(() =>
      store.atomic(() => {
        store.effects.enqueue('note', 'wi_lost', { key: 'wi_lost' })
        throw new Error('command refused')
      }),
    ).toThrow('command refused')

    store.atomic(() => {
      store.effects.enqueue('note', 'wi_1', { key: 'wi_1' })
      store.events.append('work:wi_1', {
        stream: 'work:wi_1',
        seq: 1,
        at: clock().toISOString(),
        type: 'note.enqueued',
        body: { key: 'wi_1' },
      })
    })

    await store.effects.drain()
    expect(seen).toEqual(['wi_1'])
    expect(store.effects.snapshot('note', 'wi_lost')).toBeUndefined()
  })
})
