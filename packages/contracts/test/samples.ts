import { FAKE_KEYS } from './fake-keys'

export type Samples = { valid: unknown[]; invalid: unknown[] }

const SHA = '0123456789abcdef0123456789abcdef01234567'
const AT = '2026-11-03T15:18:57.626Z'
const ENVELOPE = { seq: 0, at: AT, attempt_id: 'att_01', generation: 0 }

/**
 * Claude Code 2.1.317 smoke stream, from MubitLabs/mec-stream-b@4a6c011
 * packages/testkit/fixtures/claude/2.1.317/smoke/events.jsonl, with `resets_at` in `toISOString` form.
 */
export const SMOKE_EVENTS = [
  {
    type: 'session_started',
    session_id: 'f5fdd8dd-5fb7-49ed-80cb-9eec8412c6e3',
    engine: 'claude',
    engine_version: '2.1.317',
    model: 'claude-opus-5-5',
  },
  { type: 'message', role: 'assistant', text: 'MEC pre-flight smoke ok.' },
  {
    type: 'rate_limit',
    window: 'five_hour',
    status: 'allowed',
    utilization: 0.23,
    resets_at: '2026-11-03T18:20:00.000Z',
    raw: { rateLimitType: 'five_hour', overageStatus: 'allowed', isUsingOverage: false },
  },
  {
    type: 'rate_limit',
    window: 'seven_day',
    status: 'allowed',
    utilization: 0.07,
    resets_at: '2026-11-10T07:00:00.000Z',
    raw: { rateLimitType: 'five_hour', overageStatus: 'allowed', isUsingOverage: false },
  },
  {
    type: 'usage',
    input_tokens: 2,
    output_tokens: 16,
    cache_read: 11382,
    cache_write: 7335,
    cost_usd: 0.0612844,
  },
  { type: 'exit', code: 0, terminal_reason: 'completed' },
] as const

const OPERATION = { kind: 'shell', summary: 'Run the unit tests', command: ['pnpm', 'test'] }
const EVIDENCE = {
  raw: { tool_name: 'Bash', input: { command: 'pnpm test' } },
  worktree: '/Users/me/wt/att_01',
}

const PROFILE = {
  sandbox: 'required',
  read_only: false,
  allow_write: ['/Users/me/wt/att_01', '/tmp/mec-att_01'],
  deny_read: ['/Users/me/.ssh', '/Users/me/.mec'],
  allowed_domains: ['registry.npmjs.org'],
  blocked_commands: ['mec', 'claude', 'codex', 'opencode'],
  background_cap_ms: 600_000,
  permission_mode: 'bridge',
  repo_trusted: false,
}

export const BRIEF = {
  attempt_id: 'att_01',
  generation: 0,
  task_id: 'task_01',
  work_item_id: 'wi_01',
  role: { name: 'implementer', revision: 'r12' },
  engine: 'claude',
  slot_id: 'slot_max-1',
  worktree: '/Users/me/wt/att_01',
  base_sha: SHA,
  branch: 'mec/wi_01/task_01',
  origin: { messages: [{ id: 'msg_01', text: 'Add audit-log viewing to the admin page.' }] },
  objective: 'Add a read-only audit-log table to the admin page.',
  owned_paths: ['apps/admin/src/audit/**'],
  acceptance_checks: ['unit'],
  budget: { turns: 40, wall_clock_ms: 1_800_000 },
  bundle_revision: 'b7',
  tools: { url: 'http://127.0.0.1:49152/mcp', token: 'attempt-scoped' },
  env: { MEC_TASK: 'task_01', NODE_ENV: 'test' },
  isolation: PROFILE,
}

/** Two valid and two invalid samples per exported schema (CONTRACTS §0), keyed by export name. */
export const SAMPLES: Record<string, Samples> = {
  // common.ts
  WorkItemId: { valid: ['wi_01JD3X', 'wi_a-b_c'], invalid: ['task_01', 'wi_'] },
  TaskId: { valid: ['task_1', 'task_01JD3X'], invalid: ['att_1', 'task_has space'] },
  AttemptId: { valid: ['att_1', 'att_01JD3X'], invalid: ['task_1', 'att_'] },
  SlotId: { valid: ['slot_max-1', 'slot_01'], invalid: ['max-1', 'slot_a/b'] },
  EngineInstallId: { valid: ['eng_claude', 'eng_01'], invalid: ['claude', 'eng_'] },
  MessageId: { valid: ['msg_1', 'msg_01JD3X'], invalid: ['message_1', 'msg_!'] },
  ConfirmationId: { valid: ['conf_1', 'conf_x'], invalid: ['cnf_1', ''] },
  QuestionId: { valid: ['q_1', 'q_abc'], invalid: ['question_1', 'q_'] },
  ReportId: { valid: ['rep_1', 'rep_x'], invalid: ['report_1', 42] },
  InputId: { valid: ['inp_1', 'inp_x'], invalid: ['input_1', null] },
  Generation: { valid: [0, 7], invalid: [-1, 1.5] },
  IsoTime: {
    valid: [AT, new Date(0).toISOString()],
    invalid: ['2026-11-03T18:20:00Z', '2026-11-03T15:33:43.397897Z', '2026-11-03T15:18:57.626+00:00'],
  },
  Sha: { valid: [SHA, 'f'.repeat(40)], invalid: ['F'.repeat(40), 'abc123'] },
  AbsPath: { valid: ['/Users/me/repo', '/tmp'], invalid: ['relative/path', '~/repo'] },
  Json: { valid: [{ a: [1, 'x', null] }, 'text'], invalid: [undefined, Number.NaN, new Date(0)] },
  EngineId: { valid: ['claude', 'opencode'], invalid: ['Claude', 'gemini'] },
  AttemptRef: {
    valid: [
      { attempt_id: 'att_1', generation: 0 },
      { attempt_id: 'att_2', generation: 3 },
    ],
    invalid: [{ attempt_id: 'att_1' }, { attempt_id: 'att_1', generation: 0, slot_id: 'slot_1' }],
  },

  // events.ts
  Window: { valid: ['five_hour', 'overage'], invalid: ['5h', 'monthly'] },
  ErrorClass: { valid: ['quota', 'unknown'], invalid: ['rate_limit', ''] },
  TerminalReason: { valid: ['completed', 'crashed'], invalid: ['success', 'error'] },
  RateLimitStatus: { valid: ['allowed', 'warning'], invalid: ['allowed_warning', 'blocked'] },
  MessageRole: { valid: ['assistant', 'user'], invalid: ['tool', 'human'] },
  EngineEventBody: {
    valid: [
      ...SMOKE_EVENTS,
      { type: 'tool_call', tool: 'Read', input: { file_path: '/Users/me/repo/hello.txt' }, ok: true },
      { type: 'permission_request', request_id: 'toolu_01', operation: OPERATION, evidence: EVIDENCE },
      { type: 'permission_result', request_id: 'toolu_01', decision: 'expired' },
      { type: 'report', report: { kind: 'waiting', summary: 'Waiting for the schema decision.' } },
      { type: 'error', class: 'auth', detail: 'Not logged in', raw: { error: 'authentication_failed' } },
      { type: 'rate_limit', window: 'unknown', status: 'rejected', resets_at: 'unknown' },
      { type: 'usage', input_tokens: 0, output_tokens: 0, cost_usd: 'unknown' },
    ],
    invalid: [
      { type: 'session_started', session_id: 's1', engine: 'gemini', engine_version: '1.0.0' },
      { ...SMOKE_EVENTS[2], resets_at: '2026-11-03T18:20:00Z' },
      { type: 'thinking', text: 'hmm' },
      { ...SMOKE_EVENTS[1], seq: 1 },
      { ...SMOKE_EVENTS[2], utilization: 1.2 },
    ],
  },
  EventEnvelope: {
    valid: [ENVELOPE, { ...ENVELOPE, seq: 41, generation: 2 }],
    invalid: [
      { ...ENVELOPE, seq: -1 },
      { ...ENVELOPE, at: '2026-11-03T15:18:57Z' },
    ],
  },
  EngineEvent: {
    valid: [
      { ...SMOKE_EVENTS[0], ...ENVELOPE },
      { ...SMOKE_EVENTS[5], ...ENVELOPE, seq: 5 },
    ],
    invalid: [SMOKE_EVENTS[0], { ...SMOKE_EVENTS[1], ...ENVELOPE, extra: true }],
  },

  // report.ts
  Question: {
    valid: [
      { text: 'Which database should the audit log use?' },
      {
        id: 'q_1',
        text: 'Ship behind a flag?',
        options: ['yes', 'no'],
        for_message_id: 'msg_01',
        evidence_ref: 'attempt/att_01/diff',
      },
    ],
    invalid: [{ text: '' }, { text: 'x'.repeat(401) }],
  },
  ReportKind: { valid: ['progress', 'dropped'], invalid: ['done', 'needs_input'] },
  Report: {
    valid: [
      { kind: 'progress', summary: 'Read the admin page and the audit schema.' },
      {
        kind: 'ready',
        summary: 'Audit-log table added; unit checks pass.',
        head_sha: SHA,
        checks_run: ['unit'],
        artifacts: [{ kind: 'diff', ref: 'attempt/att_01/diff' }],
        question: null,
        round: { reviewer: 'reviewer', count: 1 },
        handled_inputs: ['inp_01'],
        handback: { message_id: 'msg_02', reason: 'Asks about billing, not audit logs.' },
      },
    ],
    invalid: [
      { kind: 'ready', summary: 'x'.repeat(2001) },
      { kind: 'waiting', summary: 'Waiting.', question: { text: 'Which one?', urgent: true } },
    ],
  },

  // bridge.ts
  OperationKind: { valid: ['shell', 'external_directory'], invalid: ['bash', 'read'] },
  Operation: {
    valid: [OPERATION, { kind: 'network', summary: 'Fetch a package', hosts: ['registry.npmjs.org'] }],
    invalid: [
      { kind: 'shell', summary: 'Run the unit tests', command: 'pnpm test' },
      { kind: 'edit', summary: 'Edit a file', paths: ['src/a.ts'] },
    ],
  },
  Evidence: {
    valid: [EVIDENCE, { raw: null, worktree: '/Users/me/wt/att_01', head_sha: SHA }],
    invalid: [
      { raw: {}, worktree: 'wt/att_01' },
      { raw: {}, worktree: '/Users/me/wt/att_01', head_sha: 'HEAD' },
    ],
  },
  Decision: { valid: ['allow', 'expired'], invalid: ['approve', 'timeout'] },

  // brief.ts
  IsolationProfile: {
    valid: [PROFILE, { ...PROFILE, sandbox: 'off', read_only: true, permission_mode: 'none' }],
    invalid: [
      { ...PROFILE, sandbox: 'strict' },
      { ...PROFILE, network: 'open' },
    ],
  },
  AttemptBrief: {
    valid: [
      BRIEF,
      {
        ...BRIEF,
        generation: 1,
        origin: { messages: [{ id: 'msg_01', pointer: 'message/msg_01' }] },
        routing_note: 'Follow-up to the audit-log request; the user prefers a flat table.',
        budget: { turns: 10, wall_clock_ms: 600_000, usd: 2.5 },
        env: {},
      },
    ],
    invalid: [
      { ...BRIEF, env: { MEC_TASK: 'task_01', OPENAI_API_KEY: FAKE_KEYS['openai-legacy'] } },
      {
        ...BRIEF,
        origin: { messages: [{ id: 'msg_01', text: 'Add audit logs.', pointer: 'message/msg_01' }] },
      },
    ],
  },
}
