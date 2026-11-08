// M2.4, §20, §26: what a boot does with what a crash left. Each case is the state on disk at one
// boundary, with any orphan a real process, then a real boot over it.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoreDoc } from '@mec/contracts'
import { AttemptJournal, processStart } from '@mec/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  identifyGroup,
  type ProcessDeps,
  reconcilePlanner,
  reconcileProcesses,
  resumeParked,
} from '../src/recovery'
import { ownerHeaders } from './approval-rig'
import {
  alive,
  attemptOf,
  brainThatNeverRuns,
  cleanUp,
  eventsOf,
  orphan,
  PROBE_DOWN,
  PROBE_OK,
  peek,
  peekAsync,
  type Rig,
  reaches,
  scratch,
  seedStore,
  serve,
  settle,
  until,
  WORK,
} from './recovery-rig'

const members: ChildProcess[] = []

afterEach(async () => {
  for (const child of members.splice(0)) child.kill('SIGKILL')
  await cleanUp()
})

/** A live process in this test's own group: real, and never provably an engine's group leader. */
const member = async (): Promise<{ child: ChildProcess; mark: { pid: number; started: string } }> => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  members.push(child)
  const pid = child.pid as number
  return { child, mark: { pid, started: await started(pid) } }
}

const STEPS = [{ init: true }, { sh: 'echo made > "$MEC_ATTEMPT_ID.txt"' }, { result: 'completed' }]
const HOLD_OPEN = [{ init: true }, { forever: true }]
const IGNORES_TERM = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"

/** The attempt docs of a task: one authoritative attempt, however many generations it took. */
const attemptsOf = (rig: Rig): number =>
  peek(rig, (store) => store.attempts.list({ taskId: 'task_1' }).length)

const usage = (seq: number, generation = 1) => ({
  type: 'usage' as const,
  attempt_id: 'att_1',
  generation,
  seq,
  at: '2026-11-05T10:00:01.000Z',
  input_tokens: 10 * seq,
  output_tokens: 1,
})

const journalOf = (rig: Rig): AttemptJournal => AttemptJournal.open(join(rig.dataDir, 'journal', 'att_1'))

const running = { state: 'running', session_id: 'session-1', generation: 1 }

const started = async (pid: number): Promise<string> => {
  await until(() => processStart(pid) !== undefined)
  return processStart(pid) as string
}

describe('restart gives one authoritative outcome', { timeout: 60_000 }, () => {
  it('message stored: its turn runs once', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: { state: 'succeeded' } })
    peek(rig, (store) => {
      store.atomic(() => {
        store.workItems.save({ id: 'wi_planning', state: 'planning', repoId: 'repo_a' })
        store.messages.save({
          id: 'msg_cut',
          text: 'cut short',
          routing: 'new_work',
          repoId: 'repo_a',
          workItemId: 'wi_planning',
          createdAt: '2026-11-05T10:00:00.000Z',
        })
      })
    })
    let turns = 0
    await serve(rig, {
      probeRun: PROBE_OK,
      brain: async () => {
        turns += 1
        return { ack: 'On it.', plan: { tasks: [] } }
      },
    })
    await until(() => typeof peek(rig, (store) => store.messages.get('msg_cut')?.ackText) === 'string')
    await settle()
    expect(turns).toBe(1)
  })

  it('plan committed: the queued attempt launches once', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { task: { status: 'ready' } })
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    expect(attemptsOf(rig)).toBe(1)
    expect(attemptOf(rig)?.generation).toBe(1)
  })

  it('launch claimed: an engine it left is gone and the attempt starts once', async () => {
    const rig = scratch(STEPS)
    const pid = orphan()
    seedStore(rig, {
      noRow: true,
      task: { status: 'ready' },
      attempt: { process: { pid, started: await started(pid) } },
    })
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    expect(alive(pid)).toBe(false)
    expect(attemptsOf(rig)).toBe(1)
  })

  it('launch row left behind: it waits until reconciliation cleared its engine', async () => {
    const rig = scratch(STEPS)
    const pid = orphan()
    seedStore(rig, { task: { status: 'ready' }, attempt: { process: { pid, started: await started(pid) } } })
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    expect(alive(pid)).toBe(false)
    expect(attemptsOf(rig)).toBe(1)
  })

  it('event journalled: the fact reaches the store once', async () => {
    const rig = scratch(HOLD_OPEN)
    seedStore(rig, { noRow: true, attempt: running })
    journalOf(rig).append(usage(1))
    await serve(rig, { probeRun: PROBE_OK })
    await until(() => attemptOf(rig)?.usage !== undefined)
    expect(eventsOf(rig, 'attempt:att_1').filter((type) => type === 'usage')).toHaveLength(1)
    expect(journalOf(rig).pending()).toHaveLength(0)
  })

  it('store committed: an event in the store with no ack is not applied again', async () => {
    const rig = scratch(HOLD_OPEN)
    seedStore(rig, { noRow: true, attempt: running })
    journalOf(rig).append(usage(1))
    peek(rig, (store) => {
      const stream = 'attempt:att_1'
      store.events.append(stream, { stream, seq: 1, at: usage(1).at, type: 'usage', body: usage(1) })
    })
    await serve(rig, { probeRun: PROBE_OK })
    await until(() => journalOf(rig).pending().length === 0)
    expect(eventsOf(rig, 'attempt:att_1').filter((type) => type === 'usage')).toHaveLength(1)
  })

  it('ack written: the attempt restarts as one new generation', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: running })
    const journal = journalOf(rig)
    journal.append(usage(1))
    journal.ack(1)
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    expect(attemptsOf(rig)).toBe(1)
    expect(attemptOf(rig)?.generation).toBe(2)
    const types = eventsOf(rig, 'attempt:att_1')
    expect(types.filter((type) => type === 'attempt.resumed')).toHaveLength(1)
  })

  it('card approved: read from the remote and nothing is sent again', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: { state: 'succeeded' } })
    peek(rig, (store) => {
      store.confirmations.save({
        id: 'conf_push',
        cls: 'push',
        status: 'approved',
        operationHash: 'h',
        inputSha: 'a'.repeat(40),
        createdAt: '2026-11-05T10:00:00.000Z',
        expiresAt: '2026-11-06T10:00:00.000Z',
        payload: {
          repo: 'owner/repo',
          repoId: 'repo_a',
          branch: 'mec/x',
          remoteUrl: join(rig.root, 'empty.git'),
        },
      })
    })
    await serve(rig, { probeRun: PROBE_OK })
    // No such remote is an unreadable one: nothing is recorded, and nothing is sent.
    expect(eventsOf(rig, 'release:owner/repo:mec/x')).toEqual([])
  })
})

describe('journal replay', { timeout: 30_000 }, () => {
  it('journal replay applies a fact once, across two boots', async () => {
    const rig = scratch(HOLD_OPEN)
    seedStore(rig, { noRow: true, attempt: running })
    journalOf(rig).append(usage(1))
    const first = await serve(rig, { probeRun: PROBE_OK })
    await until(() => attemptOf(rig)?.state === 'running' && attemptOf(rig)?.generation === 2)
    await first.close()
    await serve(rig, { probeRun: PROBE_OK })
    await settle(500)
    expect(eventsOf(rig, 'attempt:att_1').filter((type) => type === 'usage')).toHaveLength(1)
  })
})

describe('no orphans', { timeout: 60_000 }, () => {
  it('orphan group is gone before dispatch, in the boot order §20 names', async () => {
    const rig = scratch(STEPS)
    const pid = orphan()
    const mark = { pid, started: await started(pid) }
    rig.rescript([
      { init: true },
      { sh: `kill -0 ${pid} 2>/dev/null && echo alive > "${rig.root}/orphan.txt"` },
      { result: 'completed' },
    ])
    seedStore(rig, { noRow: true, attempt: { ...running, process: mark } })
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    expect(alive(pid)).toBe(false)
    expect(existsSync(join(rig.root, 'orphan.txt'))).toBe(false)
    const order = peek(rig, (store) => store.engines.get('recovery/last-boot')?.order)
    expect(order).toEqual(['journal', 'processes', 'external', 'effects', 'dispatch'])
  })

  it('an orphan ignoring SIGTERM is killed and its token leaves the worktree', async () => {
    const rig = scratch(STEPS)
    const pid = orphan(IGNORES_TERM)
    const mark = { pid, started: await started(pid) }
    await settle(300) // Node has to reach the handler, or SIGTERM alone would do it.
    const worktree = join(rig.dataDir, 'work', 'att_1')
    mkdirSync(join(worktree, '.mec'), { recursive: true })
    writeFileSync(join(worktree, '.mec', 'mcp.json'), '{"token":"old"}')
    seedStore(rig, {
      noRow: true,
      work: { state: 'stopped' },
      attempt: { ...running, worktree, process: mark },
    })
    await serve(rig, { probeRun: PROBE_OK })
    expect(alive(pid)).toBe(false)
    expect(existsSync(join(worktree, '.mec', 'mcp.json'))).toBe(false)
    expect(attemptOf(rig)?.state).toBe('interrupted')
  })

  it('recycled pid is never signalled', async () => {
    const rig = scratch(STEPS)
    const pid = orphan()
    await started(pid)
    seedStore(rig, {
      noRow: true,
      attempt: { ...running, process: { pid, started: 'Thu Jan  1 00:00:00 1970' } },
    })
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    expect(alive(pid)).toBe(true)
    expect(eventsOf(rig, 'attempt:att_1')).toContain('attempt.pid_recycled')
  })

  it('a group that cannot be proven ours is reported, left alone, and nothing replaces it', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: { ...running, process: { pid: 4242, started: 'then' } } })
    await peekAsync(rig, (store) =>
      reconcileProcesses({
        store,
        effects: store.effects,
        dataDir: rig.dataDir,
        now: () => '2026-11-05T11:00:00.000Z',
        identify: () => 'unprovable',
        reap: async () => {
          throw new Error('an unprovable group is never signalled')
        },
      }),
    )
    expect(attemptOf(rig)?.state).toBe('stalled')
    expect(attemptOf(rig)?.generation).toBe(1)
    expect(eventsOf(rig, 'attempt:att_1')).toContain('attempt.reconcile_refused')
    expect(peek(rig, (store) => store.effects.snapshot('launch', 'att_1:2'))).toBeUndefined()
  })

  it('reads identity from the start time, not the pid', () => {
    const mark = { pid: 4242, started: 'then' }
    const groupAlive = (): boolean => true
    expect(identifyGroup(mark, () => ({ started: 'then', pgid: 4242 }), groupAlive)).toBe('ours')
    expect(identifyGroup(mark, () => ({ started: 'later', pgid: 4242 }), groupAlive)).toBe('recycled')
    expect(identifyGroup(mark, () => undefined, groupAlive)).toBe('unprovable')
    expect(
      identifyGroup(
        mark,
        () => undefined,
        () => false,
      ),
    ).toBe('gone')
    expect(identifyGroup(mark, () => ({ started: 'then', pgid: 1 }), groupAlive)).toBe('unprovable')
  })

  it('a live process that leads no group is not gone because ps could not read it', () => {
    const mark = { pid: process.pid, started: 'then' }
    expect(identifyGroup(mark, () => undefined)).toBe('unprovable')
  })

  it('oldest work item restarts first', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: running, work: { createdAt: '2026-11-05T09:00:00.000Z' } })
    peek(rig, (store) => {
      store.atomic(() => {
        store.workItems.save({ id: 'wi_older', state: 'executing', createdAt: '2026-11-01T09:00:00.000Z' })
        store.attempts.save({
          id: 'att_0',
          taskId: 'task_0',
          workItemId: 'wi_older',
          slotId: 'slot_a',
          state: 'running',
          generation: 1,
        })
      })
    })
    await peekAsync(rig, (store) =>
      reconcileProcesses({
        store,
        effects: store.effects,
        dataDir: rig.dataDir,
        now: () => '2026-11-05T11:00:00.000Z',
      }),
    )
    const order = peek(rig, (_store, db) =>
      db.prepare("SELECT key FROM effects WHERE kind = 'launch' ORDER BY rowid").all(),
    ) as { key: string }[]
    expect(order.map((row) => row.key)).toEqual(['att_0:2', 'att_1:2'])
  })
})

describe('a group that would not go', { timeout: 90_000 }, () => {
  const row = (rig: Rig, generation: number, extra: Record<string, unknown> = {}) => {
    peek(rig, (store) => {
      store.atomic(() => {
        store.effects.enqueue('launch', `att_1:${generation}`, {
          attempt_id: 'att_1',
          task_id: 'task_1',
          work_item_id: WORK,
          slot_id: 'slot_a',
          generation,
          ...extra,
        } as never)
      })
    })
  }

  /** First boot refuses; the row runs nothing. A later boot proves the group gone; the row runs. */
  const waitsThenRuns = async (rig: Rig, child: ChildProcess): Promise<void> => {
    const first = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await settle(1500)
    expect(rig.started()).toBe(false)
    expect(attemptOf(rig)?.reconcile_refused).toBe('unprovable')
    await first.close()
    const pid = child.pid as number
    child.kill('SIGKILL')
    await until(() => !alive(pid))
    // A deferred row is due within 30 s anyway; this test need not wait them out.
    peek(rig, (store) => store.effects.wakeDeferred(['launch']))
    await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await reaches(rig, 'work_complete')
    expect(rig.started()).toBe(true)
    expect(attemptOf(rig)?.reconcile_refused).toBeUndefined()
  }

  it.each(['interrupted', 'quota_wait'])(
    'a resume row waits for proof, on an attempt that is %s',
    async (state) => {
      const rig = scratch(STEPS)
      const { child, mark } = await member()
      seedStore(rig, {
        noRow: true,
        attempt: { state, generation: 2, session_id: 'session-1', resuming: true, process: mark },
      })
      row(rig, 2, { resume: true, note: 'host restarted' })
      await waitsThenRuns(rig, child)
    },
  )

  it('a launch row waits for proof too', async () => {
    const rig = scratch(STEPS)
    const { child, mark } = await member()
    seedStore(rig, { noRow: true, task: { status: 'ready' }, attempt: { process: mark } })
    row(rig, 1)
    await waitsThenRuns(rig, child)
  })
})

describe('restart', { timeout: 60_000 }, () => {
  it('recovery note is first input, on the same worktree, session and slot', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: running })
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    const first = JSON.stringify(rig.stdin()[0])
    expect(first).toContain('host restarted')
    expect(first).toContain('check the worktree, git history and outbox')
    expect(rig.seen().argv).toContain('--resume')
    expect(rig.seen().argv).toContain('session-1')
    expect(attemptOf(rig)?.worktree).toBe(join(rig.dataDir, 'work', 'att_1'))
    expect(attemptOf(rig)?.slotId).toBe('slot_a')
  })

  it('goes through stalled and interrupted, to a new generation', async () => {
    const rig = scratch(HOLD_OPEN)
    seedStore(rig, { noRow: true, attempt: running })
    await serve(rig, { probeRun: PROBE_OK })
    await until(() => attemptOf(rig)?.state === 'running' && attemptOf(rig)?.generation === 2)
    const types = eventsOf(rig, 'attempt:att_1')
    expect(types.indexOf('attempt.reconciled')).toBeLessThan(types.indexOf('attempt.resumed'))
    expect(types).toContain('attempt.resumed')
    expect(attemptOf(rig)?.resuming).toBeUndefined()
  })

  it('an attempt with no session starts over with the note and the whole brief', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: { state: 'running', generation: 1 } })
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    const first = JSON.stringify(rig.stdin()[0])
    expect(first).toContain('host restarted')
    expect(first).toContain('add the thing')
    expect(rig.seen().argv).not.toContain('--resume')
  })

  it('waiting attempt stays waiting', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: { state: 'quota_wait', generation: 1 } })
    await serve(rig, { probeRun: PROBE_DOWN })
    await settle()
    expect(attemptOf(rig)?.state).toBe('quota_wait')
    expect(attemptOf(rig)?.generation).toBe(1)
    expect(rig.started()).toBe(false)
  })

  it('stopped work stays stopped: nothing launches', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, work: { state: 'stopped' }, attempt: running })
    await serve(rig, { probeRun: PROBE_OK })
    await settle()
    expect(attemptOf(rig)?.state).toBe('interrupted')
    expect(rig.started()).toBe(false)
  })

  it('held work waits for the lift: a restart does not lift a hold', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, {
      noRow: true,
      work: { hold: { reason: 'wait', at: '2026-11-05T10:00:00.000Z' } },
      attempt: running,
    })
    await serve(rig, { probeRun: PROBE_OK })
    await settle()
    expect(attemptOf(rig)?.state).toBe('interrupted')
    expect(rig.started()).toBe(false)
    const hold = peek(rig, (store) => store.workItems.get(WORK)?.hold) as { liftedAt?: string }
    expect(hold.liftedAt).toBeUndefined()
  })

  it('an expired mandate is refused before the engine starts', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, {
      noRow: true,
      work: {
        mandate: { originMessageId: 'msg_1', expiresAt: '2026-01-01T00:00:00.000Z', status: 'active' },
      },
      attempt: running,
    })
    await serve(rig, { probeRun: PROBE_OK })
    await settle()
    expect(attemptOf(rig)?.state).toBe('interrupted')
    expect(rig.started()).toBe(false)
  })

  it('a waiting input reaches the new generation, once', async () => {
    const rig = scratch([{ init: true }, { waitInput: 2 }, { result: 'completed' }])
    seedStore(rig, { noRow: true, attempt: running })
    const input = { id: 'in_1', kind: 'message', text: 'and one more thing', message_id: 'msg_2' }
    peek(rig, (store) => {
      store.atomic(() => {
        store.messages.save({
          id: 'msg_2',
          text: input.text,
          owned: true,
          ownerAttemptId: 'att_1',
          workItemId: WORK,
          inputId: 'in_1',
        })
        store.effects.enqueue('deliver', 'in_1', { attempt_id: 'att_1', generation: 1, input })
      })
    })
    await serve(rig, { probeRun: PROBE_OK })
    await until(
      () => rig.stdin().filter((line) => JSON.stringify(line).includes('one more thing')).length > 0,
      40_000,
    )
    await settle(500)
    expect(rig.stdin().filter((line) => JSON.stringify(line).includes('one more thing'))).toHaveLength(1)
  })

  it('a resuming attempt keeps its capacity, so a new task does not take it', async () => {
    const rig = scratch(HOLD_OPEN)
    // The hold keeps the resume waiting on a healthy slot; the other work wants that slot's one place.
    seedStore(rig, {
      noRow: true,
      slot: { concurrency: 1 },
      work: { hold: { reason: 'wait', at: '2026-11-05T10:00:00.000Z' } },
      attempt: running,
    })
    peek(rig, (store) => {
      const work = store.workItems.get(WORK) as Record<string, never>
      const { hold: _hold, ...free } = work
      store.atomic(() => {
        store.workItems.save({ ...free, id: 'wi_other' as never })
        store.tasks.save({
          id: 'task_2',
          workItemId: 'wi_other',
          repoId: 'repo_a',
          status: 'ready',
          role: 'implementer',
          objective: 'something else',
          originalRequestRef: 'msg_1',
          acceptanceChecks: [],
        })
      })
    })
    await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await until(() => attemptOf(rig)?.resuming === true)
    await settle()
    expect(peek(rig, (store) => store.attempts.list({ taskId: 'task_2' }))).toHaveLength(0)
    expect(rig.started()).toBe(false)
  })
})

describe('parked work', { timeout: 60_000 }, () => {
  const rejected = (resetsAt: number) => ({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt,
      rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 0.97, resetsAt, status: 'rejected' } },
    },
  })
  const parkedAttempt = {
    state: 'quota_wait',
    session_id: 'session-1',
    parked: {
      state: 'quota_wait',
      reason: 'limit',
      at: '2026-01-01T00:00:00.000Z',
      resets_at: '2026-01-01T01:00:00.000Z',
    },
  }
  const degraded = {
    state: 'degraded',
    state_reason: 'quota_exhausted',
    resets_at: '2026-01-01T01:00:00.000Z',
  }

  it('a live park tells chat and the slot the same thing, and frees the slot', async () => {
    const rig = scratch([{ init: true }, { emit: rejected(1893456000) }, { forever: true }])
    seedStore(rig, { task: { status: 'ready' } })
    await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await reaches(rig, 'quota_wait')
    const slot = peek(rig, (store) => store.slots.get('slot_a'))
    expect(slot).toMatchObject({ state: 'degraded', state_reason: 'quota_exhausted' })
    expect(slot?.usageUtilization).toBe(0.97)
    // A wait on the ceiling names the window and its reset from the same reading.
    expect(slot).toMatchObject({ usageWindow: 'five_hour', usageResetsAt: '2030-01-01T00:00:00.000Z' })
    const notices = peek(rig, (store) => store.messages.list({ routing: 'notice' }))
    expect(notices).toHaveLength(1)
    expect(String(notices[0]?.text)).toContain('slot_a')
    expect(String(notices[0]?.text)).toContain('resets 2030')
    expect(alive(rig.seen().pid)).toBe(false)
    expect(existsSync(String(attemptOf(rig)?.worktree))).toBe(true)
  })

  it('a reset that passed plus a healthy probe resumes once, on the same session', async () => {
    const rig = scratch(HOLD_OPEN)
    seedStore(rig, { noRow: true, slot: degraded, attempt: parkedAttempt })
    await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await until(() => attemptOf(rig)?.state === 'running', 20_000)
    await until(() => rig.stdin().length > 0, 20_000)
    await settle()
    expect(attemptOf(rig)?.generation).toBe(2)
    expect(rig.seen().argv).toContain('session-1')
    expect(JSON.stringify(rig.stdin()[0])).toContain('resumed after a park')
  })

  it('a slot still logged out resumes nothing', async () => {
    const rig = scratch(HOLD_OPEN)
    seedStore(rig, { noRow: true, slot: degraded, attempt: parkedAttempt })
    await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_DOWN })
    await settle()
    expect(attemptOf(rig)?.state).toBe('quota_wait')
    expect(attemptOf(rig)?.generation).toBe(1)
    expect(rig.started()).toBe(false)
  })

  it("a hold keeps parked work parked, and the owner's resume does not lift it", async () => {
    const rig = scratch(HOLD_OPEN)
    seedStore(rig, {
      noRow: true,
      slot: degraded,
      work: { hold: { reason: 'wait', at: '2026-11-05T10:00:00.000Z' } },
      attempt: parkedAttempt,
    })
    const server = await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await settle()
    const asked = await fetch(`${server.url}/api/work/${WORK}/resume`, { method: 'POST' })
    expect(await asked.json()).toMatchObject({ resumed: [] })
    expect(attemptOf(rig)?.generation).toBe(1)
  })

  it('the owner can resume with no probe', async () => {
    const rig = scratch(HOLD_OPEN)
    seedStore(rig, {
      noRow: true,
      slot: { state: 'healthy' },
      attempt: { ...parkedAttempt, parked: { ...parkedAttempt.parked, at: '2099-01-01T00:00:00.000Z' } },
    })
    const server = await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await settle()
    expect(attemptOf(rig)?.state).toBe('quota_wait')
    const asked = await fetch(`${server.url}/api/work/${WORK}/resume`, { method: 'POST' })
    expect(await asked.json()).toMatchObject({ resumed: ['att_1'] })
    await until(() => attemptOf(rig)?.state === 'running', 20_000)
  })
})

describe('an attempt stopped mid-check', { timeout: 60_000 }, () => {
  const midCheck = async (crash: boolean): Promise<Rig> => {
    const rig = scratch(STEPS)
    const flag = join(rig.root, 'green')
    const script = join(rig.root, 'check.sh')
    writeFileSync(script, `#!/bin/sh\n[ -e ${flag} ] && exit 0\nsleep 60\n`)
    seedStore(rig, { checks: [{ name: 'slow', cmd: `sh ${script}` }] })
    const first = await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete')
    await first.close()
    if (crash) {
      peek(rig, (store) => {
        const {
          checks_note: _note,
          checks_stopped: _stopped,
          ...doc
        } = store.attempts.get('att_1') as Record<string, never>
        store.attempts.save(doc)
      })
    }
    writeFileSync(flag, '')
    rig.rescript([{ exit: 9 }])
    return rig
  }

  it('a graceful stop re-runs the checks on the same head and starts no engine', async () => {
    const rig = await midCheck(false)
    const head = attemptOf(rig)?.head_sha
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'succeeded')
    expect(attemptOf(rig)?.head_sha).toBe(head)
    expect(attemptOf(rig)?.generation).toBe(1)
    expect(peek(rig, (store) => store.engines.get('check/att_1/slow'))?.status).toBe('passed')
  })

  it('a crash mid-check does the same', async () => {
    const rig = await midCheck(true)
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'succeeded')
    expect(attemptOf(rig)?.generation).toBe(1)
  })

  it('a stop that ended the checks stays stopped', async () => {
    const rig = await midCheck(false)
    peek(rig, (store) => {
      store.attempts.save({
        ...(store.attempts.get('att_1') as Record<string, never>),
        checks_stopped: 'stop_requested' as never,
      })
    })
    await peekAsync(rig, (store) =>
      reconcileProcesses({
        store,
        effects: store.effects,
        dataDir: rig.dataDir,
        now: () => '2026-11-05T11:00:00.000Z',
      }),
    )
    expect(peek(rig, (store) => store.effects.snapshot('launch', 'att_1:1:recheck'))).toBeUndefined()
    await serve(rig, { probeRun: PROBE_OK })
    await settle()
    expect(attemptOf(rig)?.state).toBe('work_complete')
  })

  it('a head that moved is no head to judge', async () => {
    const rig = await midCheck(false)
    peek(rig, (store) => {
      store.attempts.save({
        ...(store.attempts.get('att_1') as Record<string, never>),
        head_sha: 'b'.repeat(40) as never,
      })
    })
    await serve(rig, { probeRun: PROBE_OK })
    await reaches(rig, 'work_complete').catch(() => {})
    await settle()
    expect(attemptOf(rig)?.state).toBe('work_complete')
    expect(eventsOf(rig, 'attempt:att_1')).toContain('attempt.checks_skipped')
  })
})

describe('a group that outlived its failed attempt', { timeout: 60_000 }, () => {
  const failed = (held: { pid: number; started: string }[]) => ({
    state: 'failed',
    terminal_reason: 'monitor_error: refused to die',
    stop_failed: 'refused to die',
    held_groups: held,
  })

  const boot = (rig: Rig, seams: Partial<ProcessDeps> = {}): Promise<void> =>
    peekAsync(rig, (store) =>
      reconcileProcesses({
        store,
        effects: store.effects,
        dataDir: rig.dataDir,
        now: () => '2026-11-05T11:00:00.000Z',
        ...seams,
      }),
    )

  it('a restart keeps the hold while it is there, and releases once it has gone', async () => {
    const rig = scratch(STEPS)
    const { child, mark } = await member()
    seedStore(rig, { noRow: true, attempt: failed([mark]) })

    await boot(rig)
    expect(attemptOf(rig)).toMatchObject({ state: 'failed', held_groups: [mark] })
    expect(eventsOf(rig, 'attempt:att_1')).not.toContain('attempt.capacity_released')
    expect(alive(mark.pid)).toBe(true)

    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
    await boot(rig)
    expect(attemptOf(rig)?.state).toBe('failed')
    expect(attemptOf(rig)?.held_groups).toBeUndefined()
    expect(eventsOf(rig, 'attempt:att_1')).toContain('attempt.capacity_released')
  })

  it('a real restart stops a group it can prove its own, and the capacity comes back', async () => {
    const rig = scratch(STEPS)
    const pid = orphan(IGNORES_TERM)
    const mark = { pid, started: await started(pid) }
    await settle(300)
    seedStore(rig, { noRow: true, task: { status: 'blocked' }, attempt: failed([mark]) })
    await serve(rig, { probeRun: PROBE_OK })
    expect(alive(pid)).toBe(false)
    expect(attemptOf(rig)?.state).toBe('failed')
    expect(attemptOf(rig)?.held_groups).toBeUndefined()
  })

  it('a stop still refused keeps it held, and only what has gone leaves the list', async () => {
    const rig = scratch(STEPS)
    const ours = { pid: 4242, started: 'then' }
    const left = { pid: 4343, started: 'then' }
    seedStore(rig, { noRow: true, attempt: failed([left, ours]) })
    await boot(rig, {
      identify: (mark) => (mark.pid === left.pid ? 'gone' : 'ours'),
      reap: async () => 'refused',
    })
    expect(attemptOf(rig)).toMatchObject({ state: 'failed', held_groups: [ours] })
    expect(eventsOf(rig, 'attempt:att_1')).not.toContain('attempt.capacity_released')
  })

  it('a group it cannot prove its own is never signalled', async () => {
    const rig = scratch(STEPS)
    const mark = { pid: 4242, started: 'then' }
    seedStore(rig, { noRow: true, attempt: failed([mark]) })
    await boot(rig, {
      identify: () => 'unprovable',
      reap: async () => {
        throw new Error('an unprovable group is never signalled')
      },
    })
    expect(attemptOf(rig)).toMatchObject({ state: 'failed', held_groups: [mark] })
  })

  it('a recycled pid means the group has gone', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, attempt: failed([{ pid: 4242, started: 'then' }]) })
    await boot(rig, {
      identify: () => 'recycled',
      reap: async () => 'refused',
    })
    expect(attemptOf(rig)?.held_groups).toBeUndefined()
  })

  it('a queued attempt no owner agreed to does not keep a parked one out of its slot', () => {
    const rig = scratch(STEPS)
    seedStore(rig, {
      noRow: true,
      attempt: { state: 'provider_down', parked: { state: 'provider_down', at: '2026-11-05T10:00:00.000Z' } },
      slot: { concurrency: 1, last_probe_at: '2026-11-05T10:30:00.000Z' },
    })
    peek(rig, (store) => {
      store.atomic(() => {
        store.engines.save({ id: 'repo_b', url: 'nowhere', bootstrap: [], checks: [], trust: false })
        store.workItems.save({ id: 'wi_other', state: 'executing', repoId: 'repo_b' })
        store.attempts.save({
          id: 'att_0',
          taskId: 'task_0',
          workItemId: 'wi_other',
          slotId: 'slot_a',
          state: 'queued',
        })
      })
    })
    const resumed = peek(rig, (store) =>
      resumeParked({
        store,
        effects: store.effects,
        policyHash: 'any',
        now: () => '2026-11-05T11:00:00.000Z',
      }),
    )
    expect(resumed).toEqual(['att_1'])
  })

  it('a parked attempt does not resume into a slot a held group fills', () => {
    const rig = scratch(STEPS)
    seedStore(rig, {
      noRow: true,
      attempt: { state: 'provider_down', parked: { state: 'provider_down', at: '2026-11-05T10:00:00.000Z' } },
      slot: { concurrency: 1, last_probe_at: '2026-11-05T10:30:00.000Z' },
    })
    const resume = (): string[] =>
      peek(rig, (store) =>
        resumeParked({
          store,
          effects: store.effects,
          policyHash: 'any',
          now: () => '2026-11-05T11:00:00.000Z',
        }),
      )
    peek(rig, (store) => {
      store.atomic(() => {
        store.attempts.save({
          id: 'att_0',
          taskId: 'task_0',
          workItemId: 'wi_other',
          slotId: 'slot_a',
          ...failed([{ pid: 4242, started: 'then' }]),
        })
      })
    })
    expect(resume()).toEqual([])
    peek(rig, (store) => {
      const { held_groups: _gone, ...rest } = store.attempts.get('att_0') as StoreDoc
      store.atomic(() => store.attempts.save(rest))
    })
    expect(resume()).toEqual(['att_1'])
  })
})

describe('the planner engine', { timeout: 40_000 }, () => {
  it('an orphan and its token dir from a killed server are gone at boot', async () => {
    const rig = scratch(STEPS)
    const pid = orphan(IGNORES_TERM)
    const mark = { pid, started: await started(pid) }
    await settle(300)
    const dir = mkdtempSync(join(tmpdir(), 'mec-planner-'))
    writeFileSync(join(dir, 'mcp.json'), 'Bearer dead')
    seedStore(rig, { noRow: true, attempt: { state: 'succeeded' } })
    peek(rig, (store) => store.engines.save({ id: 'runtime/planner', process: mark, tempDirs: [dir] }))
    await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    expect(alive(pid)).toBe(false)
    expect(existsSync(dir)).toBe(false)
  })

  it('a recorded dir outside the planner pattern is left alone', async () => {
    const rig = scratch(STEPS)
    const dir = mkdtempSync(join(tmpdir(), 'mec-not-planner-'))
    seedStore(rig, { noRow: true, attempt: { state: 'succeeded' } })
    peek(rig, (store) => store.engines.save({ id: 'runtime/planner', tempDirs: [dir] }))
    await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    expect(existsSync(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['unprovable', 'unprovable' as const],
    ['refused', 'ours' as const],
  ])('a group that stays %s keeps its mark and dirs, and says so', async (reason, found) => {
    const rig = scratch(STEPS)
    const mark = { pid: 4242, started: 'then' }
    const dir = mkdtempSync(join(tmpdir(), 'mec-planner-'))
    seedStore(rig, { noRow: true, attempt: { state: 'succeeded' } })
    peek(rig, (store) => store.engines.save({ id: 'runtime/planner', process: mark, tempDirs: [dir] }))
    const seams = {
      identify: () => found,
      reap: async () => {
        if (found === 'ours') return 'refused'
        throw new Error('an unprovable group is never signalled')
      },
    }
    await peekAsync(rig, (store) => reconcilePlanner(store, seams))
    const doc = peek(rig, (store) => store.engines.get('runtime/planner'))
    expect(doc?.refused).toEqual([{ process: mark, reason }])
    expect(doc?.tempDirs).toEqual([dir])
    expect(existsSync(dir)).toBe(true)
    expect(eventsOf(rig, 'runtime:planner')).toEqual(['planner.reconcile_refused'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('a mark a boot refused survives a new engine, and goes when a later boot proves it gone', async () => {
    const rig = scratch(STEPS)
    const mark = { pid: 4242, started: 'then' }
    const dir = mkdtempSync(join(tmpdir(), 'mec-planner-'))
    seedStore(rig, { noRow: true, attempt: { state: 'succeeded' } })
    peek(rig, (store) => store.engines.save({ id: 'runtime/planner', process: mark, tempDirs: [dir] }))
    await peekAsync(rig, (store) => reconcilePlanner(store, { identify: () => 'unprovable' }))
    // What a new server's next planner turn writes.
    peek(rig, (store) => {
      const doc = store.engines.get('runtime/planner')
      store.engines.save({ ...doc, id: 'runtime/planner', process: { pid: 4343, started: 'now' } })
    })
    // The old mark is read again, not forgotten; the new one ended, so only the old one stays.
    const oldStays = {
      identify: (seen: { pid: number }) => (seen.pid === 4242 ? 'unprovable' : 'gone'),
    } as const
    await peekAsync(rig, (store) => reconcilePlanner(store, oldStays))
    expect(peek(rig, (store) => store.engines.get('runtime/planner'))?.refused).toEqual([
      { process: mark, reason: 'unprovable' },
    ])
    expect(existsSync(dir)).toBe(true)
    await peekAsync(rig, (store) => reconcilePlanner(store, { identify: () => 'gone' }))
    const doc = peek(rig, (store) => store.engines.get('runtime/planner'))
    expect(doc?.refused).toBeUndefined()
    expect(doc?.process).toBeUndefined()
    expect(existsSync(dir)).toBe(false)
  })

  it('a mark a boot refused survives the server closing', async () => {
    const rig = scratch(STEPS)
    const { mark } = await member()
    seedStore(rig, { noRow: true, attempt: { state: 'succeeded' } })
    peek(rig, (store) => store.engines.save({ id: 'runtime/planner', process: mark, tempDirs: [] }))
    const slot = join(rig.root, 'meta-slot')
    mkdirSync(slot)
    const server = await serve(rig, { metaSlotDir: slot, real: false })
    await server.close()
    const doc = peek(rig, (store) => store.engines.get('runtime/planner'))
    expect(doc?.refused).toEqual([{ process: mark, reason: 'unprovable' }])
  })

  it('an engine ignoring SIGTERM does not outlive close, and leaves no token dir', async () => {
    const rig = scratch([{ ignoreTerm: true }, { init: true }, { forever: true }])
    // Stopped, so the message is a new request and gets a planner turn.
    seedStore(rig, { noRow: true, work: { state: 'stopped' }, attempt: { state: 'succeeded' } })
    const slot = join(rig.root, 'meta-slot')
    mkdirSync(slot)
    const server = await serve(rig, { metaSlotDir: slot, real: false })
    const answered = fetch(`${server.url}/api/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      body: JSON.stringify({ text: 'please plan', repoId: 'repo_a' }),
    }).then(async (response) => {
      throw new Error(`the turn ended before its engine started: ${await response.text()}`)
    })
    await Promise.race([until(() => rig.started()), answered])
    answered.catch(() => {})
    const { pid } = rig.seen()
    const dirs = peek(rig, (store) => store.engines.get('runtime/planner')?.tempDirs) as string[]
    expect(dirs.length).toBeGreaterThan(0)
    await server.close()
    await until(() => !alive(pid), 8000)
    for (const dir of dirs) expect(existsSync(dir)).toBe(false)
  })
})
