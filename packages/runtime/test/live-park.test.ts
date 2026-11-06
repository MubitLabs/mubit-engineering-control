// M2.4, §5.10, §11: a quota or auth hit parks as it arrives. The engine is a real process through
// the fake CLI; the store is a double, so the order of facts can be read off.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttemptBrief, AttemptRef, EngineAdapter, EngineEvent } from '@mec/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../../engines/src/claude/adapter'
import { type AttemptFacts, AttemptRunner, replayJournal } from '../src/attempt-runner'
import { AttemptJournal } from '../src/journal'
import { ownedSpawn } from '../src/owned-spawn'
import { parkFromEvents, parkReady, resumeVerdict } from '../src/park'
import { Supervisor, SupervisorError } from '../src/supervisor'

const FAKE_CLI = fileURLToPath(new URL('../../testkit/fake-cli/claude', import.meta.url))
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-park-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const rejected = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    resetsAt: 1893456000,
    rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1893456000, status: 'rejected' } },
  },
}

type Parked = { state: string; reason: string; resetsAt: string | undefined }

/** A store double: anything these tests do not read is a no-op. */
function facts() {
  const parked: Parked[] = []
  const events: EngineEvent[] = []
  const log: string[] = []
  const seen = new Set<string>()
  let failCommit = false
  const double = new Proxy(
    {
      atomic: <T>(fn: () => T): T => {
        const value = fn()
        if (failCommit) throw new Error('the store refused the commit')
        log.push('commit')
        return value
      },
      engineEvent: (_attempt: AttemptRef, event: EngineEvent) => {
        events.push(event)
      },
      attemptParked: (_attempt: AttemptRef, state: string, reason: string, resetsAt?: string) => {
        parked.push({ state, reason, resetsAt })
      },
      attemptInterrupted: () => {
        log.push('interrupted')
      },
      attemptFailed: (_attempt: AttemptRef, reason: string) => {
        log.push(`failed: ${reason}`)
      },
      stopFailed: () => {
        log.push('stop_failed')
      },
      attemptStalled: () => {
        log.push('stalled')
      },
      journalled: () => seen,
    },
    { get: (target, key) => (target as Record<string, unknown>)[String(key)] ?? (() => {}) },
  ) as unknown as AttemptFacts
  return {
    double,
    parked,
    events,
    log,
    seen,
    failCommits: (fail: boolean) => {
      failCommit = fail
    },
  }
}

const REF = { attempt_id: 'att_park', generation: 1 }

function briefAt(worktree: string, wallClockMs = 30_000): AttemptBrief {
  return {
    attempt_id: 'att_park',
    generation: 1,
    task_id: 'task_1',
    objective: 'do it',
    worktree,
    base_sha: 'a'.repeat(40),
    budget: { turns: 3, wall_clock_ms: wallClockMs },
    isolation: { read_only: false, permission_mode: 'bridge' },
    env: {},
  } as unknown as AttemptBrief
}

const planAt = (dir: string, worktree: string) => ({
  env: { PATH: process.env.PATH ?? '', HOME: dir },
  cwd: worktree,
  bridge: {} as never,
  slotId: 'slot_a',
  checks: [],
  identity: { name: 'n', email: 'e@example.com' },
  fingerprints: [],
  exacts: [],
  seal: () => {},
})

const GIT = {
  commitAll: async () => null,
  headSha: async () => 'a'.repeat(40),
  historyTouches: async () => false,
  adminDirOf: () => undefined,
}

let counter = 0

const dirFor = (): string => {
  counter += 1
  const dir = join(root, `rig-${counter}`)
  mkdirSync(join(dir, 'work'), { recursive: true })
  return dir
}

async function rig(steps: unknown[]) {
  const dir = dirFor()
  const bin = join(dir, 'bin')
  const worktree = join(dir, 'work')
  mkdirSync(bin)
  execFileSync('git', ['init', '--quiet', '-b', 'mec/x'], { cwd: worktree })
  copyFileSync(FAKE_CLI, join(bin, 'claude'))
  writeFileSync(join(bin, 'scenario.json'), JSON.stringify({ steps }))
  const supervisor = new Supervisor()
  const store = facts()
  const adapter = new ClaudeAdapter({
    binary: join(bin, 'claude'),
    spawnFn: ownedSpawn(supervisor, { attemptId: REF.attempt_id, generation: REF.generation }),
  })
  const runner = new AttemptRunner({
    journalRoot: join(dir, 'journal'),
    supervisor,
    facts: store.double,
    git: GIT,
    adapterFor: () => adapter,
    planFor: () => planAt(dir, worktree),
  })
  await runner.launchAttempt(REF, briefAt(worktree))
  return { runner, supervisor, worktree, ...store }
}

describe('live parking', { timeout: 40_000 }, () => {
  const holdsOpen = [{ init: true }, { emit: rejected }, { forever: true }]

  it('rejected rate limit parks during the run', async () => {
    const { parked, events, log } = await rig(holdsOpen)
    await expect.poll(() => (parked.length === 1 ? 1 : log), { timeout: 25_000 }).toBe(1)
    expect(parked[0]?.state).toBe('quota_wait')
    expect(parked[0]?.resetsAt).toBeDefined()
    expect(events.some((event) => event.type === 'rate_limit')).toBe(true)
  })

  it('worktree and branch survive', async () => {
    const { runner, parked, worktree } = await rig(holdsOpen)
    await expect.poll(() => parked.length, { timeout: 25_000 }).toBe(1)
    await runner.settled()
    expect(existsSync(join(worktree, '.git'))).toBe(true)
    const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: worktree })
    expect(String(branch).trim()).toBe('mec/x')
  })

  it('parked attempt frees capacity', async () => {
    const { runner, supervisor, parked } = await rig(holdsOpen)
    await expect.poll(() => parked.length, { timeout: 25_000 }).toBe(1)
    await expect.poll(() => runner.live().length, { timeout: 25_000 }).toBe(0)
    expect(supervisor.owns(REF.attempt_id, REF.generation)).toBe(false)
  })

  it('an allowed window does not park', async () => {
    const allowed = {
      type: 'rate_limit_event',
      rate_limit_info: { ...rejected.rate_limit_info, status: 'allowed', unifiedWindows: {} },
    }
    const { runner, parked } = await rig([{ init: true }, { emit: allowed }, { result: 'completed' }])
    await expect.poll(() => runner.live().length, { timeout: 25_000 }).toBe(0)
    expect(parked).toEqual([])
  })
})

/** A runner whose engine never ends on its own, for stops the supervisor answers. */
function stubbed(supervisor: Supervisor, wallClockMs = 3_600_000) {
  const dir = dirFor()
  const store = facts()
  let finish = (): void => {}
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  const adapter = {
    launch: async () => ({ attempt_id: REF.attempt_id, generation: REF.generation }),
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await ended
          return { done: true, value: undefined }
        },
      }),
    }),
  } as unknown as EngineAdapter
  const runner = new AttemptRunner({
    journalRoot: join(dir, 'journal'),
    supervisor,
    facts: store.double,
    git: GIT,
    adapterFor: () => adapter,
    planFor: () => planAt(dir, join(dir, 'work')),
  })
  return { runner, finish, ...store, brief: briefAt(join(dir, 'work'), wallClockMs) }
}

describe('stop', () => {
  class Refuses extends Supervisor {
    gone = false
    override owns(): boolean {
      return !this.gone
    }
    override async stop(): Promise<'terminated'> {
      if (!this.gone) throw new SupervisorError('refused to die')
      return 'terminated'
    }
  }

  it('interrupted waits until the group is confirmed gone, and a failed stop stays visible', async () => {
    const supervisor = new Refuses()
    const { runner, log, finish, brief } = stubbed(supervisor)
    await runner.launchAttempt(REF, brief)
    await expect(runner.stop(REF)).rejects.toThrow('refused to die')
    expect(log).toContain('stop_failed')
    expect(log).not.toContain('interrupted')
    expect(runner.live()).toHaveLength(1)
    supervisor.gone = true
    const stopping = runner.stop(REF)
    finish()
    await stopping
    expect(log).toContain('interrupted')
  })
})

describe('sleep and stall', () => {
  class Dead extends Supervisor {
    gone = false
    override owns(): boolean {
      return !this.gone
    }
    override isAlive(): boolean {
      return false
    }
    override async stop(): Promise<'terminated'> {
      this.gone = true
      return 'terminated'
    }
  }

  it('a silent journal and a dead group is a stall, handed on once', async () => {
    const { runner, log, brief } = stubbed(new Dead())
    await runner.launchAttempt(REF, brief)
    const start = Date.now()
    expect(runner.sweep(start + 1000)).toEqual([])
    expect(runner.sweep(start + 120_000)).toEqual([REF])
    expect(log).toContain('stalled')
    expect(runner.sweep(start + 240_000)).toEqual([])
    expect(runner.live()).toHaveLength(0)
  })

  it('a live group is not a stall, however quiet', async () => {
    class Alive extends Dead {
      override isAlive(): boolean {
        return true
      }
    }
    const { runner, log, brief } = stubbed(new Alive())
    await runner.launchAttempt(REF, brief)
    expect(runner.sweep(Date.now() + 120_000)).toEqual([])
    expect(log).not.toContain('stalled')
  })

  it('a wall clock that passed during sleep ends the attempt at the next sweep', async () => {
    class Alive extends Dead {
      override isAlive(): boolean {
        return true
      }
    }
    const { runner, log, finish, brief } = stubbed(new Alive(), 60_000)
    await runner.launchAttempt(REF, brief)
    runner.sweep(Date.now() + 120_000)
    finish()
    await runner.settled()
    expect(log).toContain('interrupted')
  })
})

describe('journal replay', () => {
  const usage = (seq: number) =>
    ({
      type: 'usage',
      attempt_id: REF.attempt_id,
      generation: 1,
      seq,
      at: '2026-11-05T10:00:01.000Z',
      input_tokens: 1,
      output_tokens: 1,
    }) as unknown as EngineEvent

  const journalAt = (dir: string) => AttemptJournal.open(join(dir, REF.attempt_id))

  it('applies the unacknowledged tail in order, then acks', () => {
    const dir = dirFor()
    const journal = journalAt(dir)
    journal.append(usage(1))
    journal.append(usage(2))
    journal.ack(1)
    const { double, events } = facts()
    expect(replayJournal({ journalRoot: dir, facts: double }, 'att_park', 'slot_a')).toBe(1)
    expect(events.map((event) => event.seq)).toEqual([2])
    expect(journalAt(dir).pending()).toEqual([])
  })

  it('skips what the store has and acks it, so a crash before the ack applies nothing twice', () => {
    const dir = dirFor()
    journalAt(dir).append(usage(1))
    const { double, events, seen } = facts()
    seen.add('1 1')
    expect(replayJournal({ journalRoot: dir, facts: double }, 'att_park', 'slot_a')).toBe(0)
    expect(events).toEqual([])
    expect(journalAt(dir).pending()).toEqual([])
  })

  it('a store that fails leaves the event unacknowledged', () => {
    const dir = dirFor()
    journalAt(dir).append(usage(1))
    const { double, failCommits } = facts()
    failCommits(true)
    expect(() => replayJournal({ journalRoot: dir, facts: double }, 'att_park', 'slot_a')).toThrow()
    expect(journalAt(dir).pending()).toHaveLength(1)
  })

  it('an attempt with no journal has nothing to replay', () => {
    const { double } = facts()
    expect(replayJournal({ journalRoot: dirFor(), facts: double }, 'att_none', 'slot_a')).toBe(0)
  })
})

describe('resume', () => {
  const at = '2026-11-05T12:00:00.000Z'
  const ok = { ok: true } as const

  it('the reset time is on the decision', () => {
    const decision = parkFromEvents([
      {
        type: 'rate_limit',
        window: 'five_hour',
        status: 'rejected',
        resets_at: '2026-11-05T13:00:00.000Z',
      } as never,
    ])
    expect(decision).toMatchObject({ park: true, resetsAt: '2026-11-05T13:00:00.000Z' })
  })

  it('reset plus healthy probe resumes once', () => {
    const parked = { resetsAt: '2026-11-05T11:00:00.000Z', now: at }
    expect(parkReady({ ...parked, slotHealthy: true, resuming: false })).toBe(true)
    expect(parkReady({ ...parked, slotHealthy: true, resuming: true })).toBe(false)
    expect(parkReady({ ...parked, slotHealthy: false, resuming: false })).toBe(false)
  })

  it('a reset still ahead waits, whatever the probe says', () => {
    const parked = { resetsAt: '2026-11-05T13:00:00.000Z', now: at }
    expect(parkReady({ ...parked, slotHealthy: true, resuming: false })).toBe(false)
  })

  it('an unknown reset resumes on the next healthy probe', () => {
    expect(parkReady({ slotHealthy: true, resuming: false, now: at })).toBe(true)
    expect(parkReady({ resetsAt: 'unknown', slotHealthy: true, resuming: false, now: at })).toBe(true)
    expect(parkReady({ resetsAt: 'unknown', slotHealthy: false, resuming: false, now: at })).toBe(false)
  })

  it('a hold blocks resume', () => {
    expect(resumeVerdict({ held: true, mandate: ok })).toEqual({ verdict: 'defer', reason: 'held' })
  })

  it('a mandate that fails revalidation drops the resume, hold or none', () => {
    const expired = { ok: false, reason: 'expired' } as const
    for (const held of [true, false]) {
      expect(resumeVerdict({ held, mandate: expired })).toEqual({
        verdict: 'drop',
        reason: 'mandate_expired',
      })
    }
  })

  it('a policy change waits behind a hold, as a launch does', () => {
    const changed = { ok: false, reason: 'policy_changed' } as const
    expect(resumeVerdict({ held: true, mandate: changed }).verdict).toBe('defer')
    expect(resumeVerdict({ held: false, mandate: changed })).toEqual({
      verdict: 'drop',
      reason: 'policy_changed',
    })
  })

  it('a clean mandate with no hold runs', () => {
    expect(resumeVerdict({ held: false, mandate: ok })).toEqual({ verdict: 'run' })
  })
})
