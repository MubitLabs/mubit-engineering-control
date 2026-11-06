import type {
  ActivityItem,
  ArtifactPage,
  AttemptView,
  CardEvidence,
  ChatLine,
  Coverage,
  NeedItem,
  Page,
  SearchHit,
  TaskDetail,
  TaskRow,
  WorkDetail,
  WorkRow,
} from '../../src/next/inspection-wire'

/**
 * Raw payloads for the work surfaces, checked against the wire types. They go through the real
 * decoders and work-model, in work-harness.tsx and the unit tests. Every title carries SAMPLE-ONLY,
 * and shell-split.test.ts proves that string never reaches a production asset.
 */

const OBSERVED = '2026-11-05T10:00:00.000Z'
const LATER = '2026-11-05T10:30:00.000Z'
export const CARD_HEAD = 'c0ffee0000000000000000000000000000000001'
export const TASK_HEAD = 'abc1230000000000000000000000000000000002'
export const OLD_HEAD = 'dead000000000000000000000000000000000003'

const COVERED: Coverage = { reports: true, checks: true, diff: true, activity: true, usage: true, delivery: true }
const UNCOVERED: Coverage = {
  reports: false,
  checks: false,
  diff: false,
  activity: false,
  usage: false,
  delivery: false,
}

const SAMPLE_A = { repoId: 'repo_a', repoLabel: 'sample-console' }
const SAMPLE_B = { repoId: 'repo_b', repoLabel: 'sample-billing' }

function row(
  id: string,
  title: string | null,
  repo: { repoId: string | null; repoLabel: string | null },
  state: string,
  stage: WorkRow['stage'],
  extra: Partial<WorkRow> = {},
): WorkRow {
  return {
    id,
    title,
    ...repo,
    readOnly: false,
    state,
    stage,
    reason: null,
    nextAction: null,
    taskCounts: { total: 3, byStatus: { active: 1, ready: 2 } },
    lastActivityAt: OBSERVED,
    updatedAt: OBSERVED,
    ...extra,
  }
}

export const workRows = {
  working: row(
    'work_working',
    'SAMPLE-ONLY search for the console',
    SAMPLE_A,
    'executing',
    { key: 'working', label: 'Working', waitingOn: 'none' },
    { nextAction: 'SAMPLE-ONLY the implementer finishes the index' },
  ),
  blocked: row(
    'work_blocked',
    'SAMPLE-ONLY export of audit rows',
    SAMPLE_A,
    'blocked',
    { key: 'person/decision', label: 'Needs your answer', waitingOn: 'person' },
    {
      reason: 'SAMPLE-ONLY the plan asks about archived rows',
      nextAction: 'SAMPLE-ONLY answer on Needs you',
      taskCounts: { total: 5, byStatus: { blocked: 1, ready: 4 } },
    },
  ),
  failed: row(
    'work_failed',
    'SAMPLE-ONLY invoice rounding',
    SAMPLE_B,
    'blocked',
    { key: 'person/blocked', label: 'Failed', waitingOn: 'person' },
    { reason: 'SAMPLE-ONLY the implementer reported a failure' },
  ),
  held: row(
    'work_held',
    'SAMPLE-ONLY theme cleanup',
    SAMPLE_A,
    'executing',
    { key: 'held', label: 'Held by you', waitingOn: 'person' },
    { reason: 'SAMPLE-ONLY you asked this to wait' },
  ),
  quota: row('work_quota', 'SAMPLE-ONLY retry the ledger sync', SAMPLE_B, 'executing', {
    key: 'waiting/quota',
    label: 'Waiting for quota (resets 14:00)',
    waitingOn: 'system',
  }),
  queued: row('work_queued', 'SAMPLE-ONLY tidy the settings copy', SAMPLE_A, 'admitted', {
    key: 'working/queued',
    label: 'Queued',
    waitingOn: 'system',
  }),
  completed: row(
    'work_done',
    'SAMPLE-ONLY keyboard shortcuts',
    SAMPLE_A,
    'done',
    { key: 'ended/merged', label: 'Merged', waitingOn: 'none' },
    { taskCounts: { total: 1, byStatus: { integrated: 1 } } },
  ),
  dropped: row(
    'work_dropped',
    'SAMPLE-ONLY old report format',
    SAMPLE_B,
    'dropped',
    { key: 'ended/dropped', label: 'Dropped', waitingOn: 'none' },
    { taskCounts: { total: 0, byStatus: {} } },
  ),
  legacy: row(
    'work_legacy',
    'SAMPLE-ONLY work from before repositories',
    { repoId: null, repoLabel: null },
    'executing',
    { key: 'working', label: 'Working', waitingOn: 'none' },
    { readOnly: true },
  ),
} satisfies Record<string, WorkRow>

export const workPage = {
  items: Object.values(workRows),
  nextCursor: null,
  observedAt: OBSERVED,
} satisfies Page<WorkRow>

export const emptyWorkPage = { items: [], nextCursor: null, observedAt: OBSERVED } satisfies Page<WorkRow>

const taskRow = (
  id: string,
  title: string,
  status: string,
  dependsOn: string[] = [],
  role: string | null = 'implementer',
): TaskRow => ({
  id,
  localKey: id,
  title,
  role,
  status,
  dependsOn,
  dependsOnTruncated: 0,
  planRevision: 1,
  attemptCount: 1,
})

const tasks = {
  done: taskRow('task_done', 'SAMPLE-ONLY read the code', 'accepted', [], 'planner'),
  active: taskRow('task_active', 'SAMPLE-ONLY build the index', 'active', ['task_done']),
  partial: taskRow('task_partial', 'SAMPLE-ONLY run the combined checks', 'ready', ['task_active'], 'test author'),
  held: taskRow('task_held', 'SAMPLE-ONLY rename the tokens', 'ready'),
  blocked: taskRow('task_blocked', 'SAMPLE-ONLY shape the export', 'blocked'),
  shipped: taskRow('task_shipped', 'SAMPLE-ONLY add the shortcuts', 'integrated'),
}

const NO_DELIVERY = { stage: 'none', branch: null, headSha: null, prNumber: null, prUrl: null } as const

const quietDetail = {
  originMessageId: null,
  goal: null,
  hold: null,
  planRevision: 1,
  delegation: [],
  delivery: NO_DELIVERY,
  retry: null,
  coverage: UNCOVERED,
  cursors: {},
  cursorsTruncated: 0,
  tasksTruncated: 0,
}

export const workDetails = {
  work_working: {
    ...workRows.working,
    ...quietDetail,
    originMessageId: 'msg_user',
    goal: 'SAMPLE-ONLY find anything in the console',
    tasks: [tasks.done, tasks.active, tasks.partial],
    delegation: [{ parentAttemptId: 'attempt_lead', childAttemptId: 'attempt_child' }],
    coverage: COVERED,
    cursors: { 'work:work_working': 12 },
  },
  work_held: {
    ...workRows.held,
    ...quietDetail,
    hold: { since: OBSERVED, reason: null },
    tasks: [tasks.held],
  },
  work_blocked: { ...workRows.blocked, ...quietDetail, tasks: [tasks.blocked] },
  work_failed: { ...workRows.failed, ...quietDetail, tasks: [] },
  work_quota: { ...workRows.quota, ...quietDetail, tasks: [] },
  work_queued: { ...workRows.queued, ...quietDetail, tasks: [] },
  work_dropped: { ...workRows.dropped, ...quietDetail, tasks: [] },
  work_done: {
    ...workRows.completed,
    ...quietDetail,
    tasks: [tasks.shipped],
    delivery: { stage: 'merged', branch: 'sample/shortcuts', headSha: TASK_HEAD, prNumber: 12, prUrl: null },
    coverage: COVERED,
  },
  work_legacy: { ...workRows.legacy, ...quietDetail, planRevision: null, tasks: [] },
} satisfies Record<string, WorkDetail>

const attempt = (
  id: string,
  state: string,
  headSha: string | null,
  extra: Partial<AttemptView> = {},
): AttemptView => ({
  id,
  generation: 1,
  state,
  role: 'implementer',
  requested: { tier: 'strong', model: null },
  actual: { model: 'sample-model-1', engine: 'claude', slotLabel: 'sample-slot' },
  baseSha: OLD_HEAD,
  headSha,
  processOutcome: 'unknown',
  lastActivityAt: OBSERVED,
  ...extra,
})

const taskDetail = (
  base: TaskRow,
  workItemId: string,
  repoId: string | null,
  extra: Partial<TaskDetail>,
): TaskDetail => ({
  ...base,
  workItemId,
  repoId,
  objective: `${base.title}: the objective`,
  attempts: [],
  attemptsTruncated: 0,
  checks: { headSha: null, results: [], truncated: 0 },
  diff: { headSha: null, summary: null, files: [], truncated: 0 },
  usage: { reportedUsd: null, missingAttempts: 0, mode: 'unknown' },
  coverage: COVERED,
  ...extra,
})

export const taskDetails = {
  task_done: taskDetail(tasks.done, 'work_working', 'repo_a', {
    attempts: [attempt('attempt_done', 'finished', TASK_HEAD, { processOutcome: 'exited' })],
    checks: {
      headSha: TASK_HEAD,
      results: [
        { name: 'SAMPLE-ONLY typecheck', state: 'passed', headSha: TASK_HEAD, detail: 'clean', artifactRef: null },
        // A stale row for another commit: it must never show under this head.
        { name: 'SAMPLE-ONLY stale check', state: 'failed', headSha: OLD_HEAD, detail: 'old', artifactRef: null },
      ],
      truncated: 0,
    },
    diff: {
      headSha: TASK_HEAD,
      summary: 'SAMPLE-ONLY one file changed',
      files: [{ path: 'src/sample.ts', added: 4, removed: 1 }],
      truncated: 0,
    },
    usage: { reportedUsd: 0.12, missingAttempts: 0, mode: 'api' },
  }),
  task_active: taskDetail(tasks.active, 'work_working', 'repo_a', {
    attempts: [
      attempt('attempt_active', 'running', null, { requested: { tier: 'strong', model: 'sample-model-2' } }),
    ],
    coverage: { ...COVERED, usage: false },
  }),
  task_partial: taskDetail(tasks.partial, 'work_working', 'repo_a', {
    coverage: { ...COVERED, checks: false, diff: false, activity: false },
  }),
  task_held: taskDetail(tasks.held, 'work_held', 'repo_a', { coverage: UNCOVERED }),
  task_blocked: taskDetail(tasks.blocked, 'work_blocked', 'repo_a', { coverage: UNCOVERED }),
  task_shipped: taskDetail(tasks.shipped, 'work_done', 'repo_a', {
    attempts: [attempt('attempt_shipped', 'finished', TASK_HEAD, { processOutcome: 'exited' })],
    checks: {
      headSha: TASK_HEAD,
      results: [
        { name: 'SAMPLE-ONLY full suite', state: 'passed', headSha: TASK_HEAD, detail: 'green', artifactRef: null },
      ],
      truncated: 0,
    },
    diff: { headSha: TASK_HEAD, summary: 'SAMPLE-ONLY two files changed', files: [], truncated: 0 },
  }),
} satisfies Record<string, TaskDetail>

const REPORT_BODY = JSON.stringify({
  report: {
    kind: 'completion',
    summary: 'SAMPLE-ONLY done',
    artifacts: [{ kind: 'log', ref: 'out/run.log' }],
  },
})

/** One line of each kind the Activity tab treats differently. */
export const activityItems = {
  tool: {
    seq: 2,
    type: 'tool_call',
    at: '2026-11-05T09:58:00.000Z',
    summary: 'SAMPLE-ONLY Bash',
    detail: '{"tool":"Bash"}',
  },
  report: {
    seq: 5,
    type: 'report',
    at: '2026-11-05T09:59:00.000Z',
    summary: 'completion: SAMPLE-ONLY done',
    detail: REPORT_BODY,
  },
  // The server cuts a long detail, so this body is not JSON any more.
  cutReport: {
    seq: 6,
    type: 'report',
    at: '2026-11-05T09:59:30.000Z',
    summary: 'completion: SAMPLE-ONLY cut',
    detail: '{"report":{"kind":"comple',
  },
} satisfies Record<string, ActivityItem>

export const activityPage = {
  items: [activityItems.tool, activityItems.report],
  nextCursor: 'cursor-activity',
  observedAt: OBSERVED,
} satisfies Page<ActivityItem>

export const artifactPages = {
  text: {
    kind: 'text',
    ref: 'out/run.log',
    text: 'SAMPLE-ONLY log\n',
    size: 1536,
    nextCursor: 'cursor-artifact',
  },
  binary: { kind: 'binary', ref: 'out/image.png', size: 2048 },
} satisfies Record<string, ArtifactPage>

export const needs = {
  question: {
    kind: 'question',
    id: 'question_open',
    ...SAMPLE_A,
    workItemId: 'work_blocked',
    question: 'SAMPLE-ONLY include archived rows?',
    options: ['SAMPLE-ONLY include them', 'SAMPLE-ONLY leave them out'],
    status: 'open',
    askedAt: OBSERVED,
    answer: null,
  },
  answered: {
    kind: 'question',
    id: 'question_answered',
    ...SAMPLE_A,
    workItemId: 'work_working',
    question: 'SAMPLE-ONLY keep the old route?',
    options: [],
    status: 'answered',
    askedAt: OBSERVED,
    answer: 'SAMPLE-ONLY keep it for now',
  },
  pending: {
    kind: 'card',
    id: 'card_pending',
    ...SAMPLE_A,
    workItemId: 'work_working',
    cls: 'push',
    status: 'pending',
    expiresAt: LATER,
    detailPath: '/api/inbox/card_pending/detail',
  },
  otherRepo: {
    kind: 'card',
    id: 'card_other',
    ...SAMPLE_B,
    workItemId: null,
    cls: 'pr_merge',
    status: 'pending',
    expiresAt: LATER,
    detailPath: '/api/inbox/card_other/detail',
  },
  resolved: {
    kind: 'card',
    id: 'card_resolved',
    ...SAMPLE_A,
    workItemId: null,
    cls: 'push',
    status: 'approved',
    expiresAt: OBSERVED,
    detailPath: '/api/inbox/card_resolved/detail',
  },
  expired: {
    kind: 'card',
    id: 'card_expired',
    ...SAMPLE_A,
    workItemId: null,
    cls: 'pr_create',
    status: 'expired',
    expiresAt: OBSERVED,
    detailPath: '/api/inbox/card_expired/detail',
  },
  legacy: {
    kind: 'question',
    id: 'question_legacy',
    repoId: null,
    repoLabel: null,
    workItemId: 'work_legacy',
    question: 'SAMPLE-ONLY keep the old layout?',
    options: [],
    status: 'open',
    askedAt: OBSERVED,
    answer: null,
  },
} satisfies Record<string, NeedItem>

export const needsPage = {
  items: Object.values(needs),
  nextCursor: null,
  observedAt: OBSERVED,
} satisfies Page<NeedItem>

const evidence = (what: string, verb: string, head: string, repo: string): CardEvidence => ({
  what,
  verb,
  why: 'SAMPLE-ONLY this leaves the machine, so it asks you.',
  facts: [
    { label: 'Repository', value: repo, mono: false },
    { label: 'Head', value: head, mono: true },
  ],
  operation: 'op_sample',
  requestedBy: 'SAMPLE-ONLY release agent',
  consequences: { approve: 'SAMPLE-ONLY this commit leaves.', deny: 'SAMPLE-ONLY nothing leaves.' },
  checks: [{ name: 'SAMPLE-ONLY card check', state: 'passed', note: `On ${head.slice(0, 7)}` }],
  diff: { summary: 'SAMPLE-ONLY card diff', files: [{ path: 'src/card.ts', added: 2, removed: 0 }] },
})

export const cardEvidence = {
  card_pending: evidence('SAMPLE-ONLY push search to sample-console', 'push', CARD_HEAD, 'sample-console'),
  card_other: evidence('SAMPLE-ONLY merge pull request 9', 'merge', CARD_HEAD, 'sample-billing'),
  card_resolved: evidence('SAMPLE-ONLY push the theme', 'push', OLD_HEAD, 'sample-console'),
  card_expired: evidence('SAMPLE-ONLY open a pull request', 'open the PR', OLD_HEAD, 'sample-console'),
} satisfies Record<string, CardEvidence>

export const searchPage = {
  items: [
    {
      kind: 'work',
      id: 'work_working',
      title: 'SAMPLE-ONLY search for the console',
      repoLabel: 'sample-console',
      workItemId: 'work_working',
    },
    {
      kind: 'task',
      id: 'task_active',
      title: 'SAMPLE-ONLY build the index',
      repoLabel: 'sample-console',
      workItemId: 'work_working',
    },
    {
      kind: 'message',
      id: 'msg_user',
      title: 'SAMPLE-ONLY add console search',
      repoLabel: 'sample-console',
      workItemId: 'work_working',
    },
    {
      kind: 'reference',
      id: '#12',
      title: 'SAMPLE-ONLY pull request 12',
      repoLabel: 'sample-console',
      workItemId: 'work_done',
    },
  ],
  nextCursor: null,
  observedAt: OBSERVED,
} satisfies Page<SearchHit>

export const chatLines = [
  {
    id: 'msg_user',
    text: 'SAMPLE-ONLY add console search with clear empties',
    createdAt: OBSERVED,
    kind: 'user',
    workItemId: 'work_working',
  },
  {
    id: 'msg_ack',
    text: 'SAMPLE-ONLY on it, I will plan this first',
    createdAt: OBSERVED,
    kind: 'agent',
    workItemId: 'work_working',
  },
  {
    id: 'msg_status',
    text: 'SAMPLE-ONLY the implementer is building the index',
    createdAt: OBSERVED,
    kind: 'status',
    workItemId: 'work_working',
  },
  {
    id: 'msg_tool',
    text: 'SAMPLE-ONLY tool call that stays out of chat',
    createdAt: OBSERVED,
    kind: 'tool',
    workItemId: 'work_working',
  },
] satisfies ChatLine[]

/** The real server's shape: a stored message has no kind, and carries its acknowledgement. */
export const storedLines = [
  {
    id: 'msg_stored',
    text: 'SAMPLE-ONLY a stored request',
    createdAt: OBSERVED,
    workItemId: 'work_working',
    kind: null,
    ackText: 'SAMPLE-ONLY started work_working for you',
  },
  {
    id: 'msg_guarded',
    text: 'SAMPLE-ONLY [redacted]',
    createdAt: OBSERVED,
    workItemId: null,
    kind: null,
    secretGuard: true,
  },
] satisfies ChatLine[]

/** Stored by a wake turn: no kind and no person, with the turn's reason as its text. */
export const wakeLines = [
  {
    id: 'msg_wake_0a1b2c',
    text: 'question answered',
    createdAt: OBSERVED,
    workItemId: 'work_working',
    kind: null,
    ackText: 'SAMPLE-ONLY carrying on with work_working',
  },
  {
    id: 'msg_wake_3d4e5f',
    text: 'question "SAMPLE-ONLY which one?" answered: SAMPLE-ONLY that one',
    createdAt: OBSERVED,
    workItemId: 'work_working',
    kind: null,
  },
  {
    id: 'msg_said',
    text: 'question answered',
    createdAt: OBSERVED,
    workItemId: 'work_working',
    kind: null,
  },
] satisfies ChatLine[]
