/**
 * The §23 worked example (docs/plan/spec.md §23, rendered in docs/design/screens/) as
 * fixture data. Two consumers:
 *
 *  - api.ts's not-yet-served endpoints fall back to these payloads (flagged `demo: true`,
 *    which the UI labels honestly — "not served by the server yet").
 *  - apps/web/test/screens.playwright.ts serves them as the /api responses, so the
 *    screenshot suite shows the worked example through the same typed api layer the
 *    real server will speak.
 *
 * Expiry timestamps are computed from load time so countdowns always have something
 * honest to count. Pure data — no React, no DOM.
 */

import type {
  BackupsStatus,
  ChatMessage,
  DecisionDetail,
  EngineStatus,
  ExistingLogins,
  InboxItem,
  ModelTiers,
  PromptPart,
  Question,
  RepositoryEntry,
  SlotEntry,
  StatusSnapshot,
  TaskDetail,
  WorkItem,
  WorkItemDetail,
} from './api'

function isoInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

const AT = '2026-11-04T14:02:00Z'

// ── Decision evidence (the conf_71 push-and-PR card) ─────────────────────────────────────

export const demoDecisionDetails: Record<string, DecisionDetail> = {
  conf_71: {
    demo: true,
    what: 'Push the branch and open a pull request',
    why: 'The release agent finished the audit-log work. This is the first thing that leaves your machine.',
    facts: [
      { label: 'Branch', value: 'mec/a1/release → origin', mono: true },
      { label: 'Head', value: '4f2c9e1', mono: true },
      { label: 'Checks', value: 'lint, typecheck, unit passed on that commit' },
      { label: 'Findings', value: '2 reviewed, 1 fixed, 1 declined with reason' },
    ],
    operation: 'git push origin mec/a1/release\ngh pr create',
    requestedBy: 'Release agent on max-2',
    consequences: {
      approve: 'One branch is pushed, one PR opens as you. Nothing merges.',
      deny: 'The branch stays local; the agent is told it was not approved.',
    },
    checks: [
      { name: 'lint', state: 'passed', note: '12 s' },
      { name: 'typecheck', state: 'passed', note: '41 s' },
      { name: 'unit', state: 'passed', note: '2 m 03 s' },
      { name: 'integration', state: 'none', note: 'not configured for this repo' },
    ],
    findings: [
      {
        title: 'Fixed, medium: console/AuditTable.tsx',
        disposition:
          'Unescaped user-supplied filter rendered into the query string. Fixed in a1/repair-1, verified by the reviewer.',
      },
      {
        title: 'Declined, low: api/audit.ts',
        disposition:
          'Reviewer suggested pagination by cursor. Declined: offset pagination matches the rest of the API; noted in the PR body.',
      },
    ],
    diff: {
      summary: '9 files, +412 −38',
      files: [
        { path: 'api/audit.ts', added: 138, removed: 0 },
        { path: 'api/audit.test.ts', added: 96, removed: 0 },
        { path: 'console/AuditTable.tsx', added: 121, removed: 2 },
        { path: 'console/AuditPage.tsx', added: 41, removed: 0 },
        { path: 'db/migrations/0042.sql', added: 16, removed: 0 },
      ],
    },
  },
}

// ── The question card (q_12) ──────────────────────────────────────────────────────────────

export const demoQuestions: Question[] = [
  {
    demo: true,
    id: 'q_12',
    eyebrow: 'The console implementer asks',
    what: 'Should deleted users stay identifiable in the audit log?',
    why: 'Rows written by users who were later deleted can show the original user id, or an anonymous marker. The API task is unaffected; the console task waits on this.',
    options: ['Keep the user id', 'Show “deleted user”', 'Answer in chat…'],
    sideNote: 'Work on the API task continues',
    evidence: {
      note: 'The API task already stores user_id; the question is only what the console shows.',
      code: '// console/AuditTable.tsx:88\nconst actor = row.user ?? ???\n// users table rows are hard-deleted; audit rows keep user_id',
    },
  },
]

// ── Work-item and task detail for the context pane ───────────────────────────────────────

export const demoWorkItemDetails: Record<string, WorkItemDetail> = {
  wi_a1: {
    demo: true,
    title: 'Audit-log viewing',
    stage: 'Needs your approval',
    kv: [
      { label: 'Started', value: '14:02 from your message' },
      { label: 'Mandate', value: 'acme/console, default caps, no expiry' },
      { label: 'Policy', value: '9c1e4b…', mono: true },
      { label: 'Bundle', value: 'revision 13' },
    ],
    tasks: [
      { id: 'task_api', name: 'Storage and API', state: 'checks passed on max-2', stateKind: 'ok' },
      { id: 'task_console', name: 'Console page', state: 'waiting on you', stateKind: 'attn' },
      { id: 'task_tests', name: 'Tests', state: 'queued for glm-1' },
      { id: 'task_review', name: 'Review', state: 'accepted on glm-1', stateKind: 'ok' },
      { id: 'task_sec', name: 'Security', state: '2 findings dispositioned on gem-1', stateKind: 'ok' },
    ],
    handoffs: [
      {
        title: '14:38, max-1 → max-2',
        note: 'Five-hour window reached on max-1; continued on the same worktree under your pairing rule.',
      },
    ],
    soFar: [
      { label: 'Your attention', value: '2 cards, 1 question' },
      { label: 'Elapsed', value: '1 h 51 m' },
      { label: 'Repairs', value: '1' },
      { label: 'GLM credits', value: '412' },
      { label: 'Gemini', value: '$0.31' },
    ],
  },
  wi_b2: {
    demo: true,
    title: 'Rate-limit headers on the public API',
    stage: 'Working',
    kv: [
      { label: 'Tasks', value: '1 of 2 running' },
      { label: 'Head', value: 'a91d0c3', mono: true },
    ],
    tasks: [],
    handoffs: [],
  },
  wi_c3: {
    demo: true,
    title: 'Flaky integration test in billing',
    stage: 'Waiting for quota',
    kv: [
      { label: 'Parked on', value: 'max-1, resets 18:40' },
      { label: 'Worktree', value: 'preserved' },
    ],
    tasks: [],
    handoffs: [],
    soFar: [{ label: 'Note', value: 'Switch it to max-2 now, or let it resume at 18:40.' }],
  },
}

export const demoTaskDetails: Record<string, TaskDetail> = {
  task_api: {
    demo: true,
    name: 'Storage and API for audit events',
    kv: [
      { label: 'Role', value: 'Implementer' },
      { label: 'Tier', value: 'balanced (sonnet, medium effort)' },
      { label: 'Slot', value: 'max-2 (after handoff from max-1)' },
      { label: 'Head', value: 'b71e3a0', mono: true },
      { label: 'State', value: 'Checks passed' },
    ],
    report:
      'Ready: audit events table, migration 0042, GET /audit with filters and tests. Risk: offset pagination.',
  },
  task_console: {
    demo: true,
    name: 'Console page with filters',
    kv: [
      { label: 'Role', value: 'Implementer' },
      { label: 'Tier', value: 'balanced (sonnet, medium effort)' },
      { label: 'Slot', value: 'max-2' },
      { label: 'State', value: 'Waiting on your answer' },
    ],
    note: 'The open question is in Needs you.',
  },
  task_tests: {
    demo: true,
    name: 'Tests for both',
    kv: [
      { label: 'Role', value: 'Test author' },
      { label: 'Tier', value: 'fast (glm-5.3-flash)' },
      { label: 'Slot', value: 'glm-1' },
      { label: 'State', value: 'Queued — starts when the console task is accepted' },
    ],
  },
}

// ── Settings: prompts and the model tier ladder ──────────────────────────────────────────

export const demoPromptParts: PromptPart[] = [
  { id: 'shared/communication', layer: 'Shared', name: 'Communication' },
  { id: 'shared/scope', layer: 'Shared', name: 'Scope', edited: true },
  { id: 'shared/delivery', layer: 'Shared', name: 'Delivery' },
  { id: 'meta/protocol', layer: 'Meta agent', name: 'Protocol' },
  {
    id: 'meta/planning',
    layer: 'Meta agent',
    name: 'Planning',
    defaultUpdated: true,
    provenance: 'Your text, based on the default from 20 Oct. The default changed on 3 Nov.',
    text: `Choose the cheapest tier that the task's risk allows, and say why in \`reason\`. Mechanical work is fast. Work with a clear scope and existing tests is balanced. Work that touches interfaces, concurrency, security, data migration, or that a previous attempt failed is strong. Frontier needs the user's pre-authorisation; propose it only when the task is an investigation whose cost of being wrong is high.

Reviews prefer a different provider than the implementer. The security checker runs strong at max effort when policy marks its findings blocking.

Give a specialist a subagent policy only when its task has separable lookups; subagents are fast by default. When a slot is above its utilisation ceiling, place elsewhere or say the work waits.`,
  },
  { id: 'roles/implementer', layer: 'Roles', name: 'Implementer' },
  { id: 'roles/code-reviewer', layer: 'Roles', name: 'Code reviewer', edited: true },
  { id: 'roles/security-checker', layer: 'Roles', name: 'Security checker' },
  { id: 'roles/release', layer: 'Roles', name: 'Release agent' },
]

export const demoModelTiers: ModelTiers = {
  demo: true,
  providers: ['Claude Code', 'Codex', 'OpenCode on GLM', 'OpenCode on Gemini'],
  rows: [
    {
      tier: 'fast',
      cells: [
        { text: 'haiku', note: 'medium' },
        { text: 'gpt-6-luna', note: 'low' },
        { text: 'glm-5.3-flash' },
        { text: 'gemini-3.5-flash-lite' },
      ],
    },
    {
      tier: 'balanced',
      cells: [
        { text: 'sonnet', note: 'medium' },
        { text: 'gpt-6.1-sol', note: 'medium' },
        { text: 'glm-5.3' },
        { text: 'gemini-3.8-flash' },
      ],
    },
    {
      tier: 'strong',
      cells: [
        { text: 'opus', note: 'high' },
        { text: 'gpt-6-astra', note: 'high' },
        undefined,
        { text: 'gemini-4-argon' },
      ],
    },
    {
      tier: 'frontier',
      cells: [{ text: 'fable', note: 'high, bills credits' }, undefined, undefined, undefined],
    },
  ],
  note: 'Frontier needs your pre-authorisation per repository. Last probed on this machine 4 Nov, 09:12.',
}

export const demoBackups: BackupsStatus = {
  demo: true,
  lastAt: '03:00 today',
  note: 'Credentials excluded by rule.',
  excluded: 'credentials',
}

// ── Real-endpoint fixtures (the Playwright route stubs) ─────────────────────────────────

export const demoStatus: StatusSnapshot = {
  runtime: { state: 'ready', instances: 2, answering: true },
  parts: {
    'slot:codex-1': { state: 'error', detail: 'login expired since 13:20' },
    'slot:max-1': { state: 'degraded', detail: 'five-hour window at 85%, resets 18:40' },
    'slot:max-2': { state: 'ok', detail: 'five-hour window at 31%' },
    'slot:glm-1': { state: 'ok', detail: 'healthy, no reading yet' },
    'slot:gem-1': { state: 'ok', detail: 'healthy, $0.42 today' },
  },
  setup: { has_slot: true, has_repository: true },
}

export const demoChatMessages: ChatMessage[] = [
  {
    id: 'msg_1',
    kind: 'user',
    meta: 'You',
    text: 'Add audit-log viewing to the console and expose it through the API. It should have tests.',
    createdAt: AT,
    workItemId: 'wi_a1',
  },
  {
    id: 'msg_2',
    kind: 'agent',
    meta: 'Meta agent on max-1',
    text: 'On it: adding audit-log viewing to the console and the API, with tests.',
    createdAt: AT,
    workItemId: 'wi_a1',
  },
  {
    id: 'msg_3',
    text: 'Plan: 3 tasks',
    createdAt: AT,
    workItemId: 'wi_a1',
    plan: {
      title: 'Plan: 3 tasks',
      approvedNote: 'Approved by you at 14:03 under policy 9c1e…',
      tasks: [
        {
          id: 'task_api',
          task: 'Storage and API for audit events',
          role: 'Implementer',
          tier: 'balanced',
          slot: 'max-2',
          state: 'Checks passed',
          stateKind: 'ok',
        },
        {
          id: 'task_console',
          task: 'Console page with filters',
          role: 'Implementer',
          tier: 'balanced',
          slot: 'max-2',
          state: 'Waiting on your answer',
          stateKind: 'attn',
        },
        {
          id: 'task_tests',
          task: 'Tests for both',
          role: 'Test author',
          tier: 'fast',
          slot: 'glm-1',
          state: 'Queued',
        },
      ],
      note: 'Review runs on a different provider (glm-1). Security pass on gem-1 at max effort because findings block integration here.',
    },
  },
  {
    id: 'msg_4',
    kind: 'status',
    text: 'Checks passed on the API task.',
    createdAt: '2026-11-04T14:31:00Z',
    workItemId: 'wi_a1',
  },
  {
    id: 'msg_5',
    kind: 'notice',
    text: 'max-1 hit its five-hour window. It resets at 18:40. The API task moved to max-2 under your max-1 → max-2 pairing; nothing was lost.',
    createdAt: '2026-11-04T14:38:00Z',
    workItemId: 'wi_a1',
    noticeRoute: { label: 'See slots', route: 'slots' },
  },
  {
    id: 'msg_6',
    kind: 'agent',
    meta: 'Meta agent',
    text: 'The console implementer needs one decision from you before it can finish the deleted-users case.',
    createdAt: '2026-11-04T14:44:00Z',
    workItemId: 'wi_a1',
  },
]

export const demoInbox: InboxItem[] = [
  { id: 'conf_71', cls: 'push-and-open-pr', operationHash: '4f2c9e1b6d', expiresAt: isoInMinutes(23) },
]

export const demoWork: WorkItem[] = [
  {
    id: 'wi_a1',
    state: 'blocked',
    stage: 'waiting on you (confirmation)',
    taskCounts: { total: 5, byStatus: { integrated: 2, active: 2, awaiting_review: 1 } },
    updatedAt: '2026-11-04T14:44:00Z',
  },
  {
    id: 'wi_b2',
    state: 'executing',
    stage: 'working',
    taskCounts: { total: 2, byStatus: { active: 1, ready: 1 } },
    updatedAt: '2026-11-04T13:10:00Z',
  },
  {
    id: 'wi_c3',
    state: 'parked',
    stage: 'waiting for quota',
    taskCounts: { total: 1, byStatus: { ready: 1 } },
    updatedAt: '2026-11-04T14:38:00Z',
  },
  {
    id: 'wi_d4',
    state: 'done',
    stage: 'done',
    taskCounts: { total: 2, byStatus: { integrated: 2 } },
    updatedAt: '2026-11-04T11:20:00Z',
  },
  {
    id: 'wi_e5',
    state: 'stopped',
    stage: 'stopped',
    taskCounts: { total: 1, byStatus: { dropped: 1 } },
    updatedAt: '2026-11-04T09:55:00Z',
  },
]

export const demoSlots: SlotEntry[] = [
  {
    id: 'slot_codex1',
    label: 'codex-1',
    engine: 'codex',
    kind: 'subscription',
    provider: 'Codex on ChatGPT Pro, you@mubit.dev',
    state: 'login_expired',
    stateReason: 'Two attempts are parked until you sign in again. Nothing was lost.',
  },
  {
    id: 'slot_max1',
    label: 'max-1',
    engine: 'claude',
    kind: 'subscription',
    provider: 'Claude Code on Max, anil@mubit.dev',
    state: 'near_window',
    usage: {
      kind: 'percent',
      label: 'Five-hour window',
      percent: 85,
      resetsAt: '18:40',
      lines: [
        'Five-hour window at 85%, resets 18:40. Weekly window at 41%.',
        'Paired with max-2. New work goes elsewhere above 80%.',
      ],
    },
  },
  {
    id: 'slot_max2',
    label: 'max-2',
    engine: 'claude',
    kind: 'subscription',
    provider: 'Claude Code on Max, ops@mubit.dev',
    state: 'healthy',
    usage: {
      kind: 'percent',
      label: 'Five-hour window',
      percent: 31,
      lines: ['Five-hour window at 31%. Weekly window at 22%. The meta agent runs here.'],
    },
  },
  {
    id: 'slot_glm1',
    label: 'glm-1',
    engine: 'opencode',
    kind: 'api-key',
    provider: 'OpenCode on the GLM Coding Plan (Pro)',
    state: 'healthy',
    fingerprint: { provider: 'glm-api', last4: '7f2a' },
    usage: { kind: 'unknown', reason: 'the plan reports credits only on its dashboard' },
  },
  {
    id: 'slot_gem1',
    label: 'gem-1',
    engine: 'opencode',
    kind: 'api-key',
    provider: 'OpenCode on the Gemini API, billing-linked project',
    state: 'healthy',
    fingerprint: { provider: 'gemini-api', last4: 'Q9ce' },
    usage: {
      kind: 'percent',
      label: 'Daily cap',
      percent: 8,
      lines: ['$0.42 spent today of a $5.00 daily cap. Per-minute limit hit twice and retried.'],
    },
  },
]

export const demoEngines: EngineStatus[] = [
  { engine: 'claude', installed: true, version: '2.1.317' },
  { engine: 'codex', installed: true, version: '0.148.0' },
  { engine: 'opencode', installed: true, version: '2.2.5' },
]

export const demoLogins: ExistingLogins = {
  claude: { engine: 'claude', loggedIn: true, email: 'anil@mubit.dev', plan: 'Max' },
  codex: { engine: 'codex', loggedIn: true, email: 'you@mubit.dev', plan: 'ChatGPT Pro' },
  opencode: null,
}

export const demoRepositories: RepositoryEntry[] = [
  {
    id: 'repo_console',
    url: 'github.com/acme/console',
    bootstrap: ['pnpm install'],
    checks: [
      { name: 'lint', cmd: 'pnpm lint' },
      { name: 'typecheck', cmd: 'pnpm exec tsc --noEmit' },
      { name: 'unit', cmd: 'pnpm test' },
    ],
    trust: true,
  },
  {
    id: 'repo_api',
    url: 'github.com/acme/api',
    bootstrap: ['pnpm install'],
    checks: [
      { name: 'lint', cmd: 'pnpm lint' },
      { name: 'unit', cmd: 'pnpm test' },
    ],
    trust: true,
  },
  {
    id: 'repo_billing',
    url: 'github.com/acme/billing',
    bootstrap: ['pnpm install'],
    checks: [{ name: 'unit', cmd: 'pnpm test' }],
    trust: false,
  },
]
