import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaunchSpec, PermissionBridge, SlotRef } from '@mec/contracts'
import { checkEventStream } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { OpenCodeAdapter } from '../src/opencode/adapter'
import { classifyOpencodeError, OPENCODE_ENGINE_VERSION, parseOpenCodeEvents } from '../src/opencode/protocol'

/**
 * CONTRACTS §9 conformance, engine side: the adapter's SSE parser, run over each
 * fixture raw stream, must yield exactly the fixture's normalised events.
 * smoke and auth_expired are recorded_by 'real' — captured from a live
 * `opencode serve --stdio` 2.2.5 (R2.2, slot glm-2 on the z.ai Coding Plan);
 * rate_limit_rejected and permission_request stay synthetic in the real envelope
 * (see each meta.json). NOW matches the fixtures' recorded_at second so
 * rate-limit `resets_at` arithmetic reproduces exactly.
 */
const ROOT = fileURLToPath(new URL('../../testkit/fixtures/opencode/2.2.5', import.meta.url))
const NOW = '2026-11-03T16:41:03.000Z'
const SCENARIOS = ['smoke', 'permission_request', 'rate_limit_rejected', 'auth_expired'] as const

describe('opencode stream conformance (real + synthetic fixtures)', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario}: parseOpenCodeEvents(raw) === events.jsonl`, () => {
      const rawLines = readFileSync(join(ROOT, scenario, 'raw.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
      const expected = readFileSync(join(ROOT, scenario, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const parsed = parseOpenCodeEvents(rawLines, NOW)
      expect(parsed).toHaveLength(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(parsed[i]).toEqual(expected[i])
      }
    })
  }

  it('meta.json expected blocks match what the parser actually produces', () => {
    for (const scenario of SCENARIOS) {
      const meta = JSON.parse(readFileSync(join(ROOT, scenario, 'meta.json'), 'utf8')) as {
        expected: { permission_requests: number; rate_limits: string[]; exit: string }
      }
      const events = parseOpenCodeEvents(
        readFileSync(join(ROOT, scenario, 'raw.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean),
        NOW,
      )
      expect(events.filter((e) => e.type === 'permission_request').length, scenario).toBe(
        meta.expected.permission_requests,
      )
      expect(
        events.filter((e) => e.type === 'rate_limit').map((e) => (e as { window: string }).window),
        scenario,
      ).toEqual(meta.expected.rate_limits)
      const exit = events.find((e) => e.type === 'exit')
      expect(exit && exit.type === 'exit' ? exit.terminal_reason : 'none', scenario).toBe(meta.expected.exit)
    }
  })

  it('the CONTRACTS §1 invariants hold for every fixture', () => {
    for (const scenario of SCENARIOS) {
      const events = readFileSync(join(ROOT, scenario, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      expect(checkEventStream(events), scenario).toEqual([])
    }
  })
})

const spec = (
  over: { bridge?: PermissionBridge; read_only?: boolean; resume?: { session_id: string } } = {},
): LaunchSpec => ({
  brief: {
    attempt_id: 'att_op1',
    generation: 0,
    task_id: 'task_audit',
    work_item_id: 'wi_audit',
    role: { name: 'implementer', revision: 'rev1' },
    engine: 'opencode',
    slot_id: 'slot_glm1',
    worktree: '/wt/audit-view',
    base_sha: '0123456789abcdef0123456789abcdef01234567',
    branch: 'mec/wi_audit/task_audit/a1',
    origin: { messages: [{ id: 'msg_1', text: 'Add the audit log view' }] },
    objective: 'Add the audit log view',
    owned_paths: ['src/audit/**'],
    acceptance_checks: ['pnpm -w test'],
    budget: { turns: 12, wall_clock_ms: 1_800_000 },
    bundle_revision: 'rev1',
    tools: { url: 'http://127.0.0.1:4319', token: 'tok_attempt' },
    env: {},
    isolation: {
      sandbox: 'off',
      read_only: over.read_only ?? false,
      allow_write: ['/wt/audit-view'],
      deny_read: [],
      allowed_domains: [],
      blocked_commands: [],
      background_cap_ms: 1_800_000,
      permission_mode: 'bridge',
      repo_trusted: false,
    },
  },
  env: {},
  cwd: '/wt/audit-view',
  resume: over.resume,
  bridge: over.bridge ?? { request: async () => 'deny' },
})

type Post = { path: string; body?: unknown }

const recordingPost = (posts: Post[], id = 'ses_t1') => {
  const adapter = new OpenCodeAdapter({
    post: async (path, body) => {
      posts.push({ path, body })
      // the real 2.2.5 response envelope: {data: {id}}
      return { data: { id } }
    },
  })
  return adapter
}

describe('OpenCodeAdapter', () => {
  it('launch posts /api/session with directory, build agent and the bridge ask ruleset', async () => {
    const posts: Post[] = []
    const handle = await recordingPost(posts).launch(spec())
    expect(handle).toMatchObject({ attempt_id: 'att_op1', generation: 0, session_id: 'ses_t1' })
    expect(posts[0]?.path).toBe('/api/session')
    expect(posts[0]?.body).toEqual({
      location: { directory: '/wt/audit-view' },
      agent: 'build',
      model: undefined,
      permissions: [{ action: 'bash', resource: '*', effect: 'ask' }],
    })
  })

  it('deps.defaultModel (the slot provider profile, plan §5.7) rides every fresh create', async () => {
    const posts: Post[] = []
    const adapter = new OpenCodeAdapter({
      post: async (path, body) => {
        posts.push({ path, body })
        return { data: { id: 'ses_t3' } }
      },
      defaultModel: { id: 'glm-4.7', providerID: 'zai-coding' },
    })
    await adapter.launch(spec())
    expect(posts[0]?.body).toMatchObject({ model: { id: 'glm-4.7', providerID: 'zai-coding' } })
    await adapter.launch(spec({ resume: { session_id: 'ses_t9' } }))
    expect(posts).toHaveLength(1) // resume never creates
  })

  it('read-only roles select the plan agent; resume reuses the session without a new POST', async () => {
    const posts: Post[] = []
    const adapter = recordingPost(posts)
    await adapter.launch(spec({ read_only: true }))
    expect(posts[0]?.body).toMatchObject({
      location: { directory: '/wt/audit-view' },
      agent: 'plan', // the real read-only agent id on 2.2.5
    })
    const resumed = await adapter.launch(spec({ resume: { session_id: 'ses_t9' } }))
    expect(resumed.session_id).toBe('ses_t9')
    expect(posts).toHaveLength(1)
  })

  it('send posts the prompt text; interrupt posts /interrupt', async () => {
    const posts: Post[] = []
    const adapter = recordingPost(posts, 'ses_t2')
    const handle = await adapter.launch(spec())
    await adapter.send(handle, { id: 'inp_1', kind: 'message', text: 'fix the failing test' })
    await adapter.interrupt(handle)
    expect(posts[1]).toEqual({ path: '/api/session/ses_t2/prompt', body: { text: 'fix the failing test' } })
    expect(posts[2]).toEqual({ path: '/api/session/ses_t2/interrupt', body: undefined })
  })
})

describe('OpenCodeAdapter permission bridge', () => {
  const rawLines = () => readFileSync(join(ROOT, 'permission_request', 'raw.jsonl'), 'utf8').split('\n')

  it.each([
    ['allow', 'once'],
    ['deny', 'reject'],
    ['expired', 'reject'],
  ] as const)('bridge decision %s posts the native reply %s', async (decision, native) => {
    const posts: Post[] = []
    const asked: Array<{ kind: string; worktree: string; deadline: string }> = []
    const bridge: PermissionBridge = {
      request: async (_attempt, operation, evidence, deadline) => {
        asked.push({ kind: operation.kind, worktree: evidence.worktree, deadline })
        return decision
      },
    }
    const adapter = new OpenCodeAdapter({
      post: async (path, body) => {
        posts.push({ path, body })
        return { data: { id: 'ses_syn_perm1' } }
      },
      sse: async function* () {
        for (const line of rawLines()) yield line
      },
      now: () => NOW,
    })
    const handle = await adapter.launch(spec({ bridge }))

    const events = []
    for await (const event of adapter.events(handle)) events.push(event)

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'permission_request',
      'permission_result', // synthesised by the adapter after its reply post
      'tool_call',
      'usage',
      'exit',
    ])
    expect(events[1]).toMatchObject({
      seq: 2,
      at: NOW,
      attempt_id: 'att_op1',
      generation: 0,
      request_id: 'perm_syn_01',
      // action 'shell' + resources carrying the command → a shell-kind operation
      operation: { kind: 'shell', summary: 'shell git log --oneline -5' },
      evidence: { worktree: '/wt/audit-view' },
    })
    const toolCall = events.find((event) => event.type === 'tool_call')
    expect(toolCall).toMatchObject({
      tool: 'shell',
      input: { command: 'git log --oneline -5' },
      ok: true,
    })
    expect(posts[1]).toEqual({
      path: '/api/session/ses_syn_perm1/permission/perm_syn_01/reply',
      body:
        native === 'once'
          ? { decision: native }
          : {
              decision: native,
              message: 'MEC refused this. Carry on without it, and say so in your report.',
            },
    })
    expect(asked[0]).toEqual({
      kind: 'shell',
      worktree: '/wt/audit-view',
      deadline: '2026-11-03T16:46:03.000Z',
    })
  })
})

describe('OpenCodeAdapter through connect', () => {
  const line = (type: string, data: unknown) => `data: ${JSON.stringify({ id: 'e', type, data })}`

  const connected = (sent: unknown[], lines: string[], decision: 'allow' | 'deny' = 'allow') => {
    const asked: unknown[] = []
    const adapter = new OpenCodeAdapter({
      connect: async () => ({
        post: async (path, body) => {
          sent.push({ path, body })
          return { data: { id: 'ses_1' } }
        },
        sse: async function* () {
          for (const each of lines) yield each
        },
        ready: async () => {},
      }),
    })
    const launched = adapter.launch(
      spec({
        bridge: {
          request: async (_attempt, operation) => {
            asked.push(operation)
            return decision
          },
        },
      }),
    )
    return { adapter, launched, asked }
  }

  it('sends the brief as the first prompt, and send stays unsupported', async () => {
    const sent: { path: string; body?: unknown }[] = []
    const { adapter, launched } = connected(sent, [])
    const handle = await launched
    expect(sent.at(-1)).toMatchObject({
      path: '/api/session/ses_1/prompt',
      body: { text: 'Add the audit log view' },
    })
    await expect(adapter.send(handle, { id: 'inp_1', kind: 'message', text: 'more' })).rejects.toThrow(
      'send is not proven',
    )
  })

  it('an edit reaches the decider as a real path, whichever way the engine spelled it', async () => {
    const sent: unknown[] = []
    const ask = (id: string, resource: string) =>
      line('permission.asked', { id, action: 'edit', resources: [resource], source: { id: 'write' } })
    const { adapter, launched, asked } = connected(sent, [
      ask('per_1', 'src/a.ts'),
      ask('per_2', '/elsewhere/b.ts'),
    ])
    const handle = await launched
    for await (const _ of adapter.events(handle)) {
      // drained for the asks
    }
    expect(asked).toMatchObject([
      { kind: 'edit', paths: ['/wt/audit-view/src/a.ts'] },
      { kind: 'edit', paths: ['/elsewhere/b.ts'] },
    ])
  })
})

describe('OpenCodeAdapter stream', () => {
  const line = (type: string, data: unknown) => `data: ${JSON.stringify({ id: 'e', type, data })}`
  const ask = (id: string) => line('permission.asked', { id, action: 'shell', resources: ['ls'] })
  const SESSION = line('session.created', { sessionID: 'ses_1', model: {} })
  const DONE = line('session.execution.succeeded', {})

  const adapterOver = (post: (path: string) => Promise<unknown>, lines: () => AsyncIterable<string>) =>
    new OpenCodeAdapter({
      connect: async () => ({ post, sse: lines, ready: async () => {} }),
    })

  it('hands each event over as it arrives, not when the stream ends', async () => {
    let speak: () => void = () => {}
    const spoken = new Promise<void>((resolve) => {
      speak = resolve
    })
    const adapter = adapterOver(
      async () => ({ data: { id: 'ses_1' } }),
      async function* () {
        yield SESSION
        await spoken
        yield line('session.text.ended', { text: 'still working' })
        await new Promise(() => {}) // the stream stays open, as it does through a long turn
      },
    )
    const events = adapter.events(await adapter.launch(spec({})))[Symbol.asyncIterator]()
    await expect(events.next()).resolves.toMatchObject({ value: { type: 'session_started' } })
    speak()
    const second = await Promise.race([
      events.next(),
      new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 2000)),
    ])
    expect(second).toMatchObject({ value: { type: 'message', text: 'still working' } })
  })

  it('a 404 on a reply means the engine settled that ask: nothing ran, and the stream reads on', async () => {
    const adapter = adapterOver(
      async (path) => {
        if (path.endsWith('per_2/reply')) throw new Error(`opencode ${path} answered 404: {}`)
        return { data: { id: 'ses_1' } }
      },
      async function* () {
        yield SESSION
        yield ask('per_1')
        yield ask('per_2')
        yield DONE
      },
    )
    const decisions = ['deny', 'allow'] as const
    let next = 0
    const bridge: PermissionBridge = { request: async () => decisions[next++] ?? 'deny' }
    const events = []
    for await (const event of adapter.events(await adapter.launch(spec({ bridge })))) events.push(event)
    expect(
      events.flatMap((event) =>
        event.type === 'permission_result' ? [[event.request_id, event.decision]] : [],
      ),
    ).toEqual([
      ['per_1', 'deny'],
      ['per_2', 'deny'],
    ])
    expect(events.at(-1)).toMatchObject({ type: 'exit', terminal_reason: 'completed' })
  })

  it('any other failure ends the stream and says why, as the last thing before the exit', async () => {
    const adapter = adapterOver(
      async (path) => {
        if (path.endsWith('/reply')) throw new Error(`opencode ${path} answered 500: boom`)
        return { data: { id: 'ses_1' } }
      },
      async function* () {
        yield SESSION
        yield ask('per_1')
        yield DONE
      },
    )
    const events = []
    for await (const event of adapter.events(await adapter.launch(spec({})))) events.push(event)
    expect(events.at(-2)).toMatchObject({ type: 'error', class: 'engine_bug' })
    expect(JSON.stringify(events.at(-2))).toContain('answered 500: boom')
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 1, terminal_reason: 'crashed' })
  })
})

describe('classifyOpencodeError', () => {
  it('maps the real 2.2.5 provider error shapes', () => {
    // real z.ai coding-endpoint auth failure (see the auth_expired fixture)
    expect(
      classifyOpencodeError({
        type: 'provider.auth',
        message: '身份验证失败。',
        status: 401,
        response: { body: '{"error":{"code":"1000","message":"身份验证失败。"}}' },
      }),
    ).toBe('auth')
    // Google 429 nested inside response.body
    expect(
      classifyOpencodeError({
        type: 'provider.rateLimit',
        status: 429,
        response: {
          body: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Resource has been exhausted (e.g. check quota)."}}',
        },
      }),
    ).toBe('quota')
    // REAL z.ai coding-plan 429 body (R2.6 deliberate burst, 3 Nov 2026 — captured
    // verbatim in testkit/fixtures/providers/zai-coding-plan/429.json): HTTP 429 with
    // z.ai's own code 1302 inside; classified by status before the body matters.
    {
      const realBody = readFileSync(
        join(
          fileURLToPath(
            new URL('../../testkit/fixtures/providers/zai-coding-plan/429.json', import.meta.url),
          ),
        ),
        'utf8',
      ).trim()
      expect(
        classifyOpencodeError({
          type: 'provider.rateLimit',
          status: 429,
          response: { body: realBody },
        }),
      ).toBe('quota')
    }
    expect(classifyOpencodeError('401 Unauthorized: API key not valid. Please pass a valid API key.')).toBe(
      'auth',
    )
    expect(
      classifyOpencodeError({
        type: 'provider.unavailable',
        status: 503,
        message: 'The model is overloaded.',
      }),
    ).toBe('provider_down')
    expect(classifyOpencodeError('something odd happened')).toBe('unknown')
  })
})

describe('OpenCodeAdapter.probe', () => {
  const slot: SlotRef = {
    id: 'slot_glm1',
    engine: 'opencode',
    kind: 'opencode-glm',
    home: '/engines/opencode/glm-1',
    credential_kind: 'api_key',
  }

  it('auth list [] → not logged in', async () => {
    const adapter = new OpenCodeAdapter({ authList: async () => ({ code: 0, stdout: '[]\n', stderr: '' }) })
    const { auth } = await adapter.probe(slot)
    expect(auth.logged_in).toBe(false)
  })

  it('non-empty auth list → logged in; capabilities target the 2.2.5 protocol', async () => {
    const adapter = new OpenCodeAdapter({
      authList: async () => ({
        code: 0,
        stdout: '[{"type":"zai-coding-plan","api":true},{"type":"google","api":true}]',
        stderr: '',
      }),
    })
    const { auth, capabilities } = await adapter.probe(slot)
    expect(auth).toEqual({ logged_in: true, method: 'zai-coding-plan', detail: 'zai-coding-plan, google' })
    expect(capabilities.engine_version).toBe('2.2.5')
    expect(capabilities.engine_version).toBe(OPENCODE_ENGINE_VERSION)
    expect(capabilities.usage_mode).toBe('cumulative')
    expect(capabilities.tool_approval).toBe(true)
    expect(capabilities.sandbox).toBe(false)
  })
})
