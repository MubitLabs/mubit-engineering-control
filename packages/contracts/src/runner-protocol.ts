import { z } from 'zod'

/**
 * Runner protocol, PDF §25. Every event a runner emits is wrapped in this envelope.
 * Control deduplicates on (runnerId, eventId) and enforces an increasing sequence per attempt.
 */
export const RUNNER_PROTOCOL_VERSION = 1

export const RunnerEventEnvelope = z.object({
  schemaVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  eventId: z.string().min(1).max(128),
  runnerId: z.string().min(1).max(128),
  attemptId: z.string().min(1).max(128),
  generation: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  type: z.string().min(1).max(100),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
})
export type RunnerEventEnvelope = z.infer<typeof RunnerEventEnvelope>

/**
 * Event types a runner emits. Lifecycle types drive the attempt state machine on the control
 * side; the rest are evidence (journalled and shown, never trusted to change state).
 */
export const RunnerEventType = {
  // lifecycle
  preparing: 'attempt.preparing',
  started: 'attempt.started',
  inputRequested: 'attempt.input_requested',
  inputResolved: 'attempt.input_resolved',
  finished: 'attempt.finished',
  checksStarted: 'attempt.checks_started',
  checksCompleted: 'attempt.checks_completed',
  interrupted: 'attempt.interrupted',
  quotaExhausted: 'attempt.quota_exhausted',
  authRequired: 'attempt.auth_required',
  failed: 'attempt.failed',
  cancelled: 'attempt.cancelled',
  // evidence
  agentMessage: 'agent.message',
  agentToolUse: 'agent.tool_use',
  agentToolResult: 'agent.tool_result',
  agentUsage: 'agent.usage',
  agentLog: 'agent.log',
  workspaceReady: 'workspace.ready',
  workspaceDiff: 'workspace.diff',
  checkResult: 'check.result',
  messageDelivered: 'message.delivered',
} as const
export type RunnerEventType = (typeof RunnerEventType)[keyof typeof RunnerEventType]

/** 'none' marks runner-native work (integration merges) that starts no agent. */
export const AgentKind = z.enum(['fake', 'claude-code', 'none'])
export type AgentKind = z.infer<typeof AgentKind>

/** Capabilities are advertised separately; absence means "unsupported", never assumed (PDF §7). */
export const AgentCapability = z.enum([
  'structured_stream',
  'native_terminal',
  'questions',
  'tool_approval',
  'interrupt',
  'native_resume',
  'usage',
  'session_fork',
])
export type AgentCapability = z.infer<typeof AgentCapability>

export const AgentProbe = z.object({
  kind: AgentKind,
  version: z.string().nullable(),
  available: z.boolean(),
  auth: z.enum(['ok', 'required', 'unknown']),
  capabilities: z.array(AgentCapability),
  notes: z.array(z.string()).default([]),
})
export type AgentProbe = z.infer<typeof AgentProbe>

// ── Commands (control → runner) ─────────────────────────────────────────────────────────────

export const CommandType = z.enum([
  'start',
  'interrupt',
  'resume',
  'cancel',
  'message',
  'resolve_decision',
  'probe',
])
export type CommandType = z.infer<typeof CommandType>

export const RunnerCommand = z.object({
  /** Idempotency key: a runner executes each commandId at most once. */
  commandId: z.string().min(1).max(200),
  type: CommandType,
  attemptId: z.string().nullable(),
  generation: z.number().int().nonnegative().nullable(),
  payload: z.record(z.string(), z.unknown()),
})
export type RunnerCommand = z.infer<typeof RunnerCommand>

export const AttemptReport = z.object({
  attemptId: z.string(),
  generation: z.number().int().nonnegative(),
  /** 'live' while the supervised process runs; 'stopped' once its process group has exited. */
  process: z.enum(['live', 'stopped']),
  lastSequence: z.number().int(),
})
export type AttemptReport = z.infer<typeof AttemptReport>

// ── Messages on the WebSocket ───────────────────────────────────────────────────────────────

export const RunnerHello = z.object({
  type: z.literal('hello'),
  protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  runnerVersion: z.string(),
  hostname: z.string(),
  os: z.string(),
  arch: z.string(),
  capacity: z.object({
    maxAttempts: z.number().int().positive(),
    cpus: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
    diskFreeMb: z.number().int().nonnegative().nullable(),
  }),
  agents: z.array(AgentProbe),
  attempts: z.array(AttemptReport),
})
export type RunnerHello = z.infer<typeof RunnerHello>

export const RunnerToControl = z.discriminatedUnion('type', [
  RunnerHello,
  z.object({ type: z.literal('event'), event: RunnerEventEnvelope }),
  z.object({
    type: z.literal('command_result'),
    commandId: z.string(),
    status: z.enum(['accepted', 'duplicate', 'rejected']),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('heartbeat'),
    attempts: z.array(AttemptReport),
    /** Refreshed agent probes, sent every few minutes so auth expiry is noticed. */
    agents: z.array(AgentProbe).optional(),
  }),
])
export type RunnerToControl = z.infer<typeof RunnerToControl>

export const ControlToRunner = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    runnerId: z.string(),
    serverTime: z.string(),
    /** Highest sequence persisted per attempt; the runner replays everything after it. */
    acked: z.record(z.string(), z.number().int()),
  }),
  z.object({
    type: z.literal('ack'),
    attemptId: z.string(),
    sequence: z.number().int(),
    eventId: z.string(),
  }),
  z.object({ type: z.literal('command'), command: RunnerCommand }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])
export type ControlToRunner = z.infer<typeof ControlToRunner>

// ── Enrolment (HTTP) ────────────────────────────────────────────────────────────────────────

export const EnrolRequest = z.object({
  inviteToken: z.string().min(10).max(200),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  hostname: z.string().max(255),
  os: z.string().max(100),
  arch: z.string().max(50),
})
export type EnrolRequest = z.infer<typeof EnrolRequest>

export const EnrolResponse = z.object({ runnerId: z.string(), token: z.string() })
export type EnrolResponse = z.infer<typeof EnrolResponse>

/** Scripted steps for the fake agent (deterministic tests and demos). */
export const FakeStep = z.union([
  z.object({ say: z.string() }),
  z.object({ sleepMs: z.number().int().min(0).max(600_000) }),
  z.object({ write: z.object({ path: z.string(), content: z.string() }) }),
  z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ ask: z.string(), options: z.array(z.string()).optional() }),
  z.object({ requestApproval: z.string(), command: z.string() }),
  z.object({ fail: z.string() }),
  /** A scoped call to control (e.g. propose_tasks); the reply is printed as a message. */
  z.object({ call: z.string(), params: z.record(z.string(), z.unknown()) }),
  z.object({ exit: z.enum(['quota', 'auth']) }),
])
export type FakeStep = z.infer<typeof FakeStep>

/** What a runner needs to prepare and verify an attempt (sent with `start`). */
export const StartPayload = z.object({
  agentKind: AgentKind,
  kind: z.enum(['implement', 'repair', 'coordinator', 'integration']),
  taskKey: z.string(),
  taskTitle: z.string(),
  spec: z.record(z.string(), z.unknown()),
  inputs: z.record(z.string(), z.unknown()).default({}),
  repository: z.object({ name: z.string(), cloneUrl: z.string() }).nullable().default(null),
  /** Pinned commit to start from; when null the runner resolves `baseRef` and reports the SHA. */
  baseSha: z.string().nullable().default(null),
  baseRef: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  /** Diff against this commit instead of the start point (repairs continue from earlier work). */
  diffBaseSha: z.string().nullable().default(null),
  /** Integration runs: merge these accepted commits, in order, into the integration branch. */
  integration: z
    .object({
      merges: z.array(
        z.object({ taskId: z.string(), taskKey: z.string(), sha: z.string(), branch: z.string().nullable() }),
      ),
    })
    .nullable()
    .default(null),
  bootstrap: z
    .array(z.object({ name: z.string(), argv: z.array(z.string()), timeoutSec: z.number() }))
    .default([]),
  checks: z
    .array(z.object({ name: z.string(), argv: z.array(z.string()), timeoutSec: z.number() }))
    .default([]),
})
export type StartPayload = z.infer<typeof StartPayload>
