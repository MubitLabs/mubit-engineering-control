// M2.4, §20, §26, decision #21: pause stops what goes out and what starts, and only that.
import { afterEach, describe, expect, it } from 'vitest'
import {
  attemptOf,
  brainThatNeverRuns,
  cleanUp,
  PROBE_OK,
  peek,
  type Rig,
  reaches,
  scratch,
  seedStore,
  serve,
  settle,
  until,
  WORK,
} from './recovery-rig'

afterEach(cleanUp)

const STEPS = [{ init: true }, { result: 'completed' }]

const pausedAtBoot = (rig: Rig): void => {
  peek(rig, (store) => {
    store.engines.save({ id: 'settings/processing', paused: true, pausedAt: '2026-11-05T10:00:00.000Z' })
  })
}

const rowOf = (rig: Rig, kind: 'launch' | 'deliver' | 'relay' | 'reply', key: string) =>
  peek(rig, (store) => store.effects.snapshot(kind, key))

describe('pause and attempts', { timeout: 40_000 }, () => {
  it('paused means no launch, delivery, relay or reply', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { task: { status: 'ready' } })
    pausedAtBoot(rig)
    peek(rig, (store) => {
      const input = { id: 'in_1', kind: 'message', text: 'x' }
      store.effects.enqueue('deliver', 'in_1', { attempt_id: 'att_1', input })
      store.effects.enqueue('relay', 'wake:w1', { causationId: 'w1', reason: 'r', workItemId: WORK })
      store.effects.enqueue('reply', 'r1', { text: 'out' })
    })
    await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await settle()
    expect(rig.started()).toBe(false)
    for (const [kind, key] of [
      ['launch', 'att_1:1'],
      ['deliver', 'in_1'],
      ['relay', 'wake:w1'],
      ['reply', 'r1'],
    ] as const) {
      const row = rowOf(rig, kind, key)
      expect(row?.state, `${kind} waits`).toBe('waiting')
      expect(row?.attempts, `${kind} counts no failure`).toBe(0)
    }
  })

  it('a launch a pause deferred runs soon after resume, not a pause later', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { task: { status: 'ready' } })
    pausedAtBoot(rig)
    const server = await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await until(() => rowOf(rig, 'launch', 'att_1:1')?.state === 'waiting')
    server.resume()
    await reaches(rig, 'work_complete')
  })

  it('running turn finishes and its checks record', async () => {
    const rig = scratch([{ init: true }, { sleep: 700 }, { result: 'completed' }])
    seedStore(rig, { task: { status: 'ready' }, checks: [{ name: 'unit', cmd: 'true' }] })
    const server = await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await reaches(rig, 'running')
    server.pause()
    await reaches(rig, 'succeeded')
    const check = peek(rig, (store) => store.engines.get('check/att_1/unit'))
    expect(check?.status).toBe('passed')
    expect(attemptOf(rig)?.generation).toBe(1)
  })

  it('a probe still runs while paused', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { noRow: true, slot: { state: 'degraded', state_reason: 'auth_expired' } })
    pausedAtBoot(rig)
    let probes = 0
    await serve(rig, {
      brain: brainThatNeverRuns,
      probeRun: async () => {
        probes += 1
        return { code: 0, stdout: '{"loggedIn":true}', stderr: '' }
      },
    })
    await until(() => probes > 0)
    await until(() => peek(rig, (store) => store.slots.get('slot_a')?.state) === 'healthy')
  })

  it('pause survives a restart with the launch still held back', async () => {
    const rig = scratch(STEPS)
    seedStore(rig, { task: { status: 'ready' } })
    pausedAtBoot(rig)
    const first = await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await first.close()
    const second = await serve(rig, { brain: brainThatNeverRuns, probeRun: PROBE_OK })
    await settle()
    expect(second.isPaused()).toBe(true)
    expect(rig.started()).toBe(false)
  })
})
