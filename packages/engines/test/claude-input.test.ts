// M2.2: `send` on a real process. The fake CLI models what `claude` 2.1.318 did when probed against
// a local stub of the API (docs/changes/2026-11-05-coordination/CHANGE.md): objective on stdin, a
// `command_lifecycle` line per message, one turn per message, an exit on EOF and not before.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttemptHandle, EngineEvent, Input, LaunchSpec } from '@mec/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import { ownedSpawn } from '../../runtime/src/owned-spawn'
import { Supervisor } from '../../runtime/src/supervisor'
import { ClaudeAdapter } from '../src/claude/adapter'
import { buildClaudeArgv } from '../src/claude/argv'

const FAKE_CLI = fileURLToPath(new URL('../../testkit/fake-cli/claude', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'mec-claude-input-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let dirs = 0

function launchSpec(cwd: string): LaunchSpec {
  return {
    brief: {
      attempt_id: `att_${dirs}`,
      generation: 1,
      objective: 'The objective, "verbatim".',
      env: {},
      budget: { turns: 5, wall_clock_ms: 60_000 },
      isolation: { read_only: false, permission_mode: 'bridge' },
    } as unknown as LaunchSpec['brief'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
    cwd,
    bridge: {} as LaunchSpec['bridge'],
  }
}

type Run = {
  dir: string
  adapter: ClaudeAdapter
  handle: AttemptHandle
  events: EngineEvent[]
  done: Promise<void>
  stdin: () => Record<string, unknown>[]
  closes: () => boolean
}

async function run(steps: unknown[], extra: Record<string, unknown> = {}): Promise<Run> {
  dirs += 1
  const dir = mkdtempSync(join(root, 'cli-'))
  copyFileSync(FAKE_CLI, join(dir, 'claude'))
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps, ...extra }))
  const supervisor = new Supervisor()
  const owner = { attemptId: `att_${dirs}`, generation: 1 }
  const adapter = new ClaudeAdapter({
    binary: join(dir, 'claude'),
    streamInput: true,
    spawnFn: ownedSpawn(supervisor, owner),
    inputTimeoutMs: Number(extra.inputTimeoutMs ?? 30_000),
  })
  const handle = await adapter.launch(launchSpec(dir))
  const events: EngineEvent[] = []
  const done = (async () => {
    for await (const event of adapter.events(handle)) events.push(event)
  })()
  const stdin = () =>
    readFileSync(join(dir, 'stdin.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  const closes = () => readFileSync(join(dir, 'stdin-closed'), 'utf8') === 'yes'
  return { dir, adapter, handle, events, done, stdin, closes }
}

const input = (text: string, id = 'inp_1'): Input => ({ id, kind: 'message', text })

const waitFor = async (ready: () => boolean): Promise<void> => {
  const until = Date.now() + 40_000
  while (!ready()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// A full run starts many processes at once, so a real engine process can take seconds to start.
describe('claude stream-json input (§9, §12.3)', { timeout: 60_000 }, () => {
  it('the argv asks for stream input and leaves the prompt out of it', () => {
    const argv = buildClaudeArgv({
      streamInput: true,
      sessionId: 's',
      settingsPath: '/s',
      mcpConfigPath: '/m',
      readOnly: false,
      permissionMode: 'bridge',
      maxTurns: 3,
    })
    expect(argv.slice(0, 2)).toEqual(['claude', '-p'])
    expect(argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--replay-user-messages']))
  })

  it('a one-shot launch keeps the prompt on argv and leaves stdin alone', () => {
    const argv = buildClaudeArgv({
      prompt: 'the prompt',
      sessionId: 's',
      settingsPath: '/s',
      mcpConfigPath: '/m',
      readOnly: false,
      permissionMode: 'bridge',
      maxTurns: 3,
    })
    expect(argv.slice(0, 3)).toEqual(['claude', '-p', 'the prompt'])
    expect(argv).not.toContain('--input-format')
  })

  it('the objective reaches the engine as the first stream-json user message', async () => {
    const r = await run([{ init: true }, { result: 'completed' }])
    await r.done
    expect(r.stdin()[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'The objective, "verbatim".' },
      parent_tool_use_id: null,
    })
  })

  it('send writes one stream-json user message', async () => {
    const r = await run([{ init: true }, { waitInput: 2 }, { result: 'completed' }])
    await waitFor(() => r.events.length > 0)

    await r.adapter.send(r.handle, input('Keep  the "text"\nunchanged'))
    await r.done

    const lines = r.stdin()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'Keep  the "text"\nunchanged' },
      session_id: r.handle.session_id,
    })
    expect(typeof lines[1]?.uuid).toBe('string')
  })

  it('a follow-up keeps its text and names its ids in a second block', async () => {
    const r = await run([{ init: true }, { waitInput: 2 }, { result: 'completed' }])
    await waitFor(() => r.events.length > 0)

    const text = 'Keep  the "text"\nunchanged'
    await r.adapter.send(r.handle, { ...input(text, 'inp_7'), message_id: 'msg_7' })
    await r.done

    const message = r.stdin()[1]?.message as { content: { type: string; text: string }[] }
    expect(message.content).toHaveLength(2)
    expect(message.content[0]).toEqual({ type: 'text', text })
    expect(message.content[1]?.type).toBe('text')
    expect(message.content[1]?.text).toContain('input id inp_7')
    expect(message.content[1]?.text).toContain('message id msg_7')
    expect(message.content[1]?.text).toContain('handled_inputs')
    expect(message.content[1]?.text).toContain('mcp__mec__handback')
  })

  it('an input with no message has nothing to hand back, so it stays plain text', async () => {
    const r = await run([{ init: true }, { waitInput: 2 }, { result: 'completed' }])
    await waitFor(() => r.events.length > 0)
    await r.adapter.send(r.handle, { id: 'inp_8', kind: 'note', text: 'Your card was approved.' })
    await r.done
    expect(r.stdin()[1]?.message).toEqual({ role: 'user', content: 'Your card was approved.' })
  })

  it('process exits after stdin closes', async () => {
    const r = await run([{ init: true }, { result: 'completed' }, { waitEof: true }])
    await r.done
    expect(r.closes()).toBe(true)
    expect(r.events.at(-1)).toMatchObject({ type: 'exit', code: 0, terminal_reason: 'completed' })
  })

  it('stdin stays open past the first result while a follow-up is queued', async () => {
    const r = await run([{ init: true }, { waitInput: 2 }, { result: 'completed' }])
    await waitFor(() => r.events.length > 0)
    await r.adapter.send(r.handle, input('second'))
    await r.done

    expect(r.stdin()).toHaveLength(2)
    const usage = r.events.filter((event) => event.type === 'usage')
    expect(usage).toHaveLength(2)
    expect(r.events.filter((event) => event.type === 'session_started')).toHaveLength(1)
    expect(r.events.at(-1)).toMatchObject({ type: 'exit', code: 0 })
  })

  it('a send resolves only when the engine took it, not when the write returned', async () => {
    const r = await run([
      { init: true },
      { deaf: true },
      { waitInput: 2 },
      { hold: 400 },
      { result: 'completed' },
    ])
    await waitFor(() => r.events.length > 0)
    let settled = false
    const sent = r.adapter.send(r.handle, input('heard later')).then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false)
    await sent
    await r.done
  })

  it('a send the engine never takes fails by name, within the bound', async () => {
    const r = await run([{ init: true }, { silent: true }, { forever: true }], { inputTimeoutMs: 300 })
    await waitFor(() => r.events.length > 0)
    await expect(r.adapter.send(r.handle, input('lost'))).rejects.toThrow(/did not take/)
    await r.adapter.stop(r.handle)
    await r.done
  })

  it('a send after the last turn ended fails: its input is closed', async () => {
    const r = await run([{ init: true }, { result: 'completed' }, { waitEof: true }])
    await r.done
    await expect(r.adapter.send(r.handle, input('too late'))).rejects.toThrow(/closed/)
  })

  it('reads an input only when the turn that carried it finished', async () => {
    const r = await run([{ init: true }, { waitInput: 2 }, { result: 'completed' }, { hold: 200 }])
    await waitFor(() => r.events.length > 0)
    await r.adapter.send(r.handle, input('second'))
    const usageAtSend = r.events.filter((event) => event.type === 'usage').length
    expect(usageAtSend).toBe(0)

    await r.adapter.inputFinished(r.handle, 'inp_1')
    expect(r.events.filter((event) => event.type === 'usage').length).toBe(2)
    await r.done
  })

  it('without lifecycle lines, the replay and a result still say the same', async () => {
    const steps = [{ init: true }, { waitInput: 2 }, { hold: 300 }, { result: 'completed' }]
    const r = await run(steps, { noLifecycle: true })
    await waitFor(() => r.events.length > 0)
    const sent = r.adapter.send(r.handle, input('second'))
    await sent
    await r.adapter.inputFinished(r.handle, 'inp_1')
    await r.done
    expect(r.events.at(-1)).toMatchObject({ type: 'exit', code: 0 })
  })

  it('an error result closes stdin: the engine cannot go on', async () => {
    const r = await run([{ init: true }, { result: 'max_turns' }, { waitEof: true }])
    await r.done
    expect(r.events.at(-1)).toMatchObject({ type: 'exit', terminal_reason: 'max_turns' })
  })

  it('a one-shot launch closes stdin at once, so the engine does not wait for it', async () => {
    const seen: string[] = []
    const adapter = new ClaudeAdapter({
      spawnFn: () => ({
        pid: 1,
        stdout: [] as never,
        exited: Promise.resolve(0),
        kill: () => {},
        stdin: { write: (text) => seen.push(`write ${text}`), end: () => seen.push('end') },
      }),
    })
    await adapter.launch(launchSpec(root))
    expect(seen).toEqual(['end'])
  })

  it('a stream launch keeps stdin open after the objective', async () => {
    const seen: string[] = []
    const adapter = new ClaudeAdapter({
      streamInput: true,
      spawnFn: () => ({
        pid: 1,
        stdout: [] as never,
        exited: new Promise(() => {}),
        kill: () => {},
        stdin: { write: () => seen.push('write'), end: () => seen.push('end') },
      }),
    })
    await adapter.launch(launchSpec(root))
    expect(seen).toEqual(['write'])
  })

  it('a planner launch with no stream input takes no send', async () => {
    const adapter = new ClaudeAdapter({
      spawnFn: () => ({ pid: 1, stdout: [] as never, exited: Promise.resolve(0), kill: () => {} }),
    })
    const handle = await adapter.launch(launchSpec(root))
    await expect(adapter.send(handle, input('x'))).rejects.toThrow(/stream input/)
  })
})
