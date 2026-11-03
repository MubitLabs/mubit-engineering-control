import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttemptBrief, AttemptHandle, EngineEvent, LaunchSpec, SlotRef } from '@mec/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeEngine } from '../src/index'

const smokeDir = fileURLToPath(new URL('../fixtures/claude/2.1.317/smoke', import.meta.url))
const crashMidTurnDir = fileURLToPath(new URL('../fixtures/claude/2.1.317/crash_mid_turn', import.meta.url))

const slotRef: SlotRef = {
  id: 'slot_1',
  engine: 'claude',
  kind: 'claude-sub',
  home: '/tmp/mec/homes/claude-1',
  credential_kind: 'oauth',
}

const brief: AttemptBrief = {
  attempt_id: 'att_smoke',
  generation: 0,
  task_id: 'task_1',
  work_item_id: 'wi_1',
  role: { name: 'implementer', revision: 'r1' },
  engine: 'claude',
  slot_id: 'slot_1',
  worktree: '/tmp/mec/worktrees/wi-1',
  base_sha: 'a29b03c9c1e6d2f4a5b6c7d8e9f0a1b2c3d4e5f6',
  branch: 'mec/wi-1',
  origin: { messages: [{ id: 'msg_1', text: 'run the smoke fixture' }] },
  objective: 'replay the recorded smoke scenario',
  owned_paths: ['src/'],
  acceptance_checks: ['pnpm test'],
  budget: { turns: 8, wall_clock_ms: 60_000 },
  bundle_revision: 'r1',
  tools: { url: 'http://127.0.0.1:8090', token: 'tok_fixture' },
  env: {},
  isolation: {
    sandbox: 'off',
    read_only: false,
    allow_write: ['/tmp/mec/worktrees/wi-1'],
    deny_read: [],
    allowed_domains: [],
    blocked_commands: [],
    background_cap_ms: 5_000,
    permission_mode: 'none',
    repo_trusted: true,
  },
}

const launchSpec: LaunchSpec = {
  brief,
  env: {},
  cwd: '/tmp/mec/worktrees/wi-1',
  bridge: { request: async () => 'allow' },
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

const collect = async (engine: FakeEngine, handle: AttemptHandle) => {
  const events: EngineEvent[] = []
  for await (const event of engine.events(handle)) events.push(event)
  return events
}

describe('FakeEngine', () => {
  it('launch records the spec and takes the session id from the first session_started', async () => {
    const engine = new FakeEngine(smokeDir)
    const handle = await engine.launch(launchSpec)
    expect(engine.launches).toHaveLength(1)
    expect(engine.launches[0]?.brief.attempt_id).toBe('att_smoke')
    expect(handle.attempt_id).toBe('att_smoke')
    expect(handle.generation).toBe(0)
    expect(handle.session_id).toBe('f5fdd8dd-5fb7-49ed-80cb-9eec8412c6e3')
  })

  it('replays the smoke fixture with an envelope: first session_started, last exit, seq 1..n', async () => {
    const engine = new FakeEngine(smokeDir, { at: '2026-11-03T12:00:00.000Z' })
    const handle = await engine.launch(launchSpec)
    const events = await collect(engine, handle)

    expect(events.length).toBeGreaterThanOrEqual(5)
    expect(events[0]?.type).toBe('session_started')
    expect(events.at(-1)?.type).toBe('exit')
    expect(events.map((event) => event.seq)).toEqual([...events.keys()].map((index) => index + 1))
    for (const event of events) {
      expect(event.attempt_id).toBe('att_smoke')
      expect(event.generation).toBe(0)
      expect(event.at).toBe('2026-11-03T12:00:00.000Z')
    }
    const first = events[0]
    if (first?.type !== 'session_started') throw new Error('first event must be session_started')
    expect(first.session_id).toBe(handle.session_id)
  })

  it('probe reflects meta.json: capabilities parsed from meta and the event bodies', async () => {
    const engine = new FakeEngine(smokeDir)
    const { capabilities, auth } = await engine.probe(slotRef)
    expect(auth).toEqual({ logged_in: true })
    expect(capabilities.engine_version).toBe('2.1.317')
    expect(capabilities.structured_stream).toBe(true)
    expect(capabilities.resume).toBe(false)
    expect(capabilities.usage).toBe(true)
    expect(capabilities.usage_mode).toBe('cumulative')
    expect(capabilities.rate_limit_events).toBe(true)
    expect(capabilities.questions).toBe(false)
    expect(capabilities.tool_approval).toBe(false)
    expect(capabilities.interrupt).toBe(false)
    expect(capabilities.sandbox).toBe(false)
    expect(capabilities.restricted_mode).toBe(false)
    expect(capabilities.mcp_http).toBe(false)
  })

  it('probe reports no usage when the fixture has no usage event', async () => {
    const engine = new FakeEngine(crashMidTurnDir)
    const { capabilities } = await engine.probe(slotRef)
    expect(capabilities.usage).toBe(false)
    expect(capabilities.usage_mode).toBe('none')
    expect(capabilities.rate_limit_events).toBe(false)
  })

  it('a stop flag set before iteration ends the stream immediately', async () => {
    const engine = new FakeEngine(smokeDir)
    const handle = await engine.launch(launchSpec)
    await engine.stop(handle)
    expect(await collect(engine, handle)).toEqual([])
  })

  it('interrupting mid-iteration ends the stream before the next yield', async () => {
    const engine = new FakeEngine(smokeDir)
    const handle = await engine.launch(launchSpec)
    const events = []
    for await (const event of engine.events(handle)) {
      events.push(event)
      if (event.type === 'message') await engine.interrupt(handle)
    }
    expect(events.map((event) => event.type)).toEqual(['session_started', 'message'])
  })

  it('send records the input without changing the replay', async () => {
    const engine = new FakeEngine(smokeDir)
    const handle = await engine.launch(launchSpec)
    await engine.send(handle, { id: 'inp_1', kind: 'message', text: 'hello', message_id: 'msg_1' })
    expect(engine.sent).toEqual([{ id: 'inp_1', kind: 'message', text: 'hello', message_id: 'msg_1' }])
    expect((await collect(engine, handle)).length).toBe(6)
  })

  it('classifies errors by message text', () => {
    const engine = new FakeEngine(smokeDir)
    expect(engine.classify(new Error('authentication expired'))).toBe('auth')
    expect(engine.classify(new Error('quota exceeded in the five_hour window'))).toBe('quota')
    expect(engine.classify(new Error('rate limit hit'))).toBe('quota')
    expect(engine.classify(new Error('provider unreachable'))).toBe('provider_down')
    expect(engine.classify(new Error('something broke'))).toBe('unknown')
    expect(engine.classify('not even an error')).toBe('unknown')
  })

  it('mapReport reports readiness without head_sha or checks when meta carries none', () => {
    const engine = new FakeEngine(smokeDir)
    expect(engine.mapReport({ subtype: 'success' })).toEqual({
      kind: 'ready',
      summary: 'fixture replay complete',
    })
  })

  it('mapReport echoes head_sha and checks_run from meta.expected when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mec-fixture-'))
    tempDirs.push(dir)
    const headSha = 'b29b03c9c1e6d2f4a5b6c7d8e9f0a1b2c3d4e5f6'
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        engine: 'claude',
        engine_version: '0.0.0-test',
        scenario: 'smoke',
        recorded_at: '2026-11-03T00:00:00.000Z',
        recorded_by: 'fake',
        redacted: true,
        expected: {
          reports: [],
          permission_requests: 0,
          rate_limits: [],
          exit: 'completed',
          head_sha: headSha,
          checks_run: ['pnpm', 'test'],
        },
      }),
    )
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        '{"type": "session_started", "session_id": "s1", "engine": "claude", "engine_version": "0.0.0-test"}',
        '{"type": "exit", "code": 0, "terminal_reason": "completed"}',
        '',
      ].join('\n'),
    )
    const engine = new FakeEngine(dir)
    expect(engine.mapReport(undefined)).toEqual({
      kind: 'ready',
      summary: 'fixture replay complete',
      head_sha: headSha,
      checks_run: ['pnpm', 'test'],
    })
  })
})
