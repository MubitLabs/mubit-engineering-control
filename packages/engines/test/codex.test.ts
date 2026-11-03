import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaunchSpec, PermissionBridge, SlotRef } from '@mec/contracts'
import { checkEventStream } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/codex/adapter'
import { CODEX_ENGINE_VERSION, classifyCodexError, parseCodexEvents } from '../src/codex/protocol'

/**
 * CONTRACTS §9 conformance, engine side: the adapter's notification parser, run over each
 * synthetic raw stream, must yield exactly the fixture's normalised events. The fixtures are
 * recorded_by 'fake' — synthesised from the documented app-server protocol (plan §9), never
 * from a real `codex` binary (no codex login exists on this machine).
 */
const ROOT = fileURLToPath(new URL('../../testkit/fixtures/codex/0.148.0', import.meta.url))
const NOW = '2026-11-03T15:18:57.000Z'
const SCENARIOS = ['smoke', 'permission_request', 'rate_limit_rejected', 'auth_expired'] as const

describe('codex stream conformance (synthetic fixtures)', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario}: parseCodexEvents(raw) === events.jsonl`, () => {
      const rawLines = readFileSync(join(ROOT, scenario, 'raw.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
      const expected = readFileSync(join(ROOT, scenario, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const parsed = parseCodexEvents(rawLines)
      expect(parsed).toHaveLength(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(parsed[i]).toEqual(expected[i])
      }
    })
  }

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
    attempt_id: 'att_cx1',
    generation: 0,
    task_id: 'task_audit',
    work_item_id: 'wi_audit',
    role: { name: 'implementer', revision: 'rev1' },
    engine: 'codex',
    slot_id: 'slot_c1',
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
      sandbox: 'required',
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

const recordingAdapter = (posts: unknown[], threadId = 'th_t1') =>
  new CodexAdapter({
    post: async (payload) => {
      posts.push(payload)
      const { method, params } = payload as { method?: string; params?: { threadId?: string } }
      if (method === 'thread/start') return { threadId }
      if (method === 'thread/resume') return { threadId: params?.threadId ?? threadId }
      return {}
    },
  })

describe('CodexAdapter launch/send/interrupt', () => {
  it('launch posts initialize then thread/start with the read-only sandbox and approval policy', async () => {
    const posts: unknown[] = []
    const handle = await recordingAdapter(posts).launch(spec({ read_only: true }))
    expect(handle).toMatchObject({ attempt_id: 'att_cx1', generation: 0, session_id: 'th_t1' })
    expect(posts[0]).toMatchObject({ method: 'initialize' })
    expect(posts[1]).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'thread/start',
      params: { cwd: '/wt/audit-view', sandbox: 'read-only', approvalPolicy: 'never' },
    })
  })

  it('write briefs get workspace-write with approvals on request; resume posts thread/resume', async () => {
    const posts: unknown[] = []
    const adapter = recordingAdapter(posts)
    await adapter.launch(spec())
    expect(posts[1]).toMatchObject({
      method: 'thread/start',
      params: { cwd: '/wt/audit-view', sandbox: 'workspace-write', approvalPolicy: 'on-request' },
    })
    const resumed = await adapter.launch(spec({ resume: { session_id: 'th_t9' } }))
    expect(resumed.session_id).toBe('th_t9')
    expect(posts[3]).toMatchObject({ method: 'thread/resume', params: { threadId: 'th_t9' } })
  })

  it('send posts turn/start, then turn/steer while the turn is open; interrupt posts turn/interrupt', async () => {
    const posts: unknown[] = []
    const adapter = recordingAdapter(posts)
    const handle = await adapter.launch(spec())
    await adapter.send(handle, { id: 'inp_1', kind: 'message', text: 'fix the failing test' })
    await adapter.send(handle, { id: 'inp_2', kind: 'note', text: 'also check the schema' })
    await adapter.interrupt(handle)
    expect(posts[2]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'turn/start',
      params: { prompt: 'fix the failing test' },
    })
    expect(posts[3]).toEqual({
      jsonrpc: '2.0',
      id: 4,
      method: 'turn/steer',
      params: { prompt: 'also check the schema' },
    })
    expect(posts[4]).toMatchObject({ method: 'turn/interrupt' })
  })
})

describe('CodexAdapter permission bridge', () => {
  // The server stream carries only notifications; the answer line the fixture records is what
  // the adapter itself sends, so it is stripped before the stream is replayed.
  const rawLines = () =>
    readFileSync(join(ROOT, 'permission_request', 'raw.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('{"result"'))

  it.each([
    ['allow', 'accept', 'allow'],
    ['deny', 'decline', 'deny'],
    ['expired', 'decline', 'deny'],
  ] as const)('bridge decision %s posts %s and emits the mapped result', async (decision, native, mapped) => {
    const posts: unknown[] = []
    const asked: Array<{ kind: string; worktree: string; deadline: string }> = []
    const bridge: PermissionBridge = {
      request: async (_attempt, operation, evidence, deadline) => {
        asked.push({ kind: operation.kind, worktree: evidence.worktree, deadline })
        return decision
      },
    }
    const adapter = new CodexAdapter({
      post: async (payload) => {
        posts.push(payload)
        const method = (payload as { method?: string }).method
        return method === 'thread/start' ? { threadId: 'th_perm_01' } : {}
      },
      notifications: async function* () {
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
      'permission_result',
      'usage',
      'exit',
    ])
    expect(events[1]).toMatchObject({
      seq: 2,
      at: NOW,
      attempt_id: 'att_cx1',
      generation: 0,
      request_id: 'req_01',
      operation: { kind: 'shell', summary: 'npm test', command: ['npm', 'test'] },
      evidence: { worktree: '/wt/audit-view' },
    })
    expect(events[2]).toMatchObject({ request_id: 'req_01', decision: mapped })
    expect(posts[2]).toEqual({ result: { id: 'req_01', decision: native } })
    expect(asked[0]).toEqual({
      kind: 'shell',
      worktree: '/wt/audit-view',
      deadline: '2026-11-03T15:23:57.000Z',
    })
  })
})

describe('classifyCodexError', () => {
  it('maps the documented failure shapes', () => {
    expect(classifyCodexError("usage limit reached: You've hit the plan's rate limit")).toBe('quota')
    expect(classifyCodexError('Not logged in: run codex login to sign in')).toBe('auth')
    expect(classifyCodexError('stream error: upstream overloaded (HTTP 5xx), request timeout')).toBe(
      'provider_down',
    )
    expect(classifyCodexError('something odd happened')).toBe('unknown')
  })
})

describe('CodexAdapter.probe', () => {
  const slot: SlotRef = {
    id: 'slot_c1',
    engine: 'codex',
    kind: 'codex-sub',
    home: '/engines/codex/codex-1',
    credential_kind: 'oauth',
  }

  it("'Not logged in' → auth expired; 'Logged in' → healthy", async () => {
    const out = await new CodexAdapter({
      versionProbe: async () => '0.148.0',
      loginStatus: async () => ({ code: 1, stdout: '', stderr: 'Not logged in\n' }),
    }).probe(slot)
    expect(out.auth.logged_in).toBe(false)
    const inProbe = await new CodexAdapter({
      versionProbe: async () => '0.148.0',
      loginStatus: async () => ({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' }),
    }).probe(slot)
    expect(inProbe.auth).toEqual({ logged_in: true, method: 'chatgpt', detail: 'Logged in using ChatGPT' })
  })

  it('capabilities target the 0.148.0 app-server protocol', async () => {
    const { capabilities } = await new CodexAdapter({
      versionProbe: async () => '0.148.0',
      loginStatus: async () => ({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' }),
    }).probe(slot)
    expect(capabilities.engine_version).toBe('0.148.0')
    expect(capabilities.engine_version).toBe(CODEX_ENGINE_VERSION)
    expect(capabilities.usage_mode).toBe('cumulative')
    expect(capabilities.tool_approval).toBe(true)
    expect(capabilities.sandbox).toBe(true)
    expect(capabilities.restricted_mode).toBe(true)
  })
})
