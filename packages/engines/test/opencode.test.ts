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
      body: { decision: native },
    })
    expect(asked[0]).toEqual({
      kind: 'shell',
      worktree: '/wt/audit-view',
      deadline: '2026-11-03T16:46:03.000Z',
    })
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
