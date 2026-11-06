// A repository runs nothing until its owner agrees, and a store from before the agreement is the
// hard case: every kind of old work sits there with authority of its own. Each case seeds that store
// and boots a real server with the fake CLI first on PATH, so a launch would be a real process.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ownerHeaders } from './approval-rig'
import {
  attemptOf,
  brainThatNeverRuns,
  cleanUp,
  eventsOf,
  PROBE_OK,
  peek,
  type Rig,
  reaches,
  type Seed,
  type Served,
  scratch,
  seedStore,
  serve,
  settle,
  until,
  WORK,
} from './recovery-rig'

afterEach(cleanUp)

const STEPS = [{ init: true }, { sh: 'echo made > "$MEC_ATTEMPT_ID.txt"' }, { result: 'completed' }]
const SLOW_STEPS = [{ init: true }, { sh: 'sleep 2' }, { result: 'completed' }]

const post = async (server: Served, path: string): Promise<Response> =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: ownerHeaders })
const agree = (server: Served): Promise<Response> => post(server, '/api/repositories/repo_a/host-run/agree')
const withdraw = (server: Served): Promise<Response> =>
  post(server, '/api/repositories/repo_a/host-run/withdraw')

const rowOf = (rig: Rig, key: string): string | undefined =>
  peek(rig, (store) => store.effects.snapshot('launch', key)?.state)

const parked = {
  state: 'quota_wait',
  session_id: 'session-1',
  parked: { state: 'quota_wait', reason: 'window', at: '2026-11-05T10:00:00.000Z' },
}

const CASES: { name: string; seed: Seed; key?: string }[] = [
  {
    name: 'a ready task with no attempt, on a slot not probed yet',
    seed: { noAttempt: true, noRow: true, task: { status: 'ready' }, slot: { state: 'degraded' } },
  },
  {
    name: 'a queued attempt with its launch row',
    seed: { task: { status: 'active' } },
    key: 'att_1:1',
  },
  {
    name: 'a parked attempt',
    seed: { noRow: true, attempt: parked, slot: { last_probe_at: '2026-11-05T10:30:00.000Z' } },
  },
  {
    name: 'an attempt a shutdown interrupted',
    seed: { noRow: true, attempt: { state: 'interrupted', terminal_reason: 'server_closing' } },
    key: 'att_1:2',
  },
]

describe('work from before the agreement', { timeout: 120_000 }, () => {
  it.each(CASES)('$name runs nothing, then goes once the owner agrees', async ({ seed, key }) => {
    const rig = scratch(STEPS)
    seedStore(rig, { preUpgrade: true, ...seed })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await settle(3000)
    expect(rig.started()).toBe(false)
    if (key !== undefined) expect(rowOf(rig, key)).toBe('waiting')
    if (seed.noAttempt === true) {
      expect(peek(rig, (store) => store.attempts.list())).toHaveLength(0)
      expect(peek(rig, (store) => store.tasks.get('task_1')?.deferred)).toMatchObject({
        reason: 'host_run_unagreed',
      })
    }
    expect((await agree(server)).status).toBe(200)
    await until(() => rig.started(), 60_000, 'the work starting')
  })

  it('a head whose checks were cut short is not checked again until the owner agrees', async () => {
    const rig = scratch(STEPS)
    const ran = join(rig.root, 'check-ran')
    seedStore(rig, {
      preUpgrade: true,
      noRow: true,
      checks: [{ name: 'marker', cmd: `touch ${ran}` }],
      attempt: { state: 'work_complete', head_sha: 'abc', worktree: rig.repo },
    })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await settle(1500)
    expect(rowOf(rig, 'att_1:1:recheck')).toBe('waiting')
    expect(existsSync(ran)).toBe(false)
    await server.close()
  })

  it.each([
    ['held', { work: { hold: { reason: 'wait', at: '2026-11-05T10:00:00.000Z' } } }],
    ['blocked', { work: { state: 'blocked', blockedReason: 'needs a person' } }],
    ['stopped', { work: { state: 'stopped' } }],
    [
      'blocked and interrupted',
      {
        noRow: true,
        work: { state: 'blocked', blockedReason: 'needs a person' },
        attempt: { state: 'interrupted', terminal_reason: 'server_closing' },
      },
    ],
    ['stopped and parked', { noRow: true, work: { state: 'stopped' }, attempt: parked }],
  ] as [string, Seed][])('%s work stays put when the owner agrees', async (_name, seed) => {
    const rig = scratch(STEPS)
    seedStore(rig, { preUpgrade: true, task: { status: 'active' }, ...seed })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await settle(1000)
    expect((await agree(server)).status).toBe(200)
    await settle(3000)
    expect(rig.started()).toBe(false)
  })
})

describe('the owner agreeing and withdrawing', { timeout: 120_000 }, () => {
  it('an attached repository starts unagreed, and neither its body nor an edit can agree', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { preUpgrade: true, noAttempt: true, noRow: true })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    const attach = await fetch(`${server.url}/api/repositories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        urlOrPath: rig.repo,
        bootstrapCmds: [],
        checkCmds: [],
        trusted: true,
        hostRunAgreedAt: '2026-11-05T08:00:00.000Z',
      }),
    })
    const { id } = (await attach.json()) as { id: string }
    const listed = (await (await fetch(`${server.url}/api/repositories`)).json()) as {
      id: string
      hostRunAgreedAt: string | null
    }[]
    expect(listed.find((row) => row.id === id)?.hostRunAgreedAt).toBeNull()
    expect(peek(rig, (store) => store.engines.get(id)?.hostRunAgreedAt)).toBeUndefined()
  })

  it('says how many items wait, and an agreement outlives an edit but not a withdrawal', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { preUpgrade: true, task: { status: 'active' }, slot: { state: 'degraded' } })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    const list = async () =>
      (await (await fetch(`${server.url}/api/repositories`)).json()) as {
        id: string
        hostRunAgreedAt: string | null
        waiting: number
        revision: string
      }[]
    const [before] = await list()
    expect(before).toMatchObject({ hostRunAgreedAt: null, waiting: 1 })
    await agree(server)
    const [agreed] = await list()
    expect(agreed?.hostRunAgreedAt).toEqual(expect.any(String))
    // The agreement stands outside the profile, so work pinned before it keeps its pin.
    expect(agreed?.revision).toBe(before?.revision)
    const edit = await fetch(`${server.url}/api/repositories/repo_a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_revision: agreed?.revision, trusted: true }),
    })
    expect(edit.status).toBe(200)
    expect((await list())[0]?.hostRunAgreedAt).toBe(agreed?.hostRunAgreedAt)
    await withdraw(server)
    expect((await list())[0]?.hostRunAgreedAt).toBeNull()
    expect(eventsOf(rig, 'repositories')).toEqual(
      expect.arrayContaining(['host_run_agreed', 'host_run_withdrawn']),
    )
  })

  it('a repository nobody registered has nothing to agree to', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noAttempt: true, noRow: true })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    expect((await post(server, '/api/repositories/repo_missing/host-run/agree')).status).toBe(404)
    expect((await post(server, '/api/repositories/settings%2Frepositories/host-run/agree')).status).toBe(404)
  })

  it('agreeing makes a waiting row due at once, not at its next look', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { preUpgrade: true, task: { status: 'active' } })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await until(() => rowOf(rig, 'att_1:1') === 'waiting', 60_000, 'the row waiting')
    const before = peek(rig, (store) => store.effects.snapshot('launch', 'att_1:1'))
    await agree(server)
    const after = peek(rig, (store) => store.effects.snapshot('launch', 'att_1:1'))
    if (after !== undefined) expect(after.nextRunAt < String(before?.nextRunAt)).toBe(true)
  })

  it('a withdrawal stops new launches', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { task: { status: 'active' }, slot: { state: 'degraded' } })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await withdraw(server)
    peek(rig, (store) => {
      const slot = store.slots.get('slot_a') as Record<string, unknown>
      store.atomic(() => store.slots.save({ ...slot, id: 'slot_a', state: 'healthy' }))
      store.effects.wakeDeferred(['launch'])
    })
    await settle(3000)
    expect(rig.started()).toBe(false)
    expect(attemptOf(rig)?.state).toBe('queued')
  })

  it('checks of an attempt already running wait for the owner, and run once agreed', async () => {
    const rig = scratch(SLOW_STEPS)
    const ran = join(rig.root, 'check-ran')
    seedStore(rig, {
      task: { status: 'active' },
      checks: [{ name: 'marker', cmd: `touch ${ran}` }],
    })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await reaches(rig, 'running')
    await withdraw(server)
    await until(() => attemptOf(rig)?.checks_stopped === 'host_run_unagreed', 60_000, 'the checks withheld')
    expect(existsSync(ran)).toBe(false)
    expect(rowOf(rig, 'att_1:1:recheck')).toBeDefined()
    await agree(server)
    await until(() => existsSync(ran), 60_000, 'the check running')
  })

  it('a withdrawal between two setup commands runs no further one, and setup starts over', async () => {
    const rig = scratch(STEPS)
    const first = join(rig.root, 'first')
    const second = join(rig.root, 'second')
    seedStore(rig, {
      task: { status: 'active' },
      bootstrap: [`touch ${first}`, 'sleep 1', `touch ${second}`],
    })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await until(() => existsSync(first), 60_000, 'setup starting')
    await withdraw(server)
    await until(() => rowOf(rig, 'att_1:1') === 'waiting', 60_000, 'the launch waiting')
    expect(existsSync(second)).toBe(false)
    expect(rig.started()).toBe(false)
    await agree(server)
    await until(() => rig.started(), 60_000, 'the engine starting')
    expect(existsSync(second)).toBe(true)
  })

  it('Work and Needs you say what the work waits for, and it clears on agreeing', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { preUpgrade: true, task: { status: 'active' }, slot: { state: 'degraded' } })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    const read = async <T>(path: string): Promise<T> =>
      (await (await fetch(`${server.url}${path}`, { headers: { 'x-mec-client': '1' } })).json()) as T
    type Row = { stage: { key: string; label: string; waitingOn: string }; reason: string | null }
    const rows = await read<{ items: Row[] }>('/api/inspect/work?repoId=repo_a')
    expect(rows.items[0]?.stage).toEqual({
      key: 'person/agreement',
      label: 'Waiting for your agreement',
      waitingOn: 'person',
    })
    const needs = await read<{ items: Record<string, unknown>[] }>('/api/inspect/needs')
    expect(needs.items).toEqual([
      expect.objectContaining({ kind: 'agreement', repoId: 'repo_a', status: 'open', waiting: 1 }),
    ])
    await agree(server)
    expect((await read<{ items: unknown[] }>('/api/inspect/needs')).items).toEqual([])
  })

  it('a withdrawal during a second look at a head stops its next check', async () => {
    const rig = scratch(SLOW_STEPS)
    const first = join(rig.root, 'first')
    const second = join(rig.root, 'second')
    seedStore(rig, {
      task: { status: 'active' },
      checks: [
        { name: 'first', cmd: `touch ${first}` },
        { name: 'slow', cmd: 'sleep 1' },
        { name: 'second', cmd: `touch ${second}` },
      ],
    })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await reaches(rig, 'running')
    await withdraw(server)
    await until(() => attemptOf(rig)?.checks_stopped === 'host_run_unagreed', 60_000, 'the checks withheld')
    await agree(server)
    await until(() => existsSync(first), 60_000, 'the second look starting')
    await withdraw(server)
    await until(() => rowOf(rig, 'att_1:1:recheck') === 'waiting', 60_000, 'the second look waiting')
    await settle(1500)
    expect(existsSync(second)).toBe(false)
  })

  it('a work item an agreement finds parked resumes as one new generation', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, {
      preUpgrade: true,
      noRow: true,
      attempt: parked,
      slot: { last_probe_at: '2026-11-05T10:30:00.000Z' },
    })
    const server = await serve(rig, { probeRun: PROBE_OK, brain: brainThatNeverRuns })
    await settle(2500)
    expect(attemptOf(rig)?.generation).toBe(1)
    expect(attemptOf(rig)?.resuming).toBeUndefined()
    const resumed = await post(server, `/api/work/${WORK}/resume`)
    expect(resumed.status).toBeLessThan(500)
    expect(attemptOf(rig)?.resuming).toBeUndefined()
    await agree(server)
    await until(() => rig.started(), 60_000, 'the park resuming')
    expect(attemptOf(rig)?.generation).toBe(2)
  })
})
