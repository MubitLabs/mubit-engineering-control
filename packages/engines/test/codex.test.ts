import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaunchSpec, PermissionBridge, SlotRef } from '@mec/contracts'
import { checkEventStream } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/codex/adapter'
import { CODEX_ENGINE_VERSION, classifyCodexError, parseCodexEvents } from '../src/codex/protocol'

/**
 * CONTRACTS §9 conformance, engine side: the adapter's stream parser, run over each
 * recorded raw stream, must yield exactly the fixture's normalised events. smoke,
 * permission_request and auth_expired are REAL recordings from the logged-in codex-1
 * slot and an empty CODEX_HOME (3 Nov 2026; see meta.notes); rate_limit_rejected stays
 * a corrected synthesis — a real rejection needs window exhaustion.
 */
const ROOT = fileURLToPath(new URL('../../testkit/fixtures/codex/0.148.0', import.meta.url))
const NOW = '2026-11-03T15:18:57.000Z'

const CASES = [
  { scenario: 'smoke', exitCode: 0 },
  { scenario: 'permission_request', exitCode: 0 },
  { scenario: 'auth_expired', exitCode: 137 }, // the recorder SIGKILLed the retrying server
  { scenario: 'rate_limit_rejected', exitCode: 1 },
] as const

describe('codex stream conformance (real fixtures)', () => {
  for (const { scenario, exitCode } of CASES) {
    it(`${scenario}: parseCodexEvents(raw) === events.jsonl`, () => {
      const rawLines = readFileSync(join(ROOT, scenario, 'raw.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
      const expected = readFileSync(join(ROOT, scenario, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const parsed = parseCodexEvents(rawLines, { exitCode })
      expect(parsed).toHaveLength(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(parsed[i]).toEqual(expected[i])
      }
    })
  }

  it('the CONTRACTS §1 invariants hold for every fixture', () => {
    for (const { scenario, exitCode } of CASES) {
      const events = parseCodexEvents(
        readFileSync(join(ROOT, scenario, 'raw.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean),
        { exitCode },
      )
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
      if (method === 'thread/start') return { thread: { id: threadId } }
      if (method === 'thread/resume') return { thread: { id: params?.threadId ?? threadId } }
      return {}
    },
  })

describe('CodexAdapter launch/send/interrupt', () => {
  it('launch posts initialize, the initialized notification, then thread/start', async () => {
    const posts: unknown[] = []
    const handle = await recordingAdapter(posts).launch(spec({ read_only: true }))
    expect(handle).toMatchObject({ attempt_id: 'att_cx1', generation: 0, session_id: 'th_t1' })
    expect(posts[0]).toMatchObject({ method: 'initialize' })
    expect(posts[1]).toEqual({ jsonrpc: '2.0', method: 'initialized' }) // notification: no id
    expect(posts[2]).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'thread/start',
      params: { cwd: '/wt/audit-view', sandbox: 'read-only', approvalPolicy: 'on-request' },
    })
  })

  it('permission_mode none answers never; write briefs get workspace-write; resume posts thread/resume', async () => {
    const posts: unknown[] = []
    const adapter = recordingAdapter(posts)
    await adapter.launch(spec())
    expect(posts[2]).toMatchObject({
      method: 'thread/start',
      params: { cwd: '/wt/audit-view', sandbox: 'workspace-write', approvalPolicy: 'on-request' },
    })
    const none = JSON.parse(JSON.stringify(spec({ read_only: true }))) as LaunchSpec
    none.brief.isolation.permission_mode = 'none'
    await adapter.launch(none)
    expect(posts[5]).toMatchObject({
      method: 'thread/start',
      params: { sandbox: 'read-only', approvalPolicy: 'never' },
    })
    const resumed = await adapter.launch(spec({ resume: { session_id: 'th_t9' } }))
    expect(resumed.session_id).toBe('th_t9')
    expect(posts[8]).toMatchObject({ method: 'thread/resume', params: { threadId: 'th_t9' } })
  })

  it('send posts turn/start with input items, then turn/steer with the active turn id', async () => {
    const posts: unknown[] = []
    const adapter = recordingAdapter(posts)
    const handle = await adapter.launch(spec())
    await adapter.send(handle, { id: 'inp_1', kind: 'message', text: 'fix the failing test' })
    expect(posts[3]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'th_t1',
        input: [{ type: 'text', text: 'fix the failing test', text_elements: [] }],
      },
    })
    // steer before turn/started was drained: refused, not malformed
    await expect(
      adapter.send(handle, { id: 'inp_2', kind: 'note', text: 'also check the schema' }),
    ).rejects.toThrow(/turn\/steer needs the active turn id/)
    await expect(adapter.interrupt(handle)).rejects.toThrow(/turn\/interrupt needs the active turn id/)
  })

  it('interrupt with a known turn id posts turn/interrupt; without an open turn it is a no-op', async () => {
    const posts: unknown[] = []
    const adapter = recordingAdapter(posts)
    const handle = await adapter.launch(spec())
    await adapter.interrupt(handle) // no turn open: nothing sent
    expect(posts.filter((p) => (p as { method?: string }).method === 'turn/interrupt')).toHaveLength(0)
  })
})

describe('CodexAdapter permission bridge', () => {
  // The server stream carries only server lines; the answer line the fixture records is what
  // the adapter itself sends, so it is stripped before the stream is replayed.
  const rawLines = () =>
    readFileSync(join(ROOT, 'permission_request', 'raw.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('{"jsonrpc":"2.0","id":0,"result"'))

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
        return method === 'thread/start' ? { thread: { id: '01a1a341-3dc3-7312-84cc-a9c42c945101' } } : {}
      },
      notifications: async function* () {
        for (const line of rawLines()) yield line
      },
      processExitCode: () => 0,
      now: () => NOW,
    })
    const handle = await adapter.launch(spec({ bridge }))

    const events = []
    for await (const event of adapter.events(handle)) events.push(event)

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'message',
      'permission_request',
      'permission_result',
      'tool_call',
      'usage',
      'rate_limit',
      'rate_limit',
      'message',
      'usage',
      'rate_limit',
      'rate_limit',
      'exit',
    ])
    const request = events.find((e) => e.type === 'permission_request')
    expect(request).toMatchObject({
      seq: 3,
      at: NOW,
      attempt_id: 'att_cx1',
      generation: 0,
      request_id: '0', // the real server request id (a JSON number) stringified
      operation: {
        kind: 'shell',
        summary: "/bin/zsh -lc 'touch approved.txt'",
        command: ["/bin/zsh -lc 'touch approved.txt'"],
      },
      evidence: { worktree: '/wt/audit-view' },
    })
    const result = events.find((e) => e.type === 'permission_result')
    expect(result).toMatchObject({ request_id: '0', decision: mapped })
    // the answer is a JSON-RPC RESPONSE: same id (type preserved), result.decision
    expect(posts[3]).toEqual({ jsonrpc: '2.0', id: 0, result: { decision: native } })
    expect(asked[0]).toEqual({
      kind: 'shell',
      worktree: '/wt/audit-view',
      deadline: '2026-11-03T15:23:57.000Z',
    })
    const exit = events.at(-1)
    expect(exit).toMatchObject({ type: 'exit', code: 0, terminal_reason: 'completed' })
  })

  it('answers a user-input question with {answers:{}}, never a decision', async () => {
    const posts: unknown[] = []
    const adapter = new CodexAdapter({
      post: async (payload) => {
        posts.push(payload)
        const method = (payload as { method?: string }).method
        return method === 'thread/start' ? { thread: { id: 'th_q' } } : {}
      },
      notifications: async function* () {
        yield JSON.stringify({
          method: 'thread/started',
          params: { thread: { id: 'th_q', cliVersion: '0.148.0' } },
        })
        yield JSON.stringify({
          method: 'item/tool/requestUserInput',
          id: 'req_q1',
          params: {
            threadId: 'th_q',
            turnId: 't1',
            itemId: 'i1',
            questions: [
              {
                id: 'q1',
                header: 'Pick',
                question: 'Which branch?',
                isOther: false,
                isSecret: false,
                options: null,
              },
            ],
            isBlocking: true,
            autoResolutionMs: null,
          },
        })
        yield JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'th_q',
            turn: { id: 't1', items: [], itemsView: 'notLoaded', status: 'completed' },
          },
        })
      },
      now: () => NOW,
    })
    const handle = await adapter.launch(spec({ bridge: { request: async () => 'deny' } }))
    const events = []
    for await (const event of adapter.events(handle)) events.push(event)
    expect(events.map((e) => e.type)).toEqual([
      'session_started',
      'permission_request',
      'permission_result',
      'exit',
    ])
    expect(posts[3]).toEqual({ jsonrpc: '2.0', id: 'req_q1', result: { answers: {} } })
    expect(events[1]).toMatchObject({
      request_id: 'req_q1',
      operation: { kind: 'other', summary: 'Which branch?' },
    })
  })

  it('synthesises the crash exit when the stream dies mid-retry (CONTRACTS §1)', async () => {
    const adapter = new CodexAdapter({
      post: async (payload) => {
        const method = (payload as { method?: string }).method
        return method === 'thread/start' ? { thread: { id: 'th_x' } } : {}
      },
      notifications: async function* () {
        yield JSON.stringify({
          method: 'thread/started',
          params: { thread: { id: 'th_x', cliVersion: '0.148.0' } },
        })
        yield JSON.stringify({
          method: 'error',
          params: {
            error: {
              message: 'Reconnecting... 2/5',
              codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
              additionalDetails: 'unexpected status 401 Unauthorized',
            },
            willRetry: true,
            threadId: 'th_x',
            turnId: 't1',
          },
        })
      },
      processExitCode: () => 137,
      now: () => NOW,
    })
    const handle = await adapter.launch(spec())
    const events = []
    for await (const event of adapter.events(handle)) events.push(event)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'error', 'exit'])
    expect(events[1]).toMatchObject({ class: 'auth', detail: 'Reconnecting... 2/5' })
    expect(events[2]).toMatchObject({ type: 'exit', code: 137, terminal_reason: 'crashed' })
  })
})

describe('classifyCodexError', () => {
  it('maps the real and documented failure shapes', () => {
    // the real auth-expired shape: the message alone says nothing (docs/engines.md)
    expect(
      classifyCodexError(
        'Reconnecting... 2/5 unexpected status 401 Unauthorized {"responseStreamDisconnected":{"httpStatusCode":401}}',
      ),
    ).toBe('auth')
    expect(classifyCodexError('Not logged in: run codex login to sign in')).toBe('auth')
    expect(classifyCodexError("usage limit reached: You've hit the plan's rate limit (429)")).toBe('quota')
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
